"""System settings (manager-only) — currently the managed-service port window.

The port pool is where each launched service claims a loopback port; when it's
exhausted, launches fail with "No free service port". Admins can widen it here
without a redeploy (the value is read live by `adapters.base.reserve_port`).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import config, models, settings_store
from ..adapters import base as adapter_base
from ..deps import require_portal_admin

router = APIRouter(tags=["portal-system"], prefix="/api/admin/system")


def _port_status() -> dict:
    start, end = settings_store.port_range()
    total = end - start + 1
    taken = adapter_base.reserved_ports()          # ports claimed via port files
    in_use = sum(1 for p in range(start, end + 1)
                 if p in taken or adapter_base.port_alive(p))
    return {
        "start": start,
        "end": end,
        "total": total,
        "in_use": in_use,
        "free": max(0, total - in_use),
        "default_start": config.SERVICE_PORT_START,
        "default_end": config.SERVICE_PORT_END,
        "portal_port": config.PORTAL_PORT,
        "min": settings_store.PORT_MIN,
        "max": settings_store.PORT_MAX,
        "max_slots": settings_store.MAX_SLOTS,
    }


@router.get("/ports")
def get_ports(_: models.User = Depends(require_portal_admin)):
    return _port_status()


class PortBody(BaseModel):
    start: int
    end: int


@router.put("/ports")
def set_ports(body: PortBody, _: models.User = Depends(require_portal_admin)):
    try:
        settings_store.set_port_range(body.start, body.end)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _port_status()
