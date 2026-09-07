"""
Service groups — a manager-made band on the Home cover that holds several cards
and is handled as one thing: collapsed, hidden, given a visibility tier, or
granted to an account, all at once.

Stored beside the other cover customisation, in `data/_portal/service_groups.json`
(per server, not per build). A card belongs to at most one group; members are the
same keys the home order uses (`elog`, `@links`, …). A group's place on the cover
is a `#g:<id>` key in the home order, mirrored into `order` here so non-admins
(who never read home.json) place it the same way.

Nothing here changes what a service IS. Visibility and permissions applied to a
group are written to each member service through the same tables the per-service
admin screens use — the group is a convenience for doing it to several at once.
"""
from __future__ import annotations

import json
import re
import secrets
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import config, models, permissions, registry
from ..db import get_db
from ..deps import require_portal_admin, require_portal_user
from .services import VIS_ADMIN, VIS_PRIVATE, VIS_PROTECTED, get_or_create_service

router = APIRouter(tags=["portal-service-groups"])

_FILE = config.DATA_ROOT / "_portal" / "service_groups.json"
_ID_RE = re.compile(r"^[a-z0-9]{4,16}$")


def _read() -> dict:
    try:
        d = json.loads(_FILE.read_text(encoding="utf-8"))
        if isinstance(d, dict) and isinstance(d.get("groups"), list):
            return d
    except Exception:
        pass
    return {"groups": []}


def _write(d: dict) -> None:
    _FILE.parent.mkdir(parents=True, exist_ok=True)
    _FILE.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")


def all_groups() -> list[dict]:
    return _read()["groups"]


def _find(d: dict, gid: str) -> dict:
    for g in d["groups"]:
        if g["id"] == gid:
            return g
    raise HTTPException(404, "그룹을 찾을 수 없습니다.")


def _clean_members(d: dict, gid: str, members: list[str]) -> list[str]:
    """Members are card keys; a key sits in one group at a time, so adding it here
    removes it from wherever else it was."""
    keys: list[str] = []
    for k in members:
        k = str(k).strip()
        if not k or k in keys or k.startswith("#g:"):
            continue
        if not (k.startswith("@") or registry.valid_name(k)):
            continue
        keys.append(k)
    for g in d["groups"]:
        if g["id"] != gid:
            g["members"] = [m for m in g.get("members", []) if m not in keys]
    return keys


def _service_members(g: dict) -> list[str]:
    return [m for m in g.get("members", []) if not m.startswith("@") and registry.service_dir(m).exists()]


def set_orders(keys: list[str]) -> None:
    """Called by home.set_order: mirror each `#g:<id>` key's position into the group."""
    d = _read()
    pos = {k: i for i, k in enumerate(keys)}
    changed = False
    for g in d["groups"]:
        i = pos.get(f"#g:{g['id']}")
        if i is not None and g.get("order") != i:
            g["order"] = i
            changed = True
    if changed:
        _write(d)


# ── everyone: read ────────────────────────────────────────────────────────────

@router.get("/api/service-groups")
def list_groups(user: models.User = Depends(require_portal_user)):
    admin = permissions.is_admin(user)
    out = []
    for g in all_groups():
        if g.get("hidden") and not admin:
            continue
        out.append({"id": g["id"], "name": g.get("name") or "", "icon": g.get("icon"), "color": g.get("color"),
                    "members": list(g.get("members", [])), "collapsed": bool(g.get("collapsed")),
                    "hidden": bool(g.get("hidden")), "order": g.get("order", 1000)})
    return out


# ── managers: write ───────────────────────────────────────────────────────────

class GroupBody(BaseModel):
    name: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None
    collapsed: Optional[bool] = None
    hidden: Optional[bool] = None
    members: Optional[list[str]] = None


def _apply(g: dict, body: GroupBody, d: dict) -> None:
    if body.name is not None:
        g["name"] = body.name.strip()[:80]
    if body.icon is not None:
        g["icon"] = re.sub(r"[^a-z0-9_-]", "", body.icon.strip().lower()) or None
    if body.color is not None:
        color = body.color.strip()
        if color and not re.match(r"^#[0-9a-fA-F]{6}$", color):
            raise HTTPException(400, "color는 #rrggbb 형식이어야 합니다.")
        g["color"] = color or None
    if body.collapsed is not None:
        g["collapsed"] = bool(body.collapsed)
    if body.hidden is not None:
        g["hidden"] = bool(body.hidden)
    if body.members is not None:
        g["members"] = _clean_members(d, g["id"], body.members)


@router.post("/api/admin/service-groups", status_code=201)
def create_group(body: GroupBody, _: models.User = Depends(require_portal_admin)):
    d = _read()
    gid = secrets.token_hex(4)
    while any(g["id"] == gid for g in d["groups"]):
        gid = secrets.token_hex(4)
    g = {"id": gid, "name": "", "icon": None, "color": None, "members": [], "collapsed": False,
         "hidden": False, "order": 1000 + len(d["groups"])}
    _apply(g, body, d)
    if not g["name"]:
        g["name"] = f"그룹 {len(d['groups']) + 1}"
    d["groups"].append(g)
    _write(d)
    # Place it at the end of the home order so managers and everyone else agree.
    from . import home as _home
    hd = _home._read()
    key = f"#g:{gid}"
    if key not in hd["order"]:
        hd["order"].append(key)
        _home._write(hd)
    return g


@router.put("/api/admin/service-groups/{gid}")
def update_group(gid: str, body: GroupBody, _: models.User = Depends(require_portal_admin)):
    if not _ID_RE.match(gid):
        raise HTTPException(400, "bad id")
    d = _read()
    g = _find(d, gid)
    _apply(g, body, d)
    _write(d)
    return g


@router.delete("/api/admin/service-groups/{gid}")
def delete_group(gid: str, _: models.User = Depends(require_portal_admin)):
    d = _read()
    g = _find(d, gid)
    d["groups"] = [x for x in d["groups"] if x["id"] != gid]
    _write(d)
    from . import home as _home
    hd = _home._read()
    key = f"#g:{gid}"
    if key in hd["order"]:
        # The freed members take the group's place, in their own order.
        i = hd["order"].index(key)
        hd["order"] = hd["order"][:i] + [m for m in g.get("members", []) if m not in hd["order"]] + hd["order"][i + 1:]
        _home._write(hd)
    return {"ok": True, "freed": g.get("members", [])}


class VisibilityBody(BaseModel):
    visibility: int


@router.put("/api/admin/service-groups/{gid}/visibility")
def set_group_visibility(gid: str, body: VisibilityBody, _: models.User = Depends(require_portal_admin),
                         db: Session = Depends(get_db)):
    """The same tier for every member service (builtins have none)."""
    if body.visibility not in (VIS_PRIVATE, VIS_PROTECTED, VIS_ADMIN):
        raise HTTPException(400, "visibility must be 1, 2 or 3")
    g = _find(_read(), gid)
    names = _service_members(g)
    for name in names:
        get_or_create_service(db, name).visibility = body.visibility
    db.commit()
    return {"ok": True, "services": names, "visibility": body.visibility}


class GroupPermissionBody(BaseModel):
    user_id: int
    admin: bool = False


@router.post("/api/admin/service-groups/{gid}/permissions", status_code=201)
def grant_group(gid: str, body: GroupPermissionBody, _: models.User = Depends(require_portal_admin),
                db: Session = Depends(get_db)):
    """A whole-service grant (optionally as scoped admin) on every member service —
    exactly what /api/admin/permissions does, once per member."""
    g = _find(_read(), gid)
    names = _service_members(g)
    for name in names:
        row = db.query(models.ServicePermission).filter(
            models.ServicePermission.user_id == body.user_id,
            models.ServicePermission.service_name == name,
            models.ServicePermission.project == "").first()
        if row:
            row.is_admin = bool(body.admin)
        else:
            db.add(models.ServicePermission(user_id=body.user_id, service_name=name, project="", is_admin=bool(body.admin)))
        for r in db.query(models.AccessRequest).filter(
                models.AccessRequest.user_id == body.user_id, models.AccessRequest.service_name == name,
                models.AccessRequest.project == "", models.AccessRequest.status == "pending").all():
            r.status = "approved"
    db.commit()
    return {"granted": True, "services": names}


@router.delete("/api/admin/service-groups/{gid}/permissions")
def revoke_group(gid: str, body: GroupPermissionBody, _: models.User = Depends(require_portal_admin),
                 db: Session = Depends(get_db)):
    g = _find(_read(), gid)
    names = _service_members(g)
    for name in names:
        db.query(models.ServicePermission).filter(
            models.ServicePermission.user_id == body.user_id,
            models.ServicePermission.service_name == name,
            models.ServicePermission.project == "").delete()
    db.commit()
    return {"granted": False, "services": names}


@router.get("/api/admin/service-groups/{gid}/permissions")
def group_permissions(gid: str, _: models.User = Depends(require_portal_admin), db: Session = Depends(get_db)):
    """Who holds a whole-service grant on ALL members (and on some), for the group panel."""
    g = _find(_read(), gid)
    names = _service_members(g)
    if not names:
        return {"services": [], "all": [], "some": []}
    rows = db.query(models.ServicePermission).filter(
        models.ServicePermission.service_name.in_(names), models.ServicePermission.project == "").all()
    by_user: dict[int, dict] = {}
    for r in rows:
        u = by_user.setdefault(r.user_id, {"user_id": r.user_id, "services": set(), "admin_on": set()})
        u["services"].add(r.service_name)
        if r.is_admin:
            u["admin_on"].add(r.service_name)
    users = {u.id: u for u in db.query(models.User).filter(models.User.id.in_(list(by_user))).all()} if by_user else {}
    out_all, out_some = [], []
    for uid, info in by_user.items():
        u = users.get(uid)
        rec = {"user_id": uid, "username": u.username if u else str(uid), "services": sorted(info["services"]),
               "admin": len(info["admin_on"]) == len(names)}
        (out_all if len(info["services"]) == len(names) else out_some).append(rec)
    return {"services": names, "all": out_all, "some": out_some}
