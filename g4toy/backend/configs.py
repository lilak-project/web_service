"""Named, shareable input configurations.

A config is a snapshot of a user's input workspace (`inputs/`) stored under
`<data>/g4toy/configs/<id>/`. Users save the current setup under a name, reload it
later, and optionally **share** it so anyone can load it like a preset.
"""
from __future__ import annotations

import json
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path

import config
import inputs

ROOT = config.DATA_ROOT / "configs"


def _meta_path(cid: str) -> Path:
    return ROOT / cid / "meta.json"


def _files(cid: str) -> Path:
    return ROOT / cid / "files"


def _meta(cid: str) -> dict:
    mp = _meta_path(cid)
    if not mp.exists():
        raise KeyError(cid)
    return json.loads(mp.read_text())


def save(user_key: str, owner_name: str, name: str, shared: bool) -> dict:
    inputs.ensure(user_key, owner_name)
    cid = uuid.uuid4().hex[:12]
    shutil.copytree(inputs.root(user_key), _files(cid))
    meta = {
        "id": cid, "name": (name or "untitled").strip()[:80],
        "owner": user_key, "owner_name": owner_name, "shared": bool(shared),
        "created": datetime.now(timezone.utc).isoformat(),
    }
    _meta_path(cid).write_text(json.dumps(meta, indent=2))
    return meta


def list_for(user_key: str) -> list[dict]:
    out = []
    if ROOT.exists():
        for d in ROOT.iterdir():
            mp = d / "meta.json"
            if not mp.exists():
                continue
            try:
                m = json.loads(mp.read_text())
            except (ValueError, OSError):
                continue
            if m["owner"] == user_key or m.get("shared"):
                out.append({**m, "mine": m["owner"] == user_key})
    out.sort(key=lambda m: m["created"], reverse=True)
    return out


def load(user_key: str, owner_name: str, cid: str) -> dict:
    m = _meta(cid)
    if m["owner"] != user_key and not m.get("shared"):
        raise PermissionError("no access")
    src = _files(cid)
    dst = inputs.root(user_key)
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)
    inputs._patch_project_config(dst, inputs._sanitize(owner_name or user_key))  # runs under loader
    return inputs.manifest(user_key)


def set_shared(user_key: str, cid: str, shared: bool) -> dict:
    m = _meta(cid)
    if m["owner"] != user_key:
        raise PermissionError("not owner")
    m["shared"] = bool(shared)
    _meta_path(cid).write_text(json.dumps(m, indent=2))
    return m


def delete(user_key: str, cid: str) -> None:
    m = _meta(cid)
    if m["owner"] != user_key:
        raise PermissionError("not owner")
    shutil.rmtree(ROOT / cid)
