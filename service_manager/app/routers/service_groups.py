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
from .services import VIS_ADMIN, VIS_PRIVATE, VIS_PROTECTED, VIS_PUBLIC, get_or_create_service

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
    registry._atomic_write_text(_FILE, json.dumps(d, ensure_ascii=False, indent=2))


def all_groups() -> list[dict]:
    return _read()["groups"]


# "No group" — the band of cards filed nowhere — is placed and hidden like a
# group, under the reserved id "none" (stored ids are 8 hex digits, never this).
LOOSE_ID = "none"


def loose() -> dict:
    return _read().get("loose") or {}


def _find(d: dict, gid: str) -> dict:
    for g in d["groups"]:
        if g["id"] == gid:
            return g
    raise HTTPException(404, "그룹을 찾을 수 없습니다.")


def _is_project_card(k: str) -> bool:
    svc, _, proj = k.partition("/")
    return bool(proj) and registry.valid_name(svc) and registry.valid_name(proj)


def swap_card(keys: list[str], svc: str, projs: list[str], on: bool) -> list[str]:
    """`keys` with a service's one card replaced by one per project (on), or those
    by the one (off) — at the place the first of them held."""
    out: list[str] = []
    for k in keys:
        if on and k == svc:
            out += [f"{svc}/{p}" for p in projs if f"{svc}/{p}" not in keys]
        elif not on and k.startswith(svc + "/"):
            if svc not in out:
                out.append(svc)
        else:
            out.append(k)
    return out


def split_members(svc: str, projs: list[str], on: bool) -> None:
    """A card sits in one group: going back to one card, the first group keeps it."""
    d = _read()
    seen = False
    for g in d["groups"]:
        had = g.get("members", [])
        new = swap_card(had, svc, projs, on)
        if not on and svc in new:
            if seen:
                new = [k for k in new if k != svc]
            seen = True
        g["members"] = new
    _write(d)


def _clean_members(d: dict, gid: str, members: list[str]) -> list[str]:
    """Members are card keys; a key sits in one group at a time, so adding it here
    removes it from wherever else it was."""
    keys: list[str] = []
    for k in members:
        k = str(k).strip()
        if not k or k in keys or k.startswith("#g:"):
            continue
        if not (k.startswith("@") or registry.valid_name(k) or _is_project_card(k)):
            continue
        keys.append(k)
    for g in d["groups"]:
        if g["id"] != gid:
            g["members"] = [m for m in g.get("members", []) if m not in keys]
    return keys


def sync_set_groups() -> None:
    """Every share set has one fixed sidebar group (share_set = its name) holding
    exactly its projects' cards, named after the set. A service with projects in
    two or more sets is shown one card per project, so each set's group can hold
    its own. Called whenever the sets change; a group whose set is gone becomes
    an ordinary group. Members of a fixed group follow the set only — the group
    API refuses to change them by hand."""
    from . import home as _home
    sets = [s for s in registry.share_sets()[0] if s.get("name")]
    seen: dict = {}
    for st in sets:
        for svc in (st.get("members") or {}):
            seen[svc] = seen.get(svc, 0) + 1
    hd = _home._read()
    for svc, n in seen.items():
        if n > 1 and svc not in set(hd.get("split_cards") or []):
            try:
                _home._set_split(hd, svc, True)
            except HTTPException:
                pass
    _home._write(hd)
    split = set(hd.get("split_cards") or [])
    d = _read()
    # A group follows its set by the set's id (a renamed set keeps its group), by name for one made before ids.
    ids = {st.get("id") for st in sets if st.get("id")}
    names = {st["name"] for st in sets}
    for g in d["groups"]:
        if g.get("share_set") and not (g.get("share_set_id") in ids or g["share_set"] in names):
            g.pop("share_set", None)
            g.pop("share_set_id", None)
    for st in sets:
        keys = [f"{svc}/{proj}" if svc in split else svc for svc, proj in (st.get("members") or {}).items()]
        g = next((x for x in d["groups"] if st.get("id") and x.get("share_set_id") == st["id"]), None) \
            or next((x for x in d["groups"] if x.get("share_set") == st["name"] and x.get("share_set_id") not in ids), None)
        if g is None:
            gid = secrets.token_hex(4)
            g = {"id": gid, "name": st["name"], "icon": None, "color": None, "members": [], "collapsed": False,
                 "hidden": False, "order": 1000 + len(d["groups"]), "share_set": st["name"]}
            d["groups"].append(g)
            if f"#g:{gid}" not in hd["order"]:
                hd["order"].append(f"#g:{gid}")
                _home._write(hd)
        g["name"] = g["share_set"] = st["name"]
        if st.get("id"):
            g["share_set_id"] = st["id"]
        g.pop("labels", None)
        g["members"] = _clean_members(d, g["id"], keys)
    _write(d)


def _service_members(g: dict) -> list[str]:
    # A one-project card is left out: a tier or grant on the whole service would
    # also reach the projects filed in other groups.
    return [m for m in g.get("members", []) if not m.startswith("@") and "/" not in m and registry.service_dir(m).exists()]


def set_orders(keys: list[str]) -> None:
    """Called by home.set_order: mirror each `#g:<id>` key's position into the group."""
    d = _read()
    pos = {k: i for i, k in enumerate(keys)}
    changed = False
    for g in d["groups"] + [d.setdefault("loose", {})]:
        i = pos.get(f"#g:{g.get('id', LOOSE_ID)}")
        if i is not None and g.get("order") != i:
            g["order"] = i
            changed = True
    if changed:
        _write(d)


# ── everyone: read ────────────────────────────────────────────────────────────

@router.get("/api/service-groups")
def list_groups(user: models.User = Depends(require_portal_user)):
    admin = permissions.is_admin(user)
    sets = {s.get("name") for s in registry.share_sets()[0]}
    out = []
    for g in all_groups():
        if g.get("hidden") and not admin:
            continue
        out.append({"id": g["id"], "name": g.get("name") or "", "labels": g.get("labels"), "icon": g.get("icon"), "color": g.get("color"),
                    "members": list(g.get("members", [])), "collapsed": bool(g.get("collapsed")),
                    "hidden": bool(g.get("hidden")), "order": g.get("order", 1000),
                    # Only while that set still exists: a deleted or renamed set leaves no badge behind.
                    "share_set": g.get("share_set") if g.get("share_set") in sets else None})
    lo = loose()
    if admin or not lo.get("hidden"):
        out.append({"id": LOOSE_ID, "name": "", "icon": None, "color": None, "members": [], "collapsed": False,
                     "hidden": bool(lo.get("hidden")), "order": lo.get("order", 100000), "loose": True})
    return out


# ── managers: write ───────────────────────────────────────────────────────────

class GroupBody(BaseModel):
    name: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None
    collapsed: Optional[bool] = None
    hidden: Optional[bool] = None
    members: Optional[list[str]] = None
    # The share set this group was made or updated from (Share sets → "Make/Update group"); "" clears it.
    share_set: Optional[str] = None


def _apply(g: dict, body: GroupBody, d: dict) -> None:
    if body.name is not None:
        g["name"] = body.name.strip()[:80]
        g.pop("labels", None)            # the name just typed is the name, in every language
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
        fixed = {k for x in d["groups"] if x.get("share_set") and x["id"] != g["id"] for k in x.get("members", [])}
        g["members"] = _clean_members(d, g["id"], [k for k in body.members if k not in fixed])
    if body.share_set is not None:
        if body.share_set.strip():
            g["share_set"] = body.share_set.strip()[:80]
        else:
            g.pop("share_set", None)


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
    if gid == LOOSE_ID:
        lo = d.setdefault("loose", {})
        if body.hidden is not None:
            lo["hidden"] = bool(body.hidden)
        _write(d)
        return lo
    g = _find(d, gid)
    if g.get("share_set") and body.members is not None:
        raise HTTPException(400, "공유 세트로 만든 그룹입니다. 구성은 Share sets에서 바꿉니다.")
    _apply(g, body, d)
    _write(d)
    return g


@router.delete("/api/admin/service-groups/{gid}")
def delete_group(gid: str, _: models.User = Depends(require_portal_admin)):
    d = _read()
    g = _find(d, gid)
    if g.get("share_set"):
        raise HTTPException(400, "공유 세트로 만든 그룹은 세트를 지우면 함께 풀립니다.")
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
    if body.visibility not in (VIS_PUBLIC, VIS_PRIVATE, VIS_PROTECTED, VIS_ADMIN):
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
