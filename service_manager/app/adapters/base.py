"""
Adapter contract — what the launcher needs from a service, regardless of kind.

The launcher knows only this interface; `managed` (subprocess) and `external`
(remote URL) implement it. Add a mode by adding an Adapter; the lifecycle,
health-check, listing, and proxy code stay unchanged.
"""
from __future__ import annotations

import os
import socket
import threading
from pathlib import Path
from typing import Optional

from .. import config


def port_alive(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


# ── PID-verified port ownership ───────────────────────────────────────────────
# A `.port` file alone only says "something is listening there" — NOT that it's
# THIS service's process. If a service's process dies and another (e.g. elog)
# later grabs that port, the stale `.port` would proxy to the wrong service.
# So we also record the spawned PID in a sibling `.pid`; a port is only "ours"
# if that PID is still alive.
def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True                       # exists but not signalable by us → alive
    except OSError:
        return False
    return True


def write_pid(port_file: Path, pid: int) -> None:
    (port_file.parent / ".pid").write_text(str(pid))


def read_running_port(port_file: Path) -> Optional[int]:
    """The port a service is CURRENTLY serving on, or None. Trusts the recorded
    PID: a dead process whose port got reused is treated as stale (and cleared),
    which prevents cross-wiring one service's `/p/…` to another."""
    if not port_file.exists():
        return None
    pid_file = port_file.parent / ".pid"

    def _clear():
        port_file.unlink(missing_ok=True)
        pid_file.unlink(missing_ok=True)

    try:
        port = int(port_file.read_text().strip())
    except Exception:
        _clear()
        return None
    if pid_file.exists():
        try:
            if not _pid_alive(int(pid_file.read_text().strip())):
                _clear()
                return None
        except Exception:
            _clear()
            return None
    if not port_alive(port):
        _clear()
        return None
    return port


# ── Shared service-port allocation ────────────────────────────────────────────
# BOTH allocators (single-service `managed` + multi-project `project_runtime`) go
# through here, so they can never hand out the same port. A port is "taken" if it
# is listed in ANY .port file (a reservation) OR something is already listening.
# A lock makes pick+claim atomic, so two concurrent starts can't grab the same one.
_alloc_lock = threading.Lock()


def reserved_ports() -> set[int]:
    """Every port claimed by a service or project (its `.port` file)."""
    out: set[int] = set()
    root = config.DATA_ROOT
    try:
        files = list(root.glob("*/.port")) + list(root.glob("*/projects/*/.port"))
    except Exception:
        files = []
    for pf in files:
        try:
            out.add(int(pf.read_text().strip()))
        except Exception:
            pass
    return out


def reserve_port(port_file: Path) -> int:
    """Pick a free service port and atomically claim it by writing `port_file`.

    The window is admin-editable at runtime (settings_store), falling back to the
    config defaults — a lazy import keeps this low-level module free of a DB
    dependency at import time."""
    from .. import settings_store
    start, end = settings_store.port_range()
    with _alloc_lock:
        taken = reserved_ports()
        for port in range(start, end + 1):
            if port in taken or port_alive(port):
                continue
            port_file.parent.mkdir(parents=True, exist_ok=True)
            port_file.write_text(str(port))
            return port
    raise RuntimeError(f"No free service port ({start}-{end} all in use)")


class Adapter:
    mode: str = "base"

    def status(self, name: str, manifest: dict) -> dict:
        """Return {running, port, url} for the service."""
        raise NotImplementedError

    def start(self, name: str, manifest: dict) -> dict:
        """Bring the service up (no-op for external). Return status dict."""
        raise NotImplementedError

    def stop(self, name: str, manifest: dict) -> dict:
        """Take the service down (no-op for external)."""
        raise NotImplementedError

    def target_base(self, name: str, manifest: dict) -> Optional[str]:
        """Base URL the proxy forwards to (e.g. http://127.0.0.1:8021), or None
        if the service can't currently be reached."""
        raise NotImplementedError

    def proxy_headers(self, manifest: dict) -> dict:
        """Extra headers to attach when proxying (e.g. an external token)."""
        return {}
