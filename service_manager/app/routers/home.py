"""
Home cover customisation — the admin "manage mode" also covers the built-in cards
(lilak icon, create service), which have no manifest. Their label/icon/colour
overrides and the unified card order (builtins + services) live in one small store:
`data/_portal/home.json`.

Service order is ALSO mirrored into each service's manifest so non-admins (who
never read this store) see the same ordering.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import config, models, registry
from ..deps import require_portal_admin

router = APIRouter(tags=["portal-home"])

_FILE = config.DATA_ROOT / "_portal" / "home.json"
_BUILTINS = ("iconlab", "newservice", "store")


def _read() -> dict:
    try:
        d = json.loads(_FILE.read_text(encoding="utf-8"))
        if isinstance(d, dict):
            d.setdefault("order", [])
            d.setdefault("builtins", {})
            return d
    except Exception:
        pass
    return {"order": [], "builtins": {}}


def _write(d: dict) -> None:
    _FILE.parent.mkdir(parents=True, exist_ok=True)
    _FILE.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")


@router.get("/api/admin/home")
def get_home(_: models.User = Depends(require_portal_admin)):
    return _read()


class OrderBody(BaseModel):
    keys: list[str]      # e.g. ["@iconlab", "elog", "asset_manager", "@newservice"]


@router.put("/api/admin/home-order")
def set_order(body: OrderBody, _: models.User = Depends(require_portal_admin)):
    d = _read()
    d["order"] = body.keys
    _write(d)
    # Mirror the relative service order into manifests (non-admins sort by that).
    i = 0
    for k in body.keys:
        if k.startswith("@"):
            continue
        if registry.service_dir(k).exists():
            m = registry.read_manifest(k)
            m["order"] = i
            registry.write_manifest(k, m)
            i += 1
    return {"ok": True}


class BuiltinBody(BaseModel):
    key: str
    label: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None


@router.put("/api/admin/home-builtin")
def set_builtin(body: BuiltinBody, _: models.User = Depends(require_portal_admin)):
    if body.key not in _BUILTINS:
        raise HTTPException(400, "알 수 없는 빌트인입니다.")
    d = _read()
    b = d.setdefault("builtins", {}).setdefault(body.key, {})
    if body.label is not None:
        b["label"] = body.label.strip() or None
    if body.icon is not None:
        b["icon"] = re.sub(r"[^a-z0-9_-]", "", body.icon.strip().lower()) or None
    if body.color is not None:
        color = body.color.strip()
        if color and not re.match(r"^#[0-9a-fA-F]{6}$", color):
            raise HTTPException(400, "color는 #rrggbb 형식이어야 합니다.")
        b["color"] = color or None
    _write(d)
    return {"ok": True, "builtins": d["builtins"]}
