"""
Service registry — the filesystem side of a service.

Each service is a directory under DATA_ROOT. Its *manifest* (`service.json`)
declares how to run/reach it, decoupling the launcher from any one service type
(Phase A). The portal DB (`models.Service`) holds orthogonal concerns: visibility
and per-account permission.

Manifest schema (all keys optional; defaults applied on read):
  {
    "kind":   "elog",                 # adapter family / list badge
    "mode":   "managed",              # managed (subprocess) | external (remote URL)
    "start":  {"cmd": "...", "cwd": "...", "env": {}},   # managed only
    "health": "/api/projects",        # health-check path (probed against target)
    "entry":  "/",                    # path users land on when entering
    "url":    "https://host/p/x",     # external only — where the service lives
    "token":  "...",                  # external only — bearer sent on proxy
    "identity": {"accepts_portal_token": true, "link_by": "email"},
    "icon":   null, "color": null     # cosmetic, travel with the data
  }
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
from pathlib import Path
from typing import Optional

from . import config

# First character alphanumeric: `_portal`, `_archive`, … are the portal's own folders.
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


def _atomic_write_text(path: Path, text: str) -> None:
    """Write via a temp file in the same dir + os.replace (atomic rename), so a crash
    or full disk mid-write can never leave a TRUNCATED file. A truncated service.json
    reads back as kind-defaults (read_manifest swallows the parse error), which would
    silently change a service's mode/start recipe and send its data to the wrong dir."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)

# Per-kind manifest defaults. A new managed `elog` only needs an empty dir; the
# launcher fills in how to boot it. Add a dict here to teach the portal a new
# kind without touching the launcher.
KIND_DEFAULTS: dict[str, dict] = {
    "elog": {
        "mode": "managed",
        "start": {"cmd": "uvicorn main:app", "cwd": None, "env": {}},
        "health": "/api/projects",
        "entry": "/",
        "identity": {"accepts_portal_token": True, "link_by": "email"},
    },
}

_BASE_DEFAULT = {
    "kind": "elog",
    "mode": "managed",
    "start": {"cmd": "uvicorn main:app", "cwd": None, "env": {}},
    "health": "/",
    "entry": "/",
    "url": None,
    "token": None,
    "identity": {"accepts_portal_token": True, "link_by": "email"},
    # Declared capabilities (intake answers). `multi_project`: hosts multiple
    # projects (elog-style) — the portal manages/creates them (model A).
    # `import_export`: a project's data can be exported/imported as a zip.
    "capabilities": {"multi_project": False, "import_export": False},
    "icon": None,
    "color": None,
}


def valid_name(name: str) -> bool:
    return bool(NAME_RE.match(name))


LOG_ROTATE_BYTES = 5 * 1024 * 1024


def open_service_log(path: Path):
    """A service's log, opened to APPEND — a restart keeps what the crash before
    it printed. Past LOG_ROTATE_BYTES it moves to <log>.1 (one older copy kept)."""
    try:
        if path.stat().st_size > LOG_ROTATE_BYTES:
            os.replace(path, path.with_name(path.name + ".1"))
    except OSError:
        pass
    f = open(path, "a")
    from datetime import datetime
    f.write(f"\n===== start {datetime.now().isoformat(timespec='seconds')} =====\n")
    f.flush()
    return f


def service_dir(name: str) -> Path:
    # Every path under the data root goes through here, so a name from a URL or
    # another server can never walk out of it (`..`) or into `_portal`.
    if not valid_name(str(name)):
        from fastapi import HTTPException
        raise HTTPException(404, f"'{name}' not found")
    return config.DATA_ROOT / name


def manifest_path(name: str) -> Path:
    return service_dir(name) / "service.json"


# ── Tombstones ────────────────────────────────────────────────────────────────
# A deleted service leaves a marker under `_deleted/` (a `_`-prefixed dir, so it's
# never listed as a service). The deploy entrypoint consults it so an image-baked
# seed service the user intentionally deleted is NOT restored on the next redeploy.
def _tombstone_path(name: str) -> Path:
    return config.DATA_ROOT / "_deleted" / name


def tombstone(name: str) -> None:
    p = _tombstone_path(name)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.touch()


def clear_tombstone(name: str) -> None:
    """A (re)created service overrides any old deletion marker."""
    try:
        _tombstone_path(name).unlink()
    except FileNotFoundError:
        pass


# ── Archive (보관함) ───────────────────────────────────────────────────────────
# "Data-only delete": drop the service's data but keep its DEFINITION (manifest) in
# `_archive/` so it can be restored later, or permanently deleted. `_archive` is a
# `_`-prefixed dir, so it never lists as a service.
def _archive_root() -> Path:
    return config.DATA_ROOT / "_archive"


def archived_manifest_path(name: str) -> Path:
    return _archive_root() / name / "service.json"


def list_archived() -> list[str]:
    d = _archive_root()
    if not d.is_dir():
        return []
    return sorted(x.name for x in d.iterdir() if x.is_dir())


def read_archived_manifest(name: str) -> dict:
    raw: dict = {}
    f = archived_manifest_path(name)
    if f.exists():
        try:
            raw = json.loads(f.read_text())
        except Exception:
            raw = {}
    base = default_manifest(raw.get("kind", "elog"))
    base.update({k: v for k, v in raw.items() if v is not None})
    return base


def archive_service(name: str) -> None:
    """Move the service to the archive: keep its manifest, delete its live data."""
    manifest = read_manifest(name)
    dst = archived_manifest_path(name)
    _atomic_write_text(dst, json.dumps(manifest, ensure_ascii=False, indent=2))
    shutil.rmtree(service_dir(name), ignore_errors=True)


def restore_service(name: str) -> None:
    """Bring an archived service back (as an empty service — its data was dropped)."""
    manifest = read_archived_manifest(name)
    write_manifest(name, manifest)               # recreates <name>/service.json (+ clears tombstone)
    shutil.rmtree(_archive_root() / name, ignore_errors=True)


def purge_archived(name: str) -> None:
    """Permanently remove an archived service and keep it from being re-seeded."""
    shutil.rmtree(_archive_root() / name, ignore_errors=True)
    tombstone(name)


def default_manifest(kind: str = "elog", mode: Optional[str] = None) -> dict:
    m = dict(_BASE_DEFAULT)
    m.update(KIND_DEFAULTS.get(kind, {}))
    m["kind"] = kind
    if mode:
        m["mode"] = mode
    return m


def read_manifest(name: str) -> dict:
    """Read a service's manifest, layering it over kind defaults so older dirs
    (or hand-made ones missing keys) still resolve to a complete manifest."""
    raw: dict = {}
    f = manifest_path(name)
    if f.exists():
        try:
            raw = json.loads(f.read_text())
        except Exception as e:
            # Corrupt/truncated manifest → don't silently masquerade as kind-defaults
            # (that changes the service's mode/start recipe). Surface it loudly; the
            # atomic writer should prevent truncation, so this means real corruption.
            print(f"[registry] WARNING: unreadable manifest {f}: {e} — using defaults",
                  file=sys.stderr, flush=True)
            raw = {}
    base = default_manifest(raw.get("kind", "elog"))
    base.update({k: v for k, v in raw.items() if v is not None})
    return base


def write_manifest(name: str, manifest: dict) -> None:
    p = manifest_path(name)
    _atomic_write_text(p, json.dumps(manifest, ensure_ascii=False, indent=2))
    clear_tombstone(name)                        # (re)creating un-deletes the name


def list_service_names() -> list[str]:
    if not config.DATA_ROOT.is_dir():
        return []
    return sorted(
        d.name for d in config.DATA_ROOT.iterdir()
        if d.is_dir() and not d.name.startswith("_")
    )


def link_project(name: str, manifest: Optional[dict] = None) -> str:
    """The one project of a rack service the OTHER services see — its tags, its
    records to link to. The manifest's `entry_project`, else the first there is;
    "" for a service that takes no part in this. Not an account's own entrance
    (prefs.entry), or two people's links would point at different places."""
    m = manifest or read_manifest(name)
    caps = m.get("capabilities") or {}
    if not caps.get("multi_project") or not (caps.get("tags") or m.get("kind") == "rack"):
        return ""
    if m.get("entry_project"):
        return m["entry_project"]
    root = service_dir(name) / "projects"
    return next(iter(sorted(d.name for d in root.iterdir() if d.is_dir())), "") if root.is_dir() else ""


def link_projects() -> dict[str, str]:
    """{ service: its link project } for every service that has one."""
    return {n: p for n in list_service_names() if (p := link_project(n))}


# ── share sets ────────────────────────────────────────────────────────────────
# Which projects of the rack services share tags and link records with each
# other. A set is {service: project}; a project is in one set at most, so a link
# from it to another service has one place to point. Stored by a manager in
# rack services (data/_portal/share_sets.json); until then the sets are derived
# from the manifests: each `capabilities.tags` group, through its main projects.
def _share_file() -> Path:
    return config.DATA_ROOT / "_portal" / "share_sets.json"


def default_share_sets() -> list[dict]:
    groups: dict[str, dict] = {}
    for n in list_service_names():
        m = read_manifest(n)
        t = (m.get("capabilities") or {}).get("tags")
        p = t and link_project(n, m)
        if p:
            g = "managers" if t is True else str(t)
            groups.setdefault(g, {"name": g, "members": {}})["members"][n] = p
    return list(groups.values())


def share_sets() -> tuple[list[dict], bool]:
    """(sets, stored): the manager's sets, or the derived ones."""
    try:
        d = json.loads(_share_file().read_text("utf-8"))
        if isinstance(d.get("sets"), list):
            return d["sets"], True
    except (OSError, ValueError, AttributeError):
        pass
    return default_share_sets(), False


def write_share_sets(sets: list[dict]) -> None:
    _atomic_write_text(_share_file(), json.dumps({"sets": sets}, ensure_ascii=False, indent=2))


def share_for(svc: str, proj: str) -> dict[str, str]:
    """The {service: project} this project reads tags from and links into: its
    own set; for a project in none, the set of its service's main project, which
    it reads but which does not read it (as before sets existed)."""
    sets, _ = share_sets()
    for s in sets:
        if (s.get("members") or {}).get(svc) == proj:
            return dict(s["members"])
    main = link_project(svc)
    for s in sets:
        if main and (s.get("members") or {}).get(svc) == main:
            return dict(s["members"])
    return {}
