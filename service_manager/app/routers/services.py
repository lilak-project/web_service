"""
Portal-facing service list + permissions + access requests.

Visibility tiers (per service):
  1 private   — visible only to permitted accounts; hidden otherwise.
  2 protected — visible to all; only permitted may enter, others can request.  ← default
  3 admin     — visible to admins only.
Admins (role "manager") see and enter everything.
"""
from __future__ import annotations

import re
import shutil
import urllib.error
import urllib.request
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import config, models, permissions, registry, security
from ..db import get_db
from ..deps import require_portal_admin, require_portal_user
from ..models import (
    VIS_ADMIN, VIS_PRIVATE, VIS_PROTECTED, DEFAULT_VISIBILITY,
    AccessRequest, Service, ServicePermission,
)
from .projects import list_raw_services

router = APIRouter(tags=["portal-services"])


# ── Helpers ───────────────────────────────────────────────────────────────────
def _is_admin(user: models.User) -> bool:
    return user.role == "manager"


def get_or_create_service(db: Session, name: str, kind: str = "elog") -> Service:
    svc = db.query(Service).filter(Service.name == name).first()
    if svc is None:
        svc = Service(name=name, kind=kind, visibility=DEFAULT_VISIBILITY)
        db.add(svc)
        db.flush()
    return svc


def has_permission(db: Session, user_id: int, name: str) -> bool:
    """Any grant within the service (whole-service or a single project)."""
    return permissions.has_any_grant(db, user_id, name)


def _pending(db: Session, user_id: int, name: str, project: str = "") -> bool:
    return db.query(AccessRequest).filter(
        AccessRequest.user_id == user_id,
        AccessRequest.service_name == name,
        AccessRequest.project == project,
        AccessRequest.status == "pending",
    ).first() is not None


def annotate_services(db: Session, user: models.User, raw: list[dict]) -> list[dict]:
    admin = _is_admin(user)
    verified = permissions.verification_current(user)
    out: list[dict] = []
    for p in raw:
        svc = get_or_create_service(db, p["name"], p.get("kind") or "elog")
        vis = svc.visibility
        multi = bool(p.get("multi_project"))
        if admin:
            can_enter, can_request = True, False
        elif vis == VIS_ADMIN:
            continue
        elif vis == VIS_PRIVATE:
            if not has_permission(db, user.id, p["name"]):
                continue
            can_enter, can_request = True, False
        elif multi:                                   # VIS_PROTECTED, multi-project
            # Open the box to request access to individual projects inside — no
            # all-or-nothing service-level request.
            can_enter, can_request = True, False
        else:                                         # VIS_PROTECTED, single service
            perm = has_permission(db, user.id, p["name"])
            can_enter, can_request = perm, (not perm)
        out.append({
            **p,
            "kind": svc.kind,
            "visibility": vis,
            "can_enter": can_enter,
            "can_request": can_request,
            # view_only: the box opens (to see projects) but entering is blocked
            # until the account re-verifies its email.
            "view_only": (can_enter and not verified and not admin),
            "requested": _pending(db, user.id, p["name"]) if can_request else False,
        })
    db.commit()
    return out


# ── Routes ────────────────────────────────────────────────────────────────────
@router.get("/api/services")
def list_services(
    user: models.User = Depends(require_portal_user),
    db: Session = Depends(get_db),
):
    return annotate_services(db, user, list_raw_services())


class AccessRequestBody(BaseModel):
    service: str
    project: Optional[str] = ""   # a specific project, or "" for a single service


@router.post("/api/access-requests", status_code=201)
def create_access_request(
    body: AccessRequestBody,
    user: models.User = Depends(require_portal_user),
    db: Session = Depends(get_db),
):
    name = body.service
    proj = (body.project or "").strip()
    svc = get_or_create_service(db, name)
    if svc.visibility == VIS_ADMIN and not _is_admin(user):
        raise HTTPException(status_code=404, detail="서비스를 찾을 수 없습니다.")
    # A private service is only requestable by someone who can already see it
    # (has some grant in it); otherwise it's hidden.
    if svc.visibility == VIS_PRIVATE and not _is_admin(user) and not permissions.has_any_grant(db, user.id, name):
        raise HTTPException(status_code=404, detail="서비스를 찾을 수 없습니다.")
    already = (permissions.has_service_grant(db, user.id, name) or proj in permissions.project_grants(db, user.id, name)) if proj \
        else has_permission(db, user.id, name)
    if already:
        return {"requested": False, "reason": "already_permitted"}
    if not _pending(db, user.id, name, proj):
        db.add(AccessRequest(user_id=user.id, service_name=name, project=proj))
        db.commit()
    return {"requested": True}


# ── Admin endpoints ───────────────────────────────────────────────────────────
class ServiceMetaBody(BaseModel):
    visibility: Optional[int] = None
    kind: Optional[str] = None


@router.get("/api/admin/services")
def admin_list_services(
    _: models.User = Depends(require_portal_admin),
    db: Session = Depends(get_db),
):
    rows = {s.name: s for s in db.query(Service).all()}
    out = []
    for p in list_raw_services():
        s = rows.get(p["name"]) or get_or_create_service(db, p["name"], p.get("kind") or "elog")
        out.append({"name": p["name"], "running": p["running"],
                    "kind": s.kind, "visibility": s.visibility, "mode": p.get("mode"),
                    "multi_project": p.get("multi_project"), "import_export": p.get("import_export")})
    db.commit()
    return out


@router.put("/api/admin/services/{name}")
def admin_set_service(
    name: str, body: ServiceMetaBody,
    _: models.User = Depends(require_portal_admin),
    db: Session = Depends(get_db),
):
    svc = get_or_create_service(db, name)
    if body.visibility is not None:
        if body.visibility not in (VIS_PRIVATE, VIS_PROTECTED, VIS_ADMIN):
            raise HTTPException(status_code=400, detail="visibility must be 1, 2 or 3")
        svc.visibility = body.visibility
    if body.kind is not None:
        svc.kind = body.kind
    db.commit()
    return {"name": svc.name, "kind": svc.kind, "visibility": svc.visibility}


class ServiceAppearanceBody(BaseModel):
    icon: Optional[str] = None
    color: Optional[str] = None
    label: Optional[str] = None


class ServiceOrderBody(BaseModel):
    names: list[str]


# NOTE: registered before the generic `/{name}` PUT so "service-order" isn't
# swallowed as a service name. (Distinct path avoids the collision entirely.)
@router.put("/api/admin/service-order")
def admin_set_order(
    body: ServiceOrderBody,
    _: models.User = Depends(require_portal_admin),
):
    """Persist the Home display order (manage mode). Writes an `order` index into
    each named service's manifest; the service list sorts by it."""
    n = 0
    for i, name in enumerate(body.names):
        if registry.service_dir(name).exists():
            manifest = registry.read_manifest(name)
            manifest["order"] = i
            registry.write_manifest(name, manifest)
            n += 1
    return {"ok": True, "count": n}


@router.put("/api/admin/services/{name}/appearance")
def admin_set_appearance(
    name: str, body: ServiceAppearanceBody,
    _: models.User = Depends(require_portal_admin),
    db: Session = Depends(get_db),
):
    """Edit a service's card icon + colour + display name (stored in its manifest,
    surfaced in the Home list). All optional; a blank value clears the override."""
    if not registry.service_dir(name).exists():
        raise HTTPException(404, f"'{name}' 서비스를 찾을 수 없습니다.")
    manifest = registry.read_manifest(name)
    if body.icon is not None:
        icon = re.sub(r"[^a-z0-9_-]", "", body.icon.strip().lower())
        manifest["icon"] = icon or None
    if body.color is not None:
        color = body.color.strip()
        if color and not re.match(r"^#[0-9a-fA-F]{6}$", color):
            raise HTTPException(400, "color는 #rrggbb 형식이어야 합니다.")
        manifest["color"] = color or None
    if body.label is not None:
        manifest["label"] = body.label.strip() or None
    registry.write_manifest(name, manifest)
    return {"name": name, "icon": manifest.get("icon"),
            "color": manifest.get("color"), "label": manifest.get("label")}


@router.get("/api/admin/users")
def admin_list_users(
    _: models.User = Depends(require_portal_admin),
    db: Session = Depends(get_db),
):
    from datetime import datetime as _dt
    # group memberships, one query
    gnames = {g.id: g.name for g in db.query(models.Group).all()}
    memb: dict[int, list] = {}
    for m in db.query(models.GroupMembership).all():
        memb.setdefault(m.user_id, []).append({"id": m.group_id, "name": gnames.get(m.group_id)})
    # direct (per-user) service permissions, one query
    perms: dict[int, list] = {}
    for p in db.query(ServicePermission).all():
        perms.setdefault(p.user_id, []).append({"service": p.service_name, "project": p.project or None})
    # group grants (inherited by members), one query, indexed by group
    gperms: dict[int, list] = {}
    for p in db.query(models.GroupPermission).all():
        gperms.setdefault(p.group_id, []).append({"service": p.service_name, "project": p.project or None})
    out = []
    for u in db.query(models.User).order_by(models.User.id.asc()).all():
        left = None
        if u.email_verified_at:
            left = models.VERIFY_VALID_DAYS - (_dt.utcnow() - u.email_verified_at).days
        inherited = [{"service": pp["service"], "project": pp["project"], "group": gm.get("name")}
                     for gm in memb.get(u.id, []) for pp in gperms.get(gm["id"], [])]
        out.append({"id": u.id, "username": u.username, "email": u.email, "role": u.role,
                    "is_active": u.is_active,
                    "display_name": u.display_name, "pending_email": u.pending_email,
                    "verification_current": permissions.verification_current(u),
                    "verify_days_left": left, "groups": memb.get(u.id, []),
                    "permissions": perms.get(u.id, []),
                    "inherited_permissions": inherited,
                    "profile_shape": u.profile_shape,
                    "profile_color": config.MANAGER_COLOR if u.role == "manager" else u.profile_color})
    return out


class PermissionBody(BaseModel):
    user_id: int
    service: str
    project: Optional[str] = ""   # "" = whole-service grant


@router.post("/api/admin/permissions", status_code=201)
def admin_grant(
    body: PermissionBody,
    _: models.User = Depends(require_portal_admin),
    db: Session = Depends(get_db),
):
    proj = (body.project or "").strip()
    exists = db.query(ServicePermission).filter(
        ServicePermission.user_id == body.user_id,
        ServicePermission.service_name == body.service,
        ServicePermission.project == proj,
    ).first()
    if not exists:
        db.add(ServicePermission(user_id=body.user_id, service_name=body.service, project=proj))
    for r in db.query(AccessRequest).filter(
        AccessRequest.user_id == body.user_id,
        AccessRequest.service_name == body.service,
        AccessRequest.project == proj,
        AccessRequest.status == "pending",
    ).all():
        r.status = "approved"
    db.commit()
    return {"granted": True}


@router.delete("/api/admin/permissions")
def admin_revoke(
    body: PermissionBody,
    _: models.User = Depends(require_portal_admin),
    db: Session = Depends(get_db),
):
    db.query(ServicePermission).filter(
        ServicePermission.user_id == body.user_id,
        ServicePermission.service_name == body.service,
        ServicePermission.project == (body.project or "").strip(),
    ).delete()
    db.commit()
    return {"granted": False}


@router.get("/api/admin/permissions")
def admin_list_permissions(
    _: models.User = Depends(require_portal_admin),
    db: Session = Depends(get_db),
):
    return [{"user_id": p.user_id, "service": p.service_name, "project": p.project}
            for p in db.query(ServicePermission).all()]


@router.get("/api/admin/access-requests")
def admin_list_requests(
    _: models.User = Depends(require_portal_admin),
    db: Session = Depends(get_db),
):
    rows = db.query(AccessRequest).filter(AccessRequest.status == "pending").all()
    users = {u.id: u for u in db.query(models.User).all()}
    return [
        {"id": r.id, "user_id": r.user_id,
         "username": users[r.user_id].username if r.user_id in users else None,
         "service": r.service_name, "project": r.project,
         "created_at": r.created_at.isoformat() if r.created_at else None}
        for r in rows
    ]


class ResolveBody(BaseModel):
    action: str   # "approve" | "reject"


@router.post("/api/admin/access-requests/{rid}")
def admin_resolve_request(
    rid: int, body: ResolveBody,
    _: models.User = Depends(require_portal_admin),
    db: Session = Depends(get_db),
):
    r = db.query(AccessRequest).filter(AccessRequest.id == rid).first()
    if not r:
        raise HTTPException(status_code=404, detail="요청을 찾을 수 없습니다.")
    if body.action == "approve":
        exists = db.query(ServicePermission).filter(
            ServicePermission.user_id == r.user_id,
            ServicePermission.service_name == r.service_name,
            ServicePermission.project == r.project,
        ).first()
        if not exists:
            db.add(ServicePermission(user_id=r.user_id, service_name=r.service_name, project=r.project))
        r.status = "approved"
    elif body.action == "reject":
        r.status = "rejected"
    else:
        raise HTTPException(status_code=400, detail="action must be approve or reject")
    db.commit()
    return {"id": rid, "status": r.status}


# ── Handshake self-registration ───────────────────────────────────────────────
# A service registers ITSELF in one call: it POSTs its descriptor with the
# registration token (no admin form). Repeating the call updates the entry
# (re-handshake). Defaults to an `external` service announcing its own URL.

class HandshakeBody(BaseModel):
    name: str
    kind: str = "service"
    mode: str = "external"
    url: Optional[str] = None
    token: Optional[str] = None
    health: Optional[str] = "/"
    entry: Optional[str] = "/"
    accepts_portal_token: bool = False
    multi_project: bool = False
    import_export: bool = False
    link_by: str = "email"


@router.get("/api/admin/handshake-info")
def handshake_info(_: models.User = Depends(require_portal_admin)):
    """The portal URL + registration token an admin pastes into a service's
    handshake script (token is admin-only)."""
    return {"portal_url": config.BASE_URL, "register_token": config.REGISTER_TOKEN,
            "endpoint": f"{config.BASE_URL}/api/handshake"}


@router.post("/api/handshake", status_code=201)
def handshake(body: HandshakeBody, authorization: Optional[str] = Header(default=None),
             db: Session = Depends(get_db)):
    if not config.REGISTER_ENABLED:
        # Refuse rather than accept the public default token (which would let anyone
        # register a service on an exposed portal). Set PORTAL_REGISTER_TOKEN to use.
        raise HTTPException(503, "self-registration is disabled (set PORTAL_REGISTER_TOKEN)")
    if security.bearer(authorization) != config.REGISTER_TOKEN:
        raise HTTPException(401, "유효하지 않은 등록 토큰입니다.")
    name = body.name.strip()
    if not registry.valid_name(name):
        raise HTTPException(400, "이름은 영문자·숫자·_·- 만 가능합니다 (1~64자)")
    if body.mode not in ("managed", "external"):
        raise HTTPException(400, "mode must be 'managed' or 'external'")
    if body.mode == "external" and not (body.url or "").strip():
        raise HTTPException(400, "external 서비스는 url이 필요합니다.")

    sdir = registry.service_dir(name)
    existed = sdir.exists()
    # Layer the descriptor over the existing manifest (so a re-handshake updates
    # only what it sends), or over kind defaults for a brand-new service.
    manifest = registry.read_manifest(name) if existed else registry.default_manifest(body.kind, body.mode)
    manifest.update({
        "kind": body.kind, "mode": body.mode,
        "health": body.health or "/", "entry": body.entry or "/",
        "identity": {"accepts_portal_token": body.accepts_portal_token, "link_by": body.link_by or "email"},
        # A project-creating (multi-project) service gets import/export by default.
        "capabilities": {"multi_project": body.multi_project,
                         "import_export": body.import_export or body.multi_project},
    })
    if body.mode == "external":
        manifest["url"] = body.url.strip()
        manifest["token"] = body.token or None
    if not existed:
        sdir.mkdir(parents=True)
    registry.write_manifest(name, manifest)
    get_or_create_service(db, name, body.kind)   # default visibility on first sight
    db.commit()
    return {"ok": True, "name": name, "updated": existed,
            "entry": f"{config.BASE_URL}/p/{name}{manifest.get('entry', '/')}"}


# ── External service registration (Phase B) ───────────────────────────────────

def _probe(url: str, token: Optional[str], health: str) -> dict:
    """GET <url><health> (with optional bearer); 'reachable' means it answered
    below 500 (a 401/403 still proves it's up)."""
    if not url:
        return {"reachable": False, "detail": "url required"}
    probe = url.rstrip("/") + "/" + (health or "/").lstrip("/")
    req = urllib.request.Request(probe, method="GET")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=6) as r:
            return {"reachable": r.status < 500, "status": r.status}
    except urllib.error.HTTPError as e:
        return {"reachable": e.code < 500, "status": e.code}
    except Exception as e:
        return {"reachable": False, "detail": str(e)}


class ExternalProbeBody(BaseModel):
    url: str
    token: Optional[str] = None
    health: Optional[str] = "/"


@router.post("/api/admin/external-services/test")
def admin_test_external(
    body: ExternalProbeBody,
    _: models.User = Depends(require_portal_admin),
):
    return _probe(body.url, body.token, body.health or "/")


class ServiceRegisterBody(BaseModel):
    name: str
    kind: str = "elog"
    mode: str = "managed"              # managed | external
    visibility: Optional[int] = None
    # Intake answers (capabilities + identity)
    accepts_portal_token: bool = False   # Q1 login → SSO
    multi_project: bool = False          # Q2 multi-project (model A: portal manages)
    import_export: bool = False          # Q8 import/export channel
    # managed
    start_cmd: Optional[str] = None
    start_cwd: Optional[str] = None
    start_env: Optional[dict] = None     # env mapping; values may use {project} etc.
    # external
    url: Optional[str] = None
    token: Optional[str] = None
    # both
    health: Optional[str] = "/"
    entry: Optional[str] = "/"
    link_by: str = "email"


@router.post("/api/admin/services", status_code=201)
def admin_register_service(
    body: ServiceRegisterBody,
    _: models.User = Depends(require_portal_admin),
    db: Session = Depends(get_db),
):
    """Unified registration for a managed OR external service. Captures the
    intake answers as manifest capabilities + identity (see AI_SERVICE_GUIDE)."""
    name = body.name.strip()
    if not registry.valid_name(name):
        raise HTTPException(400, "이름은 영문자·숫자·_·- 만 가능합니다 (1~64자)")
    if body.mode not in ("managed", "external"):
        raise HTTPException(400, "mode must be 'managed' or 'external'")
    if body.mode == "external" and not (body.url or "").strip():
        raise HTTPException(400, "external 서비스는 url이 필요합니다.")
    sdir = registry.service_dir(name)
    if sdir.exists():
        raise HTTPException(409, f"'{name}' 이미 존재합니다")

    manifest = {
        "kind": body.kind,
        "mode": body.mode,
        "health": body.health or "/",
        "entry": body.entry or "/",
        "identity": {"accepts_portal_token": body.accepts_portal_token, "link_by": body.link_by or "email"},
        # A project-creating (multi-project) service gets import/export by default.
        "capabilities": {"multi_project": body.multi_project,
                         "import_export": body.import_export or body.multi_project},
        "icon": None,
        "color": None,
    }
    if body.mode == "managed":
        manifest["start"] = {"cmd": (body.start_cmd or "uvicorn main:app"),
                             "cwd": (body.start_cwd or None), "env": (body.start_env or {})}
    else:
        manifest["url"] = body.url.strip()
        manifest["token"] = (body.token or None)

    sdir.mkdir(parents=True)
    if body.mode == "managed":
        (sdir / "uploads").mkdir(exist_ok=True)
    registry.write_manifest(name, manifest)

    svc = get_or_create_service(db, name, body.kind)
    if body.visibility in (VIS_PRIVATE, VIS_PROTECTED, VIS_ADMIN):
        svc.visibility = body.visibility
    db.commit()
    return {"name": name, "kind": body.kind, "mode": body.mode}


@router.delete("/api/admin/services/{name}")
def admin_remove_service(
    name: str,
    _: models.User = Depends(require_portal_admin),
    db: Session = Depends(get_db),
):
    """Remove a service (any mode) + its portal-DB rows. Managed services are
    stopped first; external ones just drop the registry entry."""
    sdir = registry.service_dir(name)
    if not sdir.exists():
        raise HTTPException(404, f"'{name}' 없음")
    from ..adapters import get_adapter
    manifest = registry.read_manifest(name)
    try:
        get_adapter(manifest).stop(name, manifest)
    except Exception:
        pass
    shutil.rmtree(sdir)
    registry.tombstone(name)                 # keep it gone across redeploys (no re-seed)
    db.query(Service).filter(Service.name == name).delete()
    db.query(ServicePermission).filter(ServicePermission.service_name == name).delete()
    db.query(AccessRequest).filter(AccessRequest.service_name == name).delete()
    db.commit()
    return {"deleted": name}


def _drop_service_rows(db: Session, name: str) -> None:
    db.query(Service).filter(Service.name == name).delete()
    db.query(ServicePermission).filter(ServicePermission.service_name == name).delete()
    db.query(AccessRequest).filter(AccessRequest.service_name == name).delete()
    db.commit()


@router.post("/api/admin/services/{name}/archive")
def admin_archive_service(
    name: str,
    _: models.User = Depends(require_portal_admin),
    db: Session = Depends(get_db),
):
    """Data-only delete: stop the service, drop its data, but keep its definition in
    the archive (보관함) so it can be restored or permanently deleted later."""
    if not registry.service_dir(name).exists():
        raise HTTPException(404, f"'{name}' 없음")
    from ..adapters import get_adapter
    manifest = registry.read_manifest(name)
    try:
        get_adapter(manifest).stop(name, manifest)
    except Exception:
        pass
    registry.archive_service(name)
    _drop_service_rows(db, name)
    return {"archived": name}


@router.get("/api/admin/archived")
def admin_list_archived(_: models.User = Depends(require_portal_admin)):
    out = []
    for n in registry.list_archived():
        m = registry.read_archived_manifest(n)
        out.append({"name": n, "label": m.get("label") or n, "icon": m.get("icon"),
                    "color": m.get("color"), "kind": m.get("kind")})
    return out


@router.post("/api/admin/archived/{name}/restore")
def admin_restore_service(name: str, _: models.User = Depends(require_portal_admin)):
    if name not in registry.list_archived():
        raise HTTPException(404, f"'{name}' 보관함에 없음")
    registry.restore_service(name)
    return {"restored": name}


@router.delete("/api/admin/archived/{name}")
def admin_purge_archived(name: str, _: models.User = Depends(require_portal_admin)):
    if name not in registry.list_archived():
        raise HTTPException(404, f"'{name}' 보관함에 없음")
    registry.purge_archived(name)
    return {"purged": name}
