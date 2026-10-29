"""System settings (manager-only) — currently the managed-service port window.

The port pool is where each launched service claims a loopback port; when it's
exhausted, launches fail with "No free service port". Admins can widen it here
without a redeploy (the value is read live by `adapters.base.reserve_port`).
"""
from __future__ import annotations

import threading

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import config, models, project_runtime, registry, settings_store
from ..adapters import base as adapter_base, get_adapter
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


def _running() -> list[tuple[str, str]]:
    """(service, project) for every process the portal runs now; project "" = the service itself."""
    out = []
    for name in registry.list_service_names():
        try:
            manifest = registry.read_manifest(name)
        except Exception:
            continue
        if manifest.get("mode") != "managed":
            continue
        if get_adapter(manifest).status(name, manifest).get("running"):
            out.append((name, ""))
        out += [(name, p["name"]) for p in project_runtime.list_projects(name) if p["running"]]
    return out


def _start(name: str, proj: str) -> None:
    try:
        if proj:
            project_runtime.start_project(name, proj)
        else:
            manifest = registry.read_manifest(name)
            get_adapter(manifest).start(name, manifest)
    except Exception as e:                      # the service's log says why
        print(f"[restart] {name}/{proj}: {e}")


@router.post("/restart")
def restart_running(_: models.User = Depends(require_portal_admin)):
    """Restart everything that is running, so new code (e.g. lilak_portal_auth) takes effect.
    Stops now; starts again in the background, one by one (a rack start may build first)."""
    targets = _running()
    for name, proj in targets:
        if proj:
            project_runtime.stop_project(name, proj)
        else:
            manifest = registry.read_manifest(name)
            get_adapter(manifest).stop(name, manifest)
    threading.Thread(target=lambda: [_start(n, p) for n, p in targets], daemon=True).start()
    return {"restarting": [f"{n}/{p}" if p else n for n, p in targets]}
