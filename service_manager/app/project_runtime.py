"""
Projects under a multi-project service (model A: the portal manages projects).

A service registered with `capabilities.multi_project` acts as a *template*: its
`start` recipe is reused to run each project as its own instance, with its own
data dir and port. Projects live at `data/<service>/projects/<project>/`, so a
project is exportable/portable as one zip (capability `import_export`).

The portal hands each project process: `PORT`, `PORTAL_PROJECT`,
`PORTAL_PROJECT_DATA` (its data dir), plus the usual `PORTAL_SERVICE`/… . The
service's `start.cmd` consumes the port via `{port}`/`$PORT` and may reference the
project via `{project}`/`$PORTAL_PROJECT`. cwd defaults to the project dir (so a
self-contained server serves the project), or the recipe's own cwd.
"""
from __future__ import annotations

import io
import os
import shlex
import shutil
import signal
import subprocess
import sys
import time
import zipfile
from pathlib import Path
from typing import Optional

from . import config, registry
from .adapters.base import (clear_cooldown, cooldown_active, health_ok, port_alive,
                            read_running_port, reserve_port, set_cooldown, start_lock,
                            write_pid)


def projects_root(svc: str) -> Path:
    return registry.service_dir(svc) / "projects"


def project_dir(svc: str, proj: str) -> Path:
    return projects_root(svc) / proj


def _port_file(svc: str, proj: str) -> Path:
    return project_dir(svc, proj) / ".port"


def read_port(svc: str, proj: str) -> Optional[int]:
    # PID-verified (see adapters.base.read_running_port): a project whose process
    # died but whose port got reused is treated as stale → no cross-wiring.
    return read_running_port(_port_file(svc, proj))


def label_file(svc: str, proj: str) -> Path:
    return project_dir(svc, proj) / ".name"


def get_label(svc: str, proj: str) -> str | None:
    """Optional pretty display name (the folder name stays the stable id/URL). A
    service like asset_manager pushes its in-app rename here so the portal shows
    the same name."""
    f = label_file(svc, proj)
    try:
        return (f.read_text(encoding="utf-8").strip() or None) if f.is_file() else None
    except Exception:
        return None


def set_label(svc: str, proj: str, name: str) -> str:
    if not project_dir(svc, proj).is_dir():
        raise FileNotFoundError(proj)
    name = (name or "").strip()[:128]
    f = label_file(svc, proj)
    if name and name != proj:
        f.write_text(name, encoding="utf-8")
    elif f.exists():
        f.unlink()                       # cleared / same as id → drop the override
    return name


def list_projects(svc: str) -> list[dict]:
    root = projects_root(svc)
    if not root.is_dir():
        return []
    out = []
    for d in sorted(root.iterdir()):
        if not d.is_dir() or d.name.startswith("_"):
            continue
        port = read_port(svc, d.name)
        out.append({
            "name": d.name,
            "label": get_label(svc, d.name),
            "running": port is not None,
            "port": port,
            "url": f"http://localhost:{port}" if port else None,
        })
    return out


def create_project(svc: str, proj: str) -> dict:
    if not registry.valid_name(proj):
        raise ValueError("이름은 영문자·숫자·_·- 만 가능합니다 (1~64자)")
    d = project_dir(svc, proj)
    if d.exists():
        raise FileExistsError(proj)
    d.mkdir(parents=True)
    (d / "uploads").mkdir(exist_ok=True)
    return {"name": proj}


def start_project(svc: str, proj: str) -> dict:
    d = project_dir(svc, proj)
    if not d.exists():
        raise FileNotFoundError(proj)
    port = read_port(svc, proj)
    if port:
        return {"running": True, "port": port, "url": f"http://localhost:{port}", "already_running": True}

    key = f"project:{svc}/{proj}"
    # Serialize starts for this project — a burst of proxied requests to an idle
    # project must spawn ONE instance, not N (the rest re-check read_port below).
    with start_lock(key):
        port = read_port(svc, proj)
        if port:
            return {"running": True, "port": port, "url": f"http://localhost:{port}", "already_running": True}
        recent = cooldown_active(key)
        if recent:                            # a very recent start failed — fail fast
            raise RuntimeError(f"project '{proj}' failed to start recently: {recent}")

        manifest = registry.read_manifest(svc)        # parent template
        start = manifest.get("start") or {}
        cmd = start.get("cmd") or "uvicorn main:app"
        health = (manifest.get("health") or "").strip()

        port = reserve_port(_port_file(svc, proj))    # cross-allocator-safe claim

        uses_port_ph = "{port}" in cmd
        cmd = cmd.replace("{port}", str(port)).replace("{project}", proj)
        argv = shlex.split(cmd)
        if not uses_port_ph and argv and argv[0] == "uvicorn":
            argv = [sys.executable, "-m"] + argv
            # Bind loopback only — the proxy targets 127.0.0.1, so a LAN-exposed
            # project port would bypass the portal's per-project permission guard.
            argv += ["--host", "127.0.0.1", "--port", str(port), "--workers", "1"]

        cwd = start.get("cwd") or str(d)

        # Generic env mapping: a service declares how to translate the portal's
        # project concepts into ITS env via placeholders in `start.env` values — so a
        # service (e.g. elog) connects WITHOUT code changes. Supported placeholders:
        #   {project} {service} {port} {project_data} {projects_root} {data_root}
        def _sub(val: str) -> str:
            return (str(val)
                    .replace("{project}", proj)
                    .replace("{service}", svc)
                    .replace("{port}", str(port))
                    .replace("{project_data}", str(d))
                    .replace("{projects_root}", str(projects_root(svc)))
                    .replace("{data_root}", str(config.DATA_ROOT)))

        env = {
            **os.environ,
            "PORT": str(port),
            "PORTAL_SERVICE_PORT": str(port),
            "PORTAL_SERVICE": svc,
            "PORTAL_PROJECT": proj,
            "PORTAL_PROJECT_DATA": str(d),
            "PORTAL_DATA_ROOT": str(config.DATA_ROOT),
            "PORTAL_PORT": str(config.PORTAL_PORT),
            **{k: _sub(v) for k, v in (start.get("env") or {}).items()},
        }
        # Child output → the project dir's service.log (truncated each start) instead
        # of DEVNULL, so a start failure/crash is diagnosable.
        logf = open(d / "service.log", "w")
        try:
            proc = subprocess.Popen(argv, cwd=cwd, env=env,
                                    stdout=logf, stderr=subprocess.STDOUT)
        finally:
            logf.close()
        write_pid(_port_file(svc, proj), proc.pid)    # verify ownership on read

        for _ in range(16):
            time.sleep(0.5)
            if proc.poll() is not None:               # died on its own → stop waiting
                break
            if health_ok(port, health):
                clear_cooldown(key)
                return {"running": True, "port": port, "url": f"http://localhost:{port}", "started": True}
        try:
            proc.terminate()
            proc.wait(timeout=3)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        _port_file(svc, proj).unlink(missing_ok=True)
        (_port_file(svc, proj).parent / ".pid").unlink(missing_ok=True)
        msg = f"failed to start (port {port}); see {d / 'service.log'}"
        set_cooldown(key, msg)
        raise RuntimeError(f"project '{proj}' {msg}")


def stop_project(svc: str, proj: str) -> dict:
    port = read_port(svc, proj)
    if not port:
        return {"stopped": False, "reason": "not running"}
    try:
        pids = subprocess.check_output(
            ["lsof", "-ti", f":{port}", "-sTCP:LISTEN"], stderr=subprocess.DEVNULL
        ).decode().split()
    except subprocess.CalledProcessError:
        pids = []
    for pid in pids:
        try:
            os.kill(int(pid), signal.SIGTERM)
        except ProcessLookupError:
            pass
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
    _port_file(svc, proj).unlink(missing_ok=True)
    (_port_file(svc, proj).parent / ".pid").unlink(missing_ok=True)
    return {"stopped": True, "port": port}


def delete_project(svc: str, proj: str) -> dict:
    d = project_dir(svc, proj)
    if not d.exists():
        raise FileNotFoundError(proj)
    try:
        stop_project(svc, proj)
    except Exception:
        pass
    shutil.rmtree(d)
    return {"deleted": proj}


def _sqlite_snapshot(f: Path) -> Optional[bytes]:
    """A consistent copy of a live SQLite file, or None if it isn't one.

    Copying `x.db` alongside `x.db-wal` while the service is writing can capture a
    torn state; the backup API takes a proper snapshot instead (and folds the WAL
    in, so the -wal/-shm siblings are not needed in the archive)."""
    import sqlite3
    import tempfile
    try:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "snap.db"
            src = sqlite3.connect(f"file:{f}?mode=ro", uri=True)
            try:
                dst = sqlite3.connect(str(out))
                try:
                    src.backup(dst)
                finally:
                    dst.close()
            finally:
                src.close()
            return out.read_bytes()
    except Exception:                            # noqa: BLE001 — not SQLite / unreadable
        return None


def _syncable_files(d: Path) -> list[Path]:
    """Files that represent a project's state. Runtime scratch (.port, .pid) and the
    WAL siblings are excluded — the latter are folded into the .db snapshot."""
    out = []
    for f in sorted(d.rglob("*")):
        if not f.is_file() or f.name in (".port", ".pid"):
            continue
        if f.name.endswith(("-wal", "-shm")):
            continue
        out.append(f)
    return out


def file_bytes(f: Path) -> bytes:
    """The bytes that represent this file for export/sync — a consistent snapshot
    for SQLite, the file itself otherwise. ONE definition, so a manifest hash and a
    later download can never disagree."""
    if f.suffix == ".db":
        snap = _sqlite_snapshot(f)
        if snap is not None:
            return snap
    return f.read_bytes()


def project_manifest(svc: str, proj: str) -> dict:
    """{relpath: {size, sha256}} over the syncable files — lets a mirror fetch only
    what actually differs instead of the whole project."""
    import hashlib
    d = project_dir(svc, proj)
    if not d.exists():
        raise FileNotFoundError(proj)
    files = {}
    for f in _syncable_files(d):
        b = file_bytes(f)
        files[str(f.relative_to(d))] = {"size": len(b), "sha256": hashlib.sha256(b).hexdigest()}
    return {"project": proj, "files": files}


def project_file(svc: str, proj: str, rel: str) -> bytes:
    """One file's transfer bytes. `rel` is confined to the project dir."""
    d = project_dir(svc, proj).resolve()
    p = (d / rel).resolve()
    if not str(p).startswith(str(d)) or not p.is_file():
        raise FileNotFoundError(rel)
    return file_bytes(p)


def export_project(svc: str, proj: str) -> bytes:
    d = project_dir(svc, proj)
    if not d.exists():
        raise FileNotFoundError(proj)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for f in _syncable_files(d):
            z.writestr(str(f.relative_to(d)), file_bytes(f))
    return buf.getvalue()


def import_project(svc: str, raw: bytes, name: str, replace: bool = False) -> dict:
    if not registry.valid_name(name):
        raise ValueError("이름은 영문자·숫자·_·- 만 가능합니다 (1~64자)")
    d = project_dir(svc, name)
    if d.exists():
        # replace=True is the mirror path (sync): the sub's copy is authoritative
        # only until the next pull, so it is discarded wholesale. Interactive
        # imports keep refusing, so nobody clobbers a project by accident.
        if not replace:
            raise FileExistsError(name)
        shutil.rmtree(d, ignore_errors=True)
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        raise ValueError("올바른 .zip 파일이 아닙니다")
    d.mkdir(parents=True)
    root = d.resolve()
    for member in zf.namelist():
        dest = (d / member).resolve()
        if not str(dest).startswith(str(root)):      # zip-slip guard
            continue
        if member.endswith("/"):
            dest.mkdir(parents=True, exist_ok=True)
        else:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(zf.read(member))
    (d / ".port").unlink(missing_ok=True)
    return {"name": name}


def target_base(svc: str, proj: str) -> Optional[str]:
    """Base URL the proxy forwards to; boots the project on demand."""
    port = read_port(svc, proj)
    if not port:
        port = start_project(svc, proj).get("port")
    return f"http://127.0.0.1:{port}" if port else None
