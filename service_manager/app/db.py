"""Portal DB engine + session (single SQLite file under `data/_portal/`)."""
from __future__ import annotations

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import Session, sessionmaker

from . import config
from .models import Base, User

config.ensure_dirs()

engine = create_engine(
    f"sqlite:///{config.PORTAL_DB}",
    connect_args={"check_same_thread": False},
)


@event.listens_for(engine, "connect")
def _sqlite_pragmas(dbapi_conn, _rec):
    """Tune every SQLite connection. The portal reads on EVERY proxied request (the
    auth guard) while admin endpoints write from many threads, and elog opens the
    same file from a separate process — with the default rollback journal + 5 s
    busy timeout that surfaces as `database is locked` 500s. WAL lets readers and a
    writer coexist; busy_timeout makes a contended write wait instead of failing."""
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA synchronous=NORMAL")
    cur.execute("PRAGMA busy_timeout=10000")
    cur.execute("PRAGMA foreign_keys=ON")
    cur.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)

Base.metadata.create_all(bind=engine)


def _migrate() -> None:
    """Add columns introduced after a DB was first created (SQLite create_all
    won't alter existing tables). Idempotent; safe on every startup."""
    insp = inspect(engine)
    names = insp.get_table_names()
    if "users" not in names:
        return

    def add_missing(table: str, adds: dict) -> None:
        cols = {c["name"] for c in insp.get_columns(table)}
        with engine.begin() as conn:
            for col, ddl in adds.items():
                if col not in cols:
                    conn.execute(text(ddl))

    add_missing("users", {
        "email_verified": "ALTER TABLE users ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT 0",
        "verify_token": "ALTER TABLE users ADD COLUMN verify_token VARCHAR(64)",
        "email_verified_at": "ALTER TABLE users ADD COLUMN email_verified_at DATETIME",
        "pending_email": "ALTER TABLE users ADD COLUMN pending_email VARCHAR(256)",
    })
    add_missing("portal_permissions", {
        "project": "ALTER TABLE portal_permissions ADD COLUMN project VARCHAR(128) NOT NULL DEFAULT ''",
        "is_admin": "ALTER TABLE portal_permissions ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT 0",
    })
    _per_project_unique()
    if "portal_access_requests" in names:
        add_missing("portal_access_requests", {
            "project": "ALTER TABLE portal_access_requests ADD COLUMN project VARCHAR(128) NOT NULL DEFAULT ''",
        })
    if "portal_groups" in names:
        add_missing("portal_groups", {
            "icon": "ALTER TABLE portal_groups ADD COLUMN icon VARCHAR(64)",
            "color": "ALTER TABLE portal_groups ADD COLUMN color VARCHAR(16)",
        })
    if "portal_group_permissions" in names:
        add_missing("portal_group_permissions", {
            "is_admin": "ALTER TABLE portal_group_permissions ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT 0",
        })
    if "portal_invite_codes" in names:
        add_missing("portal_invite_codes", {
            "kind": "ALTER TABLE portal_invite_codes ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'project'",
            "group_id": "ALTER TABLE portal_invite_codes ADD COLUMN group_id INTEGER",
            "max_uses": "ALTER TABLE portal_invite_codes ADD COLUMN max_uses INTEGER NOT NULL DEFAULT 0",
            "no_verify": "ALTER TABLE portal_invite_codes ADD COLUMN no_verify BOOLEAN NOT NULL DEFAULT 0",
        })
    # Backfill: existing verified accounts get a verified_at so they aren't
    # instantly treated as "expired" by the annual check.
    if "portal_mcp_tokens" in names:
        add_missing("portal_mcp_tokens", {
            "scope": "ALTER TABLE portal_mcp_tokens ADD COLUMN scope VARCHAR(512) NOT NULL DEFAULT ''",
        })

    if "portal_reports" in names:
        add_missing("portal_reports", {
            "attachments_json": "ALTER TABLE portal_reports ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'",
            "ext_id": "ALTER TABLE portal_reports ADD COLUMN ext_id VARCHAR(64)",
            "ext_state": "ALTER TABLE portal_reports ADD COLUMN ext_state VARCHAR(16)",
            "author": "ALTER TABLE portal_reports ADD COLUMN author VARCHAR(80) NOT NULL DEFAULT ''",
            "origin": "ALTER TABLE portal_reports ADD COLUMN origin VARCHAR(80) NOT NULL DEFAULT ''",
            "origin_id": "ALTER TABLE portal_reports ADD COLUMN origin_id INTEGER",
        })
        with engine.begin() as conn:            # the single admin reply becomes the thread's first comment
            conn.execute(text(
                "INSERT INTO portal_report_comments (report_id, author, origin, body, created_at) "
                "SELECT id, '관리자', '', reply, COALESCE(updated_at, created_at) FROM portal_reports "
                "WHERE reply IS NOT NULL AND reply != ''"))
            conn.execute(text("UPDATE portal_reports SET reply = NULL WHERE reply IS NOT NULL"))

    if "portal_chat_messages" in names:
        add_missing("portal_chat_messages", {
            "mentions_json": "ALTER TABLE portal_chat_messages ADD COLUMN mentions_json TEXT NOT NULL DEFAULT '[]'",
            "via": "ALTER TABLE portal_chat_messages ADD COLUMN via VARCHAR(64) NOT NULL DEFAULT ''",
        })

    with engine.begin() as conn:
        conn.execute(text(
            "UPDATE users SET email_verified_at = COALESCE(email_verified_at, created_at) "
            "WHERE email_verified = 1 AND email_verified_at IS NULL"))


def _per_project_unique() -> None:
    """A grant is one per (user, service, PROJECT). A DB made before projects had
    grants still carries UNIQUE (user_id, service_name): a whole-service grant then
    blocks every project grant for the same person (500 on POST /admin/permissions).
    SQLite cannot drop a constraint, so the table is rebuilt once, rows kept."""
    with engine.begin() as conn:
        sql = conn.execute(text(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='portal_permissions'")).scalar() or ""
        if "uq_user_service_project" in sql or "UNIQUE (user_id, service_name)" not in sql:
            return
        conn.execute(text("ALTER TABLE portal_permissions RENAME TO portal_permissions_old"))
        for ix in ("ix_portal_permissions_service_name", "ix_portal_permissions_user_id"):
            conn.execute(text(f"DROP INDEX IF EXISTS {ix}"))
    Base.metadata.tables["portal_permissions"].create(bind=engine)
    with engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO portal_permissions (id, user_id, service_name, project, is_admin) "
            "SELECT id, user_id, service_name, project, is_admin FROM portal_permissions_old"))
        conn.execute(text("DROP TABLE portal_permissions_old"))


# ── an account's id is never used twice ──────────────────────────────────────
# SQLite hands a deleted row's id to the next insert when it was the highest, and
# things are kept BY that id: a passkey, an MCP token, chat lines, agent runs. A
# person who signed up after someone left would have inherited them (their old
# token acting as the newcomer). So: the highest id ever given is remembered
# (portal_settings.user_id_floor), a new account goes above it, and what an
# account signs in with or is granted goes with it when it is deleted.
_FLOOR = "user_id_floor"
_OWNED = ("portal_passkeys", "portal_mcp_tokens", "portal_permissions", "portal_group_members",
          "portal_access_requests")                   # credentials and grants: gone with the account
_KEPT = ("portal_chat_messages", "portal_agent_runs", "portal_reports")   # history: kept, the id retired


def _floor(conn) -> int:
    v = conn.execute(text("SELECT value FROM portal_settings WHERE key = :k"), {"k": _FLOOR}).scalar()
    return int(v or 0)


def _raise_floor(conn, to: int) -> None:
    if to > _floor(conn):
        conn.execute(text("INSERT INTO portal_settings (key, value) VALUES (:k, :v) "
                          "ON CONFLICT(key) DO UPDATE SET value = :v"), {"k": _FLOOR, "v": str(to)})


@event.listens_for(User, "before_insert")
def _fresh_user_id(_mapper, conn, target):
    if target.id is None:
        top = conn.execute(text("SELECT MAX(id) FROM users")).scalar() or 0
        floor = _floor(conn)
        if floor > top:
            target.id = floor + 1


@event.listens_for(User, "after_delete")
def _retire_user_id(_mapper, conn, target):
    _raise_floor(conn, target.id)
    for table in _OWNED:
        conn.execute(text(f"DELETE FROM {table} WHERE user_id = :u"), {"u": target.id})


def _retire_orphans() -> None:
    """Once per start: accounts deleted before this existed left rows behind. Their ids are
    retired, and the credentials and grants no account owns any more are removed."""
    names = set(inspect(engine).get_table_names())
    with engine.begin() as conn:
        for table in _OWNED + _KEPT:
            if table not in names:
                continue
            gone = conn.execute(text(f"SELECT MAX(user_id) FROM {table} "
                                     "WHERE user_id IS NOT NULL AND user_id NOT IN (SELECT id FROM users)")).scalar()
            if gone:
                _raise_floor(conn, int(gone))
                if table in _OWNED:
                    conn.execute(text(f"DELETE FROM {table} WHERE user_id NOT IN (SELECT id FROM users)"))


_migrate()
_retire_orphans()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
