"""
Password hashing + JWT — intentionally self-contained and elog-compatible.

The token scheme (HS256, `sub`/`username`/`role`/`exp` claims, same SECRET_KEY)
is identical to elog's `auth.create_access_token`, so a portal token is accepted
by any managed elog backend. Swap `hash_password`/`verify_password` for
bcrypt/argon2 in production — nothing else changes.
"""
from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from jose import JWTError, jwt

from . import config

ALGORITHM = "HS256"


# ── Password hashing (REPLACE FOR PRODUCTION) ────────────────────────────────
def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.sha256(f"{salt}:{password}".encode()).hexdigest()
    return f"sha256:{salt}:{digest}"


def verify_password(plain: str, stored: str) -> bool:
    try:
        scheme, salt, digest = stored.split(":", 2)
        if scheme == "sha256":
            computed = hashlib.sha256(f"{salt}:{plain}".encode()).hexdigest()
            return secrets.compare_digest(computed, digest)
    except Exception:
        pass
    return False


# ── JWT ──────────────────────────────────────────────────────────────────────
def create_access_token(user_id: int, username: str, role: str,
                        extra: Optional[dict] = None) -> str:
    expire = datetime.now(timezone.utc) + timedelta(hours=config.TOKEN_EXPIRE_HOURS)
    payload = {"sub": str(user_id), "username": username, "role": role, "exp": expire}
    if extra:
        payload.update(extra)
    return jwt.encode(payload, config.SECRET_KEY, algorithm=ALGORITHM)


def decode_access_token(token: str) -> Optional[dict]:
    try:
        return jwt.decode(token, config.SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        return None


def bearer(authorization: Optional[str]) -> Optional[str]:
    if authorization and authorization.startswith("Bearer "):
        return authorization[7:]
    return None
