"""Shared portal SSO for LILAK managed services (identity-only, no local user DB).

ONE copy of what every service backend used to paste into its own `portal_auth.py`:
  • HS256 token verification with the portal's secret precedence,
  • bearer/cookie extraction,
  • the FastAPI `identity` dependency, and
  • the cached `/api/introspect` client that freshens a token's live role/profile.

Every managed service imports this instead of carrying a near-identical copy, so a
fix (secret handling, `aud`/`iss` checks, the introspect client, …) lands in one
place. Services run on the shared portal venv, so this is importable wherever a
service is spawned. The portal side is service_manager/app/routers/accounts.py
(the /api/introspect endpoint).
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional

from fastapi import Header, Request
from jose import jwt

# Secret precedence matches the portal (service_manager/app/config.py) and elog:
# PORTAL_SECRET_KEY, then ELOG_SECRET_KEY, then the shared dev default.
SECRET_KEY = (
    os.environ.get("PORTAL_SECRET_KEY")
    or os.environ.get("ELOG_SECRET_KEY")
    or "lilak-dev-secret-CHANGE-in-production"
)
ALGORITHM = "HS256"
MANAGER_COLOR = os.environ.get("MANAGER_COLOR", "#111827")

# The portal injects PORTAL_PORT/PORTAL_DATA_ROOT into every spawned service, so the
# introspect client and the account listing can reach the portal at loopback / read
# its DB. Both degrade gracefully (fall back to the token) when absent.
_PORTAL_PORT = os.environ.get("PORTAL_PORT")
_INTROSPECT_TTL = 20                            # seconds; caps portal calls per token
_introspect_cache: dict = {}                    # token -> (expiry_monotonic, fresh dict)


def decode_token(token: str) -> Optional[dict]:
    """Verify + decode a portal HS256 JWT. None on any problem (bad sig/expiry)."""
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except Exception:
        return None


def bearer_from_request(authorization: Optional[str], request: Request) -> Optional[str]:
    """The token from the Authorization header, or — for a top-level navigation that
    carries no header — the portal cookie the frontend set."""
    if authorization and authorization.startswith("Bearer "):
        return authorization[7:]
    return request.cookies.get("lilak_portal_token") or request.cookies.get("elog_token")


def introspect(token: Optional[str]) -> Optional[dict]:
    """LIVE profile for a token via the portal's /api/introspect, cached briefly so
    it isn't a network call every request. None if there's no token/port or the
    portal is unreachable — callers then fall back to the token claims."""
    if not token or not _PORTAL_PORT:
        return None
    now = time.monotonic()
    hit = _introspect_cache.get(token)
    if hit and hit[0] > now:
        return hit[1]
    try:
        req = urllib.request.Request(
            f"http://127.0.0.1:{_PORTAL_PORT}/api/introspect",
            headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=2) as r:
            fresh = json.loads(r.read())
    except Exception:
        return None
    if len(_introspect_cache) > 512:            # bound the map (tokens rotate daily)
        for k, (exp, _) in list(_introspect_cache.items()):
            if exp <= now:
                _introspect_cache.pop(k, None)
    _introspect_cache[token] = (now + _INTROSPECT_TTL, fresh)
    return fresh


def fresh_payload(payload: dict, token: Optional[str] = None) -> dict:
    """Token claims overlaid with the live portal profile (role/name/avatar), so a
    portal role change or profile edit is reflected without a re-login. Falls back to
    the raw claims when the portal is unreachable."""
    out = dict(payload or {})
    fresh = introspect(token)
    if not fresh:
        return out
    role = fresh.get("role") or fresh.get("prole") or out.get("prole") or out.get("role") or "user"
    out.update({
        "username": fresh.get("username") or out.get("username"),
        "email": fresh.get("email") or out.get("email"),
        "name": fresh.get("name") or out.get("name"),
        "role": role,
        "prole": role,
        "color": fresh.get("color") or "",
        "shape": fresh.get("shape") or "",
    })
    return out


def identity(request: Request, authorization: Optional[str] = Header(default=None)) -> dict:
    """Soft identity dependency: a profile dict for the caller (anonymous when there's
    no valid token) rather than raising — entry is already gated by the portal proxy.
    Freshened via /api/introspect so role/avatar track the portal live."""
    token = bearer_from_request(authorization, request)
    payload = decode_token(token) if token else None
    if not payload:
        return {"authenticated": False, "email": None, "username": None,
                "name": None, "role": None, "color": None, "shape": None}
    payload = fresh_payload(payload, token)
    return {
        "authenticated": True,
        "email": payload.get("email"),
        "username": payload.get("username") or payload.get("name"),
        "name": payload.get("name") or payload.get("username"),
        "role": payload.get("prole") or payload.get("role"),
        "color": payload.get("color"),
        "shape": payload.get("shape"),
    }


def _portal_db_path() -> Path:
    root = Path(os.environ.get("PORTAL_DATA_ROOT", "/app/data"))
    return root / "_portal" / "portal.db"


def list_accounts() -> list[dict]:
    """All active portal accounts as [{email, username, display_name}] — lets a
    service map a workspace key (derived from email) back to a human identity. Reads
    the portal DB read-only; returns [] if it's unavailable."""
    db = _portal_db_path()
    if not db.is_file():
        return []
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=2)
        con.row_factory = sqlite3.Row
        try:
            rows = con.execute(
                "SELECT email, username, display_name FROM users WHERE is_active=1"
            ).fetchall()
            return [{"email": r["email"], "username": r["username"],
                     "display_name": r["display_name"]} for r in rows]
        finally:
            con.close()
    except Exception:
        return []


__all__ = [
    "SECRET_KEY", "ALGORITHM", "MANAGER_COLOR",
    "decode_token", "bearer_from_request", "introspect", "fresh_payload",
    "identity", "list_accounts",
]
