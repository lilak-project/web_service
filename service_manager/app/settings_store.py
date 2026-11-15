"""Runtime-editable portal settings (a thin key/value layer over `portal_settings`).

Only the managed-service port window lives here today. Values are read live on
each access, so an admin edit in the manage UI takes effect immediately — no
restart. Every key falls back to its `config` default when unset, so a fresh DB
behaves exactly as the hardcoded defaults did.
"""
from __future__ import annotations

from . import config, models
from .db import SessionLocal

# Sanity bounds for the port window (loopback ports inside the container).
PORT_MIN = 1024
PORT_MAX = 65535
MAX_SLOTS = 500   # guard against a typo claiming thousands of ports


def get(key: str) -> str | None:
    with SessionLocal() as db:
        row = db.query(models.Setting).filter(models.Setting.key == key).first()
        return row.value if row else None


def set(key: str, value: str) -> None:
    with SessionLocal() as db:
        row = db.query(models.Setting).filter(models.Setting.key == key).first()
        if row:
            row.value = value
        else:
            db.add(models.Setting(key=key, value=value))
        db.commit()


def _int(key: str, default: int) -> int:
    raw = get(key)
    if raw is None:
        return default
    try:
        return int(raw)
    except (TypeError, ValueError):
        return default


def port_range() -> tuple[int, int]:
    """Effective (start, end) for the managed-service port pool. DB overrides win
    over config defaults; a broken/absent value falls back to the config default."""
    return (_int("service_port_start", config.SERVICE_PORT_START),
            _int("service_port_end", config.SERVICE_PORT_END))


def set_port_range(start: int, end: int) -> tuple[int, int]:
    """Validate and persist the port window. Raises ValueError on bad input."""
    start, end = int(start), int(end)
    if not (PORT_MIN <= start <= PORT_MAX) or not (PORT_MIN <= end <= PORT_MAX):
        raise ValueError(f"포트는 {PORT_MIN}–{PORT_MAX} 범위여야 합니다.")
    if end < start:
        raise ValueError("끝 포트가 시작 포트보다 작습니다.")
    if (end - start + 1) > MAX_SLOTS:
        raise ValueError(f"슬롯 수가 너무 많습니다 (최대 {MAX_SLOTS}).")
    if start <= config.PORTAL_PORT <= end:
        raise ValueError(f"포탈 포트({config.PORTAL_PORT})가 범위에 포함되면 안 됩니다.")
    set("service_port_start", str(start))
    set("service_port_end", str(end))
    return start, end


# ── Who may sign up ───────────────────────────────────────────────────────────
import re as _re

_DOMAIN_RE = _re.compile(r"[a-z0-9-]+(\.[a-z0-9-]+)+")


def signup_domains() -> list[str]:
    """Email domains that sign up without an invite code; none = anyone does. A manager's
    saved list (Invite codes page) wins over SIGNUP_ALLOWED_DOMAINS, an empty one included."""
    raw = get("signup_domains")
    return list(config.SIGNUP_ALLOWED_DOMAINS) if raw is None else [d for d in raw.split(",") if d]


def admin_codes_open_signup() -> bool:
    """May a project admin's invite code let an address outside those domains sign up?"""
    return get("signup_admin_codes") == "1"


def set_signup(domains: list[str], admin_codes: bool) -> None:
    clean = sorted({(d or "").strip().lower().lstrip("@") for d in domains} - {""})
    bad = [d for d in clean if not _DOMAIN_RE.fullmatch(d)]
    if bad:
        raise ValueError(f"도메인 모양이 아닙니다: {', '.join(bad)}")
    set("signup_domains", ",".join(clean))
    set("signup_admin_codes", "1" if admin_codes else "0")
