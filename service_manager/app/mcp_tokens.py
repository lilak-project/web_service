"""Tokens for /mcp, issued from the machine's own shell until there is a screen.

    python -m app.mcp_tokens new laptop --user admin [--read-only] [--days 180] [--scope note,authors/authors]
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


def expand(scope: str) -> list:
    """A scope's parts, `set:NAME` written out as that share set's `svc/proj` members."""
    from . import registry
    sets = None
    out = []
    for p in (x.strip() for x in (scope or "").split(",")):
        if p.startswith("set:"):
            sets = sets if sets is not None else registry.share_sets()[0]
            hit = _set(sets, p[4:])
            # A set that is gone opens nothing (not everything): a placeholder no service has.
            out += [f"{s}/{q}" for s, q in (hit or {}).get("members", {}).items()] or [f"{p}/-"]
        elif p:
            out.append(p)
    return out


def _set(sets: list, key: str):
    """A share set by its id (what a token is bound to: it survives a rename), else by its name."""
    return next((s for s in sets if s.get("id") == key), None) or next((s for s in sets if s.get("name") == key), None)


def home(scope: str) -> dict:
    """{service: project} a tool goes to when no project is given: the first share set a scope names, then any one project it names."""
    from . import registry
    key = next((p.strip()[4:] for p in (scope or "").split(",") if p.strip().startswith("set:")), "")
    hit = _set(registry.share_sets()[0], key) if key else None
    out = dict((hit or {}).get("members") or {})
    # A scope that names one project of a service (`note/notes-job`, an agent run's token) goes there
    # by default too: the service's main project would be outside what the token may touch.
    for p in (x.strip() for x in (scope or "").split(",")):
        svc, sep, proj = p.partition("/")
        if sep and proj and not p.startswith("set:"):
            out.setdefault(svc, proj)
    return out


def allowed(scope: str, svc: str, proj: str = "") -> bool:
    """Is this service (and project, when one is named) inside a token's scope?
    Empty scope: all of it. `svc` covers its every project, `svc/proj` that one,
    `set:NAME` the projects of that share set. With no project named, any grant
    within the service will do."""
    parts = expand(scope)
    if not parts or svc in parts:
        return True
    return f"{svc}/{proj}" in parts if proj else any(p.startswith(f"{svc}/") for p in parts)


def bind_sets(scope: str) -> str:
    """`set:NAME` in a scope written as `set:<the set's id>`, so a rename does not unbind
    the token. A set saved before ids existed gets one now. Unknown names: refused."""
    from . import registry
    parts = [p.strip() for p in (scope or "").split(",") if p.strip()]
    if not any(p.startswith("set:") for p in parts):
        return ",".join(parts)
    sets, stored = registry.share_sets()
    if not stored or any(not s.get("id") for s in sets):
        registry.write_share_sets(sets)
        sets, _ = registry.share_sets()
    out = []
    for p in parts:
        if p.startswith("set:"):
            hit = _set(sets, p[4:])
            if not hit:
                raise ValueError(f"'{p[4:]}' 세트가 없습니다")
            p = f"set:{hit['id']}"
        out.append(p)
    return ",".join(out)


def label(scope: str) -> str:
    """A scope as a person reads it: a set by its name now."""
    from . import registry
    sets = registry.share_sets()[0]
    return ",".join(f"set:{(_set(sets, p[4:]) or {}).get('name') or p[4:] + '(없음)'}" if p.startswith("set:") else p
                    for p in (x.strip() for x in (scope or "").split(",")) if p)


def issue(db, name: str, user: models.User, can_write: bool, days: int, scope: str = "") -> str:
    scope = bind_sets(scope)
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
            try:
                print(issue(db, a.name, user, not a.read_only, a.days, a.scope))
            except ValueError as e:
                print(e, file=sys.stderr)
                return 1
        elif a.cmd == "list":
            for r in db.query(models.McpToken).order_by(models.McpToken.id):
                state = "revoked" if r.revoked_at else f"until {r.expires_at:%Y-%m-%d}"
                print(r.id, r.name, f"user#{r.user_id}", "write" if r.can_write else "read", label(r.scope) or "all", state,
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
