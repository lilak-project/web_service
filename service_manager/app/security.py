"""
Password hashing + JWT — intentionally self-contained and elog-compatible.

The token scheme (HS256, `sub`/`username`/`role`/`exp` claims, same SECRET_KEY)
is identical to elog's `auth.create_access_token`, so a portal token is accepted
by any managed elog backend. Swap `hash_password`/`verify_password` for
bcrypt/argon2 in production — nothing else changes.
"""
from __future__ import annotations

import base64
import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

import bcrypt
from jose import JWTError, jwt

from . import config

ALGORITHM = "HS256"


# ── Password hashing (bcrypt) ────────────────────────────────────────────────
# New hashes use bcrypt (slow, salted, industry standard). Old `sha256:salt:digest`
# hashes still VERIFY, and are transparently upgraded to bcrypt on next login
# (see `needs_rehash` + the login route), so existing accounts keep working.
#
# bcrypt truncates the password at 72 bytes and chokes on NUL bytes, so we first
# fold any-length input into a fixed 44-byte base64(sha256) digest before bcrypt —
# the standard "bcrypt-sha256" construction.
def _prehash(password: str) -> bytes:
    return base64.b64encode(hashlib.sha256(password.encode("utf-8")).digest())


def hash_password(password: str) -> str:
    return bcrypt.hashpw(_prehash(password), bcrypt.gensalt()).decode("ascii")


def verify_password(plain: str, stored: str) -> bool:
    try:
        if stored.startswith("$2"):                      # bcrypt ($2a/$2b/$2y$…)
            return bcrypt.checkpw(_prehash(plain), stored.encode("ascii"))
        scheme, salt, digest = stored.split(":", 2)      # legacy sha256:salt:digest
        if scheme == "sha256":
            computed = hashlib.sha256(f"{salt}:{plain}".encode()).hexdigest()
            return secrets.compare_digest(computed, digest)
    except Exception:
        pass
    return False


def needs_rehash(stored: str) -> bool:
    """True if the stored hash is a legacy (non-bcrypt) format and should be
    re-hashed with bcrypt on the next successful login."""
    return not (stored or "").startswith("$2")


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
