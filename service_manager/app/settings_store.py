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
