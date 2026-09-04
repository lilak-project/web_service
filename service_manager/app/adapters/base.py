"""
Adapter contract — what the launcher needs from a service, regardless of kind.

The launcher knows only this interface; `managed` (subprocess) and `external`
(remote URL) implement it. Add a mode by adding an Adapter; the lifecycle,
health-check, listing, and proxy code stay unchanged.
"""
from __future__ import annotations

import os
import pathlib
import socket
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional

from .. import config


def port_alive(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


def health_ok(port: int, health_path: Optional[str], timeout: float = 1.0) -> bool:
    """Readiness check for a managed backend. With a manifest `health` path, the app
    must actually answer an HTTP request there (any status < 500 = up and serving) —
    stronger than a bare TCP connect, which passes the instant the socket binds even
    if the app is still booting or has wedged. Falls back to the TCP check when no
    health path is declared, so services without one behave exactly as before."""
    if not health_path:
        return port_alive(port)
    path = health_path if health_path.startswith("/") else "/" + health_path
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status < 500
    except urllib.error.HTTPError as e:
        return e.code < 500                   # 404/401 etc → the app IS responding
    except Exception:
        return False


# ── Start serialization + crash-loop cooldown ────────────────────────────────
# `target_base` starts a service on demand, so a burst of proxied requests to an
# idle service would each fire a start → N duplicate backends, N-1 leaked and
# fighting over the data dir. A per-service lock makes "check-then-start" atomic
# (the rest re-check read_port and reuse). If a start FAILS, a short cooldown makes
# subsequent requests fail fast instead of fork/kill-storming the box.
_start_locks_guard = threading.Lock()
_start_locks: dict[str, threading.Lock] = {}
_start_cooldown: dict[str, tuple[float, str]] = {}
START_COOLDOWN_SEC = int(os.environ.get("PORTAL_START_COOLDOWN_SEC", "10"))


def start_lock(key: str) -> threading.Lock:
    with _start_locks_guard:
        lk = _start_locks.get(key)
        if lk is None:
            lk = threading.Lock()
            _start_locks[key] = lk
        return lk


def cooldown_active(key: str) -> Optional[str]:
    """The failure message if `key` is in its post-failure cooldown, else None."""
    hit = _start_cooldown.get(key)
    if hit and hit[0] > time.monotonic():
        return hit[1]
    return None


def set_cooldown(key: str, msg: str) -> None:
    _start_cooldown[key] = (time.monotonic() + START_COOLDOWN_SEC, msg)


def clear_cooldown(key: str) -> None:
    _start_cooldown.pop(key, None)


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
    # A ZOMBIE answers signal 0 — the process is dead, but its entry lingers until
    # the parent reaps it, and the portal spawns with Popen and never wait()s. So a
    # service killed out from under the portal kept a PID that looked alive, the
    # .port file stayed "valid", and start() refused to restart it: the service was
    # stuck "running" while nothing listened. Treat defunct as dead, and reap it
    # here when it is our own child so the entry does not pile up.
    try:
        state = (pathlib.Path(f"/proc/{pid}/stat").read_text().rpartition(")")[2]).split()[0]
    except (OSError, IndexError):
        return True                       # no procfs / raced away → trust the signal
    if state != "Z":
        return True
    try:
        os.waitpid(pid, os.WNOHANG)       # ours → reaped; not ours → ChildProcessError
    except (ChildProcessError, OSError):
        pass
    return False


def write_pid(port_file: Path, pid: int) -> None:
    (port_file.parent / ".pid").write_text(str(pid))


#: How long a `.port` with no `.pid` beside it is taken to be a start in
#: progress rather than an abandoned reservation. The real gap between the two
#: writes is milliseconds; this is generous so a loaded host cannot fall
#: through it, and short enough that a genuinely abandoned claim frees its port
#: without anyone intervening.
RESERVATION_GRACE_SEC = 30.0


def read_running_port(port_file: Path) -> Optional[int]:
    """The port a service is CURRENTLY serving on, or None. Trusts the recorded
    PID: a dead process whose port got reused is treated as stale (and cleared),
    which prevents cross-wiring one service's `/p/…` to another.

    The PID is the authority, and a live PID is never cleared -- not even when
    nothing is listening on the port yet. A service takes a moment to bind, and
    during that moment this function is what every concurrent request consults.
    Clearing there would DELETE the reservation of a service that is starting
    normally: the in-flight `start()` still holds the start lock, so the next
    waiter finds no reservation, reserves a second port and spawns a DUPLICATE.
    A browser opening a page fires several requests at once, so that produced
    one duplicate per request -- and for a service that owns hardware (a gauge
    on a serial port) only the first copy can open the device, while the one
    the portal goes on tracking is the one that cannot.

    So a live PID means the port is ours whether or not it answers yet. A
    caller that needs "is it actually serving" asks health_ok/port_alive; this
    answers "whose port is this". A process that is alive but never binds stays
    claimed until someone stops it, which is the recoverable failure -- the old
    behaviour silently multiplied processes instead.
    """
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
        return port                       # ours, whether or not it is up yet

    # No `.pid` yet. Two very different situations look identical here, and the
    # file's age is what tells them apart.
    #
    # `start()` writes `.port` (reserve_port) and only writes `.pid` once the
    # child exists -- building the argv, opening the log and forking sit between
    # the two. A reader landing in that gap must NOT treat the reservation as
    # junk: clearing it there is the same duplicate-spawn bug described above,
    # just through a narrower window.
    #
    # So a reservation younger than RESERVATION_GRACE_SEC is a start in
    # progress and is left alone. An older one really is abandoned -- a
    # reservation written by a portal that died mid-start, or by a version that
    # kept no pid -- and is cleared if nothing is answering on it.
    try:
        age = time.time() - port_file.stat().st_mtime
    except OSError:
        return None
    if age < RESERVATION_GRACE_SEC:
        return port
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
