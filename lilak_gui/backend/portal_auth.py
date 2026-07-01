"""Lightweight portal SSO for lilak_gui.

This service has no user database of its own — it only needs to *identify* the
caller. The portal mints an HS256 JWT (see service_manager) and the proxy forwards
it; here we verify the signature with the shared secret and read the profile claims
(email / username / display name).

Secret precedence matches the portal: PORTAL_SECRET_KEY, then ELOG_SECRET_KEY,
then the dev default — so a portal token Just Works behind the proxy. Uses
python-jose (the lib the portal/elog use; the shared venv ships it, not PyJWT).
"""
from __future__ import annotations

import os
from typing import Optional

from jose import jwt
from fastapi import Header, Request

SECRET_KEY = (
    os.environ.get("PORTAL_SECRET_KEY")
    or os.environ.get("ELOG_SECRET_KEY")
    or "lilak-dev-secret-CHANGE-in-production"
)
ALGORITHM = "HS256"


def decode_token(token: str) -> Optional[dict]:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except Exception:
        return None


def _token_from_request(authorization: Optional[str], request: Request) -> Optional[str]:
    # XHR carries the Bearer header (api.js); a top-level navigation can't, so the
    # proxy also sets the lilak_portal_token cookie — accept either.
    if authorization and authorization.startswith("Bearer "):
        return authorization[7:]
    return request.cookies.get("lilak_portal_token") or request.cookies.get("elog_token")


def identity(
    request: Request,
    authorization: Optional[str] = Header(default=None),
) -> dict:
    """Soft identity dependency: returns a profile dict (anonymous when no valid
    token) rather than raising — entry is already gated by the portal."""
    token = _token_from_request(authorization, request)
    payload = decode_token(token) if token else None
    if not payload:
        return {"authenticated": False, "email": None, "username": None, "name": None}
    return {
        "authenticated": True,
        "email": payload.get("email"),
        "username": payload.get("username") or payload.get("name"),
        "name": payload.get("name") or payload.get("username"),
        "role": payload.get("prole") or payload.get("role"),
    }
