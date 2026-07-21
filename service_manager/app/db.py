"""Portal DB engine + session (single SQLite file under `data/_portal/`)."""
from __future__ import annotations

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import Session, sessionmaker

from . import config
from .models import Base

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
    with engine.begin() as conn:
        conn.execute(text(
            "UPDATE users SET email_verified_at = COALESCE(email_verified_at, created_at) "
            "WHERE email_verified = 1 AND email_verified_at IS NULL"))


_migrate()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
