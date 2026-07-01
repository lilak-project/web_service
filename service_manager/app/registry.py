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
import re
from pathlib import Path
from typing import Optional

from . import config

NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

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


def service_dir(name: str) -> Path:
    return config.DATA_ROOT / name


def manifest_path(name: str) -> Path:
    return service_dir(name) / "service.json"


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
        except Exception:
            raw = {}
    base = default_manifest(raw.get("kind", "elog"))
    base.update({k: v for k, v in raw.items() if v is not None})
    return base


def write_manifest(name: str, manifest: dict) -> None:
    manifest_path(name).write_text(json.dumps(manifest, ensure_ascii=False, indent=2))


def list_service_names() -> list[str]:
    if not config.DATA_ROOT.is_dir():
        return []
    return sorted(
        d.name for d in config.DATA_ROOT.iterdir()
        if d.is_dir() and not d.name.startswith("_")
    )
