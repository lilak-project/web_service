"""
Managed adapter — a service the portal runs as a local subprocess.

Generalises the old elog-specific launcher: the boot command, cwd, env, and
health path all come from the manifest, so any `uvicorn`-style (or other) app
fits. Port is assigned at start time from the configured window and tracked in
`data/<name>/.port`, so copying a data dir to another host just works.
"""
from __future__ import annotations

import os
import shlex
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

from .. import config, registry
from .base import Adapter, port_alive, read_running_port, reserve_port, write_pid


def _port_file(name: str) -> Path:
    return registry.service_dir(name) / ".port"


def read_port(name: str) -> Optional[int]:
    # PID-verified — a dead process whose port got reused is treated as stale,
    # so /p/<name> never forwards to a different service that took the port.
    return read_running_port(_port_file(name))


class ManagedAdapter(Adapter):
    mode = "managed"

    def status(self, name: str, manifest: dict) -> dict:
        port = read_port(name)
        return {
            "running": port is not None,
            "port": port,
            "url": f"http://localhost:{port}" if port else None,
        }

    def start(self, name: str, manifest: dict) -> dict:
        sdir = registry.service_dir(name)
        if not sdir.exists():
            raise FileNotFoundError(name)

        port = read_port(name)
        if port:
            return {"running": True, "port": port,
                    "url": f"http://localhost:{port}", "already_running": True}

        port = reserve_port(_port_file(name))   # cross-allocator-safe claim

        start = manifest.get("start") or {}
        cmd = start.get("cmd") or "uvicorn main:app"
        cwd = start.get("cwd") or str(sdir)
        extra_env = start.get("env") or {}

        # Port hand-off — kind-agnostic so any managed service works, not just
        # uvicorn (see SERVICE_CONTRACT §4). The portal always exports the port as
        # $PORT; how the command consumes it:
        #   • `{port}` in cmd  → substituted, command run verbatim (any program);
        #   • bare `uvicorn …` → run as `python -m uvicorn …` + append --host/--port;
        #   • anything else    → run verbatim; the program must read $PORT.
        has_placeholder = "{port}" in cmd
        argv = shlex.split(cmd.replace("{port}", str(port)))
        if not has_placeholder and argv and argv[0] == "uvicorn":
            argv = [sys.executable, "-m"] + argv
            argv += ["--host", "0.0.0.0", "--port", str(port), "--workers", "1"]
        env = {
            **os.environ,
            "PORT": str(port),
            "PORTAL_SERVICE_PORT": str(port),
            "PORTAL_SERVICE": name,
            "PORTAL_DATA_ROOT": str(config.DATA_ROOT),
            "PORTAL_PORT": str(config.PORTAL_PORT),
            **{k: str(v) for k, v in extra_env.items()},
        }
        proc = subprocess.Popen(
            argv, cwd=cwd, env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        write_pid(_port_file(name), proc.pid)   # so read_port can verify ownership

        for _ in range(16):
            time.sleep(0.5)
            if port_alive(port):
                return {"running": True, "port": port,
                        "url": f"http://localhost:{port}", "started": True}

        try:
            proc.kill()
        except Exception:
            pass
        _port_file(name).unlink(missing_ok=True)
        (_port_file(name).parent / ".pid").unlink(missing_ok=True)
        raise RuntimeError(f"service '{name}' failed to start (port {port})")

    def stop(self, name: str, manifest: dict) -> dict:
        port = read_port(name)
        if not port:
            return {"stopped": False, "reason": "not running"}
        try:
            pids = subprocess.check_output(
                ["lsof", "-ti", f":{port}", "-sTCP:LISTEN"],
                stderr=subprocess.DEVNULL,
            ).decode().split()
        except subprocess.CalledProcessError:
            pids = []
        for pid in pids:
            try:
                os.kill(int(pid), signal.SIGTERM)
            except ProcessLookupError:
                pass
        # Some backends run a background loop, so graceful shutdown can lag and
        # the port stays bound — which looks like "Stop didn't work". Wait briefly,
        # then SIGKILL whatever's left (the listening port is the truth source).
        for _ in range(10):
            if not port_alive(port):
                break
            time.sleep(0.2)
        if port_alive(port):
            for pid in pids:
                try:
                    os.kill(int(pid), signal.SIGKILL)
                except ProcessLookupError:
                    pass
        _port_file(name).unlink(missing_ok=True)
        (_port_file(name).parent / ".pid").unlink(missing_ok=True)
        return {"stopped": True, "port": port}

    def target_base(self, name: str, manifest: dict) -> Optional[str]:
        # Ensure the service is up so external pushes via /p/<name> have a stable
        # entry point even if it was idle.
        port = read_port(name)
        if not port:
            started = self.start(name, manifest)
            port = started.get("port")
        return f"http://127.0.0.1:{port}" if port else None
