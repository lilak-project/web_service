"""Portal DB engine + session (single SQLite file under `data/_portal/`)."""
from __future__ import annotations

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import Session, sessionmaker

from . import config
from .models import Base

config.ensure_dirs()

engine = create_engine(
    f"sqlite:///{config.PORTAL_DB}",
    connect_args={"check_same_thread": False},
)
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
    if "portal_invite_codes" in names:
        add_missing("portal_invite_codes", {
            "kind": "ALTER TABLE portal_invite_codes ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'project'",
            "group_id": "ALTER TABLE portal_invite_codes ADD COLUMN group_id INTEGER",
            "max_uses": "ALTER TABLE portal_invite_codes ADD COLUMN max_uses INTEGER NOT NULL DEFAULT 0",
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
