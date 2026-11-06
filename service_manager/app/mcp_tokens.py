"""Tokens for /mcp, issued from the machine's own shell until there is a screen.

    python -m app.mcp_tokens new laptop --user admin [--read-only] [--days 180] [--scope note,author_manager/authors]
    python -m app.mcp_tokens list
    python -m app.mcp_tokens revoke 3

The token is printed once and only its hash is stored. Being able to run this
means already holding the portal's database, so it asks for no password.
"""
import argparse
import hashlib
import secrets
import sys
from datetime import datetime, timedelta, timezone

from . import models
from .db import SessionLocal


def _now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def digest(token: str) -> str:
    # A plain hash is enough: the token is 256 random bits, nothing to guess.
    return hashlib.sha256(token.encode()).hexdigest()


def allowed(scope: str, svc: str, proj: str = "") -> bool:
    """Is this service (and project, when one is named) inside a token's scope?
    Empty scope: all of it. `svc` covers its every project, `svc/proj` that one.
    With no project named, any grant within the service will do."""
    parts = [p.strip() for p in (scope or "").split(",") if p.strip()]
    if not parts or svc in parts:
        return True
    return f"{svc}/{proj}" in parts if proj else any(p.startswith(f"{svc}/") for p in parts)


def issue(db, name: str, user: models.User, can_write: bool, days: int, scope: str = "") -> str:
    token = "lpm_" + secrets.token_urlsafe(32)
    db.add(models.McpToken(name=name, token_hash=digest(token), user_id=user.id, can_write=can_write,
                           scope=scope, expires_at=_now() + timedelta(days=days)))
    db.commit()
    return token


def owner_of(db, token: str):
    """(row, user) of a token that may still be used, else None. Marks it used."""
    row = db.query(models.McpToken).filter(models.McpToken.token_hash == digest(token)).first()
    if not row or row.revoked_at or row.expires_at <= _now():
        return None
    user = db.get(models.User, row.user_id)
    if not user or not user.is_active:
        return None
    row.last_used_at = _now()
    db.commit()
    return row, user


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m app.mcp_tokens")
    sub = ap.add_subparsers(dest="cmd", required=True)
    new = sub.add_parser("new")
    new.add_argument("name")
    new.add_argument("--user", required=True)
    new.add_argument("--read-only", action="store_true")
    new.add_argument("--days", type=int, default=180)
    new.add_argument("--scope", default="")
    sub.add_parser("list")
    sub.add_parser("revoke").add_argument("id", type=int)
    a = ap.parse_args(argv)
    db = SessionLocal()
    try:
        if a.cmd == "new":
            user = db.query(models.User).filter(models.User.username == a.user).first()
            if not user:
                print(f"no account named {a.user}", file=sys.stderr)
                return 1
            print(issue(db, a.name, user, not a.read_only, a.days, a.scope))
        elif a.cmd == "list":
            for r in db.query(models.McpToken).order_by(models.McpToken.id):
                state = "revoked" if r.revoked_at else f"until {r.expires_at:%Y-%m-%d}"
                print(r.id, r.name, f"user#{r.user_id}", "write" if r.can_write else "read", r.scope or "all", state,
                      f"last used {r.last_used_at:%Y-%m-%d %H:%M}" if r.last_used_at else "never used")
        else:
            row = db.get(models.McpToken, a.id)
            if not row:
                print(f"no token {a.id}", file=sys.stderr)
                return 1
            row.revoked_at = _now()
            db.commit()
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
