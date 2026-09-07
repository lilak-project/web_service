"""Bring up the services that asked to be running, from the portal's own process.

Services normally start lazily, on the first request that needs one. That is the
right default — a portal with twenty services should not run twenty processes for
a visitor who opens one — but it leaves a gap for anything that must be reachable
before a person shows up:

  • a DAQ pushes a run boundary to elog with nobody watching, and elog has to be
    up to receive it;
  • the same is true of a service elog fetches from on a schedule.

And it leaves a subtler one. A service ends up wherever it was first started
from: spawned by the portal it lands in the portal's cgroup and under its memory
ceiling, spawned by hand from a shell it does not — so whether a service is
inside the limit depended on who happened to open it first, and a portal restart
would kill only half of them while the rest kept holding their ports.

Starting them HERE settles both: after `systemctl restart lilak-portal`
everything that matters is up, in one cgroup, under one ceiling.

Opt-in per service, in its manifest:

    "autostart": true                     # a single service
    "autostart": ["KO2520_live"]          # a multi-project service: these projects
    "autostart": true                     # …or every project it already has

Anything without the key behaves exactly as before.
"""
from __future__ import annotations

import threading
import time

from . import project_runtime as pr
from . import registry
from .adapters import get_adapter


def _wanted(manifest: dict) -> object:
    return manifest.get("autostart") or False


def _projects_for(name: str, flag: object) -> list[str]:
    if isinstance(flag, list):
        return [str(p) for p in flag]
    return [p["name"] for p in pr.list_projects(name)]


def _start_all() -> None:
    for name in registry.list_service_names():
        try:
            manifest = registry.read_manifest(name)
        except Exception as exc:                     # noqa: BLE001 — a bad manifest
            print(f"[autostart] {name}: manifest unreadable: {exc}", flush=True)
            continue
        flag = _wanted(manifest)
        if not flag:
            continue

        multi = bool((manifest.get("capabilities") or {}).get("multi_project"))
        try:
            if multi:
                for proj in _projects_for(name, flag):
                    st = pr.start_project(name, proj)
                    print(f"[autostart] {name}/{proj} -> port {st.get('port')}", flush=True)
            else:
                st = get_adapter(manifest).start(name, manifest)
                print(f"[autostart] {name} -> port {st.get('port')}", flush=True)
        except Exception as exc:                     # noqa: BLE001
            # One service that will not come up must never stop the rest, and must
            # never stop the portal: the whole point is that the portal is still
            # there to say so.
            print(f"[autostart] {name}: {type(exc).__name__}: {exc}", flush=True)


def run(delay: float = 2.0) -> threading.Thread:
    """Start the opted-in services on a background thread.

    Off the event loop because a start waits for a health check (~8 s worst case)
    and doing that inline would leave the portal unable to answer anything —
    including the page that shows what is happening — until the last one finished.
    The short delay lets the portal finish binding first, so a service that calls
    home on boot finds it.
    """
    def worker() -> None:
        time.sleep(delay)
        _start_all()

    thread = threading.Thread(target=worker, name="autostart", daemon=True)
    thread.start()
    return thread
