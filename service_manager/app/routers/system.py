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


def _signup() -> dict:
    return {"domains": settings_store.signup_domains(), "admin_codes": settings_store.admin_codes_open_signup(),
            "env_default": list(config.SIGNUP_ALLOWED_DOMAINS)}


@router.get("/signup")
def get_signup(_: models.User = Depends(require_portal_admin)):
    """Who may sign up: the email domains that need no invite code."""
    return _signup()


class SignupBody(BaseModel):
    domains: list[str] = []
    admin_codes: bool = False


@router.put("/signup")
def set_signup(body: SignupBody, _: models.User = Depends(require_portal_admin)):
    try:
        settings_store.set_signup(body.domains, body.admin_codes)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _signup()


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


# ── SSH tunnels (Mac portal only) ────────────────────────────────────────────
# The list is ~/.ssh/config itself: every concrete Host with a LocalForward.
# ponytail: Include/Match files are not followed; add when a tunnel lives in one.
import os, re, signal, subprocess, sys
from pathlib import Path


def _tunnels() -> list[dict]:
    if sys.platform != "darwin":                # a tunnel opens where the browser is
        return []
    cfg = Path.home() / ".ssh" / "config"
    if not cfg.exists():
        return []
    out, cur = [], None
    for line in cfg.read_text(errors="replace").splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) < 2 or parts[0].startswith("#"):
            continue
        key, val = parts[0].lower(), parts[1].strip()
        if key in ("host", "match"):
            name = val.split()[0]
            cur = {"name": name, "hostname": "", "forwards": []} if key == "host" and not re.search(r"[*?!]", name) else None
            if cur:
                out.append(cur)
        elif cur and key == "hostname":
            cur["hostname"] = val
        elif cur and key == "localforward":
            m = re.match(r"(?:\S*:)?(\d+)\s+(\S+)", val)
            if m:
                cur["forwards"].append({"port": int(m.group(1)), "to": m.group(2)})
    return [dict(t, port=t["forwards"][0]["port"], to=t["forwards"][0]["to"],
                 up=adapter_base.port_alive(t["forwards"][0]["port"]))
            for t in out if t["forwards"]]


def _tunnel(name: str) -> dict:
    t = next((t for t in _tunnels() if t["name"] == name), None)
    if not t:
        raise HTTPException(404, "no such tunnel in ~/.ssh/config")
    return t


@router.get("/tunnels")
def list_tunnels(_: models.User = Depends(require_portal_admin)):
    return _tunnels()


@router.post("/tunnels/{name}/up")
def tunnel_up(name: str, _: models.User = Depends(require_portal_admin)):
    t = _tunnel(name)
    if not t["up"]:
        try:
            r = subprocess.run(["ssh", "-fN", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
                                "-o", "ExitOnForwardFailure=yes", name],
                               capture_output=True, text=True, timeout=25, stdin=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            raise HTTPException(504, "ssh timed out")
        if r.returncode != 0:
            err = [l for l in r.stderr.splitlines() if re.search(r"ssh:|denied|refused|timed out|bind|error", l, re.I)]
            raise HTTPException(502, (err[-1] if err else f"ssh exited {r.returncode}")[:300])
    return _tunnel(name)


@router.post("/tunnels/{name}/down")
def tunnel_down(name: str, _: models.User = Depends(require_portal_admin)):
    t = _tunnel(name)
    pids = subprocess.run(["lsof", "-nP", "-t", f"-iTCP:{t['port']}", "-sTCP:LISTEN"],
                          capture_output=True, text=True).stdout.split()
    for pid in pids:                            # only the ssh holding the port, never anything else
        comm = subprocess.run(["ps", "-p", pid, "-o", "comm="], capture_output=True, text=True).stdout.strip()
        if comm.endswith("ssh"):
            os.kill(int(pid), signal.SIGTERM)
    return _tunnel(name)
