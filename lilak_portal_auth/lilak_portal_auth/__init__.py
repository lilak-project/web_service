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

from fastapi import Depends, Header, HTTPException, Request
from jose import jwt

def _secret_key() -> str:
    """The key the portal signs tokens with, found the way the portal
    (service_manager/app/config.py) and elog find it: an explicit variable,
    else the data root's _portal/secret.key — which the portal creates and every
    service it starts can read (it is handed PORTAL_DATA_ROOT). Without the file
    a service under a portal that keeps its key there knew no key but the dev
    default, so it read every login as anonymous. The dev default is left only
    for a service run on its own, with no portal around."""
    for var in ("PORTAL_SECRET_KEY", "ELOG_SECRET_KEY"):
        if os.environ.get(var):
            return os.environ[var]
    root = os.environ.get("PORTAL_DATA_ROOT")
    path = os.environ.get("PORTAL_SECRET_FILE") or (os.path.join(root, "_portal", "secret.key") if root else "")
    try:
        if path and os.path.exists(path):
            val = open(path, encoding="utf-8").read().strip()
            if val:
                return val
    except OSError:
        pass
    return "lilak-dev-secret-CHANGE-in-production"


SECRET_KEY = _secret_key()
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
    except urllib.error.HTTPError as e:
        # The portal refused the token: signed out everywhere, deactivated or
        # deleted. That is an answer, not an outage — the caller is nobody.
        if e.code not in (401, 403):
            return None
        fresh = {"revoked": True}
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
    if fresh.get("revoked"):
        return {}
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
    no valid token) rather than raising. For whoami-style reads only — the portal
    proxy passes some callers through unchecked (service-to-service bearers), so
    anything that reads or writes data depends on `signed_in` or `manager`.
    Freshened via /api/introspect so role/avatar track the portal live."""
    token = bearer_from_request(authorization, request)
    payload = decode_token(token) if token else None
    if not payload:
        # A stale header beside a good cookie (a service page left open across a
        # new sign-in) is the cookie's session, not nobody's.
        token = request.cookies.get("lilak_portal_token")
        payload = decode_token(token) if token else None
    # A delegated token (scope, from the portal's /api/delegate) is good only in the
    # service it names — not here when it was minted for another one.
    here, proj = os.environ.get("PORTAL_SERVICE"), os.environ.get("PORTAL_PROJECT")
    if payload and payload.get("scope"):
        s_svc, _, s_proj = payload["scope"].partition("/")
        if (here and s_svc != here) or (proj and s_proj and s_proj != proj):
            payload = None
    if not payload:
        return {"authenticated": False, "email": None, "username": None,
                "name": None, "role": None, "color": None, "shape": None}
    via = payload.get("via")
    payload = fresh_payload(payload, token) if payload else None
    if not payload:
        return {"authenticated": False, "email": None, "username": None,
                "name": None, "role": None, "color": None, "shape": None}
    return {
        "authenticated": True,
        "email": payload.get("email"),
        "username": payload.get("username") or payload.get("name"),
        "name": payload.get("name") or payload.get("username"),
        "role": payload.get("prole") or payload.get("role"),
        "color": payload.get("color"),
        "shape": payload.get("shape"),
        # the service that wrote here for the person, when a delegated token came in
        "via": via,
    }



def signed_in(me: dict = Depends(identity)) -> dict:
    """identity, refusing anyone without a valid, unrevoked portal token."""
    if not me.get("authenticated"):
        raise HTTPException(401, "로그인이 필요합니다.")
    return me


def is_manager(me: dict) -> bool:
    return (me.get("role") or "").lower() in ("manager", "admin")


def manager(me: dict = Depends(signed_in)) -> dict:
    """signed_in, and a portal manager."""
    if not is_manager(me):
        raise HTTPException(403, "관리자만 할 수 있습니다.")
    return me


def delegate(person_auth: str, to: str, minutes: int = 5) -> str:
    """'Bearer <token>' good only in `to` ("svc/proj"), for a few minutes, saying this
    service asked — what a service uses to write in ANOTHER service for the person
    (web_service/CLAUDE.md: never pass the person's own token on). `person_auth` is
    the caller's Authorization header. Raises PermissionError with the portal's reason."""
    req = urllib.request.Request(
        f"http://127.0.0.1:{_PORTAL_PORT or '8025'}/api/delegate", method="POST",
        data=json.dumps({"to": to, "minutes": minutes}).encode(),
        headers={"Authorization": person_auth, "Content-Type": "application/json",
                 "X-Portal-Service": os.environ.get("PORTAL_SERVICE", ""),
                 "X-Portal-Service-Key": os.environ.get("PORTAL_SERVICE_KEY", "")})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return "Bearer " + json.loads(r.read())["token"]
    except urllib.error.HTTPError as e:
        try:
            said = json.loads(e.read()).get("detail")
        except Exception:                      # noqa: BLE001
            said = None
        raise PermissionError(said or f"delegate {to} → {e.code}") from None


_reach_cache: dict = {}                         # real path -> (expiry_monotonic, {status, comments})
_REACH_TTL = 10


def reach(path, why: str = "") -> bool:
    """May this service use `path`, a host path outside the portal's data folder? (reach_status says why not.)"""
    return reach_status(path, why) == "approved"


def reach_status(path, why: str = "") -> str:
    return reach_info(path, why)["status"]


def reach_info(path, why: str = "", again: bool = False) -> dict:
    """{status, comments} for one host path this service wants to use. `comments` is what the
    portal's manager said when putting the request on hold ([{by, via, at, text}]); `again=True`
    asks anew after that (a changed reason, a narrower need), and a held request waits again.

    status: "approved", "waiting" (asked, no manager has answered), "held" (a manager answered with
    an opinion instead of yes or no: read `comments`), "blocked", "outside" (not in the home
    folder: no request is made for it, a manager adds such a path by hand), or "unreachable" (the
    portal did not answer: treated as a no) — for one host path this service wants to use.

    Anything under PORTAL_DATA_ROOT is the portal's own and always yes. For the rest the portal
    decides (POST /api/reach/check, shown this service's PORTAL_SERVICE_KEY): its manager approves
    paths per service on the account menu's Outside paths page, and a path asked for the first
    time waits there. Answers are kept a few seconds. A service run on its own (no portal) is
    not asked; a portal that cannot be reached is a no."""
    real = os.path.realpath(os.path.expanduser(str(path)))
    root = os.environ.get("PORTAL_DATA_ROOT")
    if root and (real == os.path.realpath(root) or real.startswith(os.path.realpath(root).rstrip("/") + "/")):
        return {"status": "approved", "comments": []}
    if not (_PORTAL_PORT and os.environ.get("PORTAL_SERVICE_KEY")):
        return {"status": "approved", "comments": []}
    now = time.monotonic()
    hit = _reach_cache.get(real)
    if hit and hit[0] > now and not again:
        return hit[1]
    req = urllib.request.Request(
        f"http://127.0.0.1:{_PORTAL_PORT}/api/reach/check", method="POST",
        data=json.dumps({"path": real, "why": why, "again": bool(again)}).encode(),
        headers={"Content-Type": "application/json",
                 "X-Portal-Service": os.environ.get("PORTAL_SERVICE", ""),
                 "X-Portal-Service-Key": os.environ.get("PORTAL_SERVICE_KEY", "")})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            got = json.loads(r.read())
            ok = {"status": "approved" if got.get("allowed") else (got.get("status") or "blocked"),
                  "comments": got.get("comments") or []}
    except Exception:                          # noqa: BLE001 — unreachable or refused: not allowed
        ok = {"status": "unreachable", "comments": []}
    if len(_reach_cache) > 512:
        _reach_cache.clear()
    _reach_cache[real] = (now + _REACH_TTL, ok)
    return ok


def require_reach(path, why: str = "") -> None:
    """reach(), refusing with what to do about it."""
    if not reach(path, why):
        raise HTTPException(403, f"이 경로는 포털에서 승인되지 않았습니다: {path} — 매니저가 계정 메뉴의 "
                                 "'바깥 경로'에서 승인하면 쓸 수 있습니다.")


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
    "identity", "list_accounts", "delegate", "reach", "reach_status", "reach_info", "require_reach",
]
