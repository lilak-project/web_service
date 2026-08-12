"""
Project management for multi-project services (model A) + per-project proxy.

Endpoints live under `/api/services/{svc}/projects…`; entering a project goes
through `/pp/{svc}/{proj}/…` (the per-project reverse proxy). A service must be
`capabilities.multi_project` to have projects; import/export needs
`capabilities.import_export`.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from .. import models, permissions, project_runtime as pr
from .. import registry, security
from ..db import SessionLocal, get_db
from ..deps import require_portal_admin, require_portal_user
from ..proxy_util import login_redirect_or_401, stream_proxy

router = APIRouter(tags=["project-management"])


def _require_enter(db: Session, user: models.User, svc: str, proj: str) -> None:
    """403 unless the caller may enter this project (admin, or a current grant)."""
    if not permissions.can_enter_project(db, user, svc, proj):
        if not permissions.verification_current(user):
            raise HTTPException(403, "이메일 재인증이 필요합니다 (연 1회). 인증 후 입장할 수 있습니다.")
        raise HTTPException(403, "이 프로젝트에 대한 권한이 없습니다.")


def _require_multi(svc: str) -> dict:
    if not registry.service_dir(svc).exists():
        raise HTTPException(404, f"'{svc}' 서비스 없음")
    manifest = registry.read_manifest(svc)
    caps = manifest.get("capabilities") or {}
    if not caps.get("multi_project"):
        raise HTTPException(400, f"'{svc}' is not a multi-project service")
    return manifest


def _require_import_export(svc: str):
    caps = (registry.read_manifest(svc).get("capabilities") or {})
    if not caps.get("import_export"):
        raise HTTPException(400, f"'{svc}' does not support import/export")


@router.get("/api/services/{svc}/projects")
def list_projects(svc: str, user: models.User = Depends(require_portal_user),
                 db: Session = Depends(get_db)):
    _require_multi(svc)
    admin = permissions.is_admin(user)

    # Visibility guard: a non-admin may list a service's projects only if they can
    # see the service — admin-tier is hidden, private needs some grant, protected
    # is open (so they can browse + request individual projects).
    row = db.query(models.Service).filter(models.Service.name == svc).first()
    vis = row.visibility if row else models.DEFAULT_VISIBILITY
    if not admin:
        if vis == models.VIS_ADMIN:
            raise HTTPException(404, "서비스를 찾을 수 없습니다.")
        if vis == models.VIS_PRIVATE and not permissions.has_any_grant(db, user.id, svc):
            raise HTTPException(404, "서비스를 찾을 수 없습니다.")

    svc_grant = admin or permissions.has_service_grant(db, user.id, svc)
    proj_grants = set() if admin else permissions.project_grants(db, user.id, svc)
    enter_ok = admin or permissions.verification_current(user)
    out = []
    for p in pr.list_projects(svc):
        proj = p["name"]
        has_grant = svc_grant or proj in proj_grants
        enter = admin or (has_grant and enter_ok)
        can_req = (not admin) and (not has_grant)
        out.append({
            **p,
            "can_enter": enter,
            "can_request": can_req,
            "requested": (can_req and _pending_proj(db, user.id, svc, proj)),
            "view_only": (has_grant and not enter),     # has access but verification lapsed
        })
    return out


def _pending_proj(db: Session, user_id: int, svc: str, proj: str) -> bool:
    return db.query(models.AccessRequest).filter(
        models.AccessRequest.user_id == user_id,
        models.AccessRequest.service_name == svc,
        models.AccessRequest.project == proj,
        models.AccessRequest.status == "pending",
    ).first() is not None


class NewProject(BaseModel):
    name: str


@router.post("/api/services/{svc}/projects", status_code=201)
def create_project(svc: str, body: NewProject,
                  _: models.User = Depends(require_portal_admin)):
    _require_multi(svc)
    try:
        return pr.create_project(svc, body.name.strip())
    except ValueError as e:
        raise HTTPException(400, str(e))
    except FileExistsError:
        raise HTTPException(409, f"'{body.name}' 이미 존재합니다")


class RenameProject(BaseModel):
    name: str


@router.put("/api/services/{svc}/projects/{proj}/name")
def rename_project(svc: str, proj: str, body: RenameProject,
                  user: models.User = Depends(require_portal_user),
                  db: Session = Depends(get_db)):
    """Set a project's display name (the folder/URL id is unchanged). Anyone who
    can enter the project may rename it — e.g. asset_manager pushes its in-app
    rename here so the portal shows the same name."""
    _require_multi(svc)
    _require_enter(db, user, svc, proj)
    try:
        label = pr.set_label(svc, proj, body.name)
    except FileNotFoundError:
        raise HTTPException(404, f"'{proj}' 없음")
    return {"name": proj, "label": label or None}


@router.post("/api/services/{svc}/projects/{proj}/start")
def start_project(svc: str, proj: str, user: models.User = Depends(require_portal_user),
                 db: Session = Depends(get_db)):
    _require_multi(svc)
    _require_enter(db, user, svc, proj)
    try:
        return {"name": proj, **pr.start_project(svc, proj)}
    except FileNotFoundError:
        raise HTTPException(404, f"'{proj}' 없음")
    except RuntimeError as e:
        raise HTTPException(500, str(e))


@router.post("/api/services/{svc}/projects/{proj}/stop")
def stop_project(svc: str, proj: str, user: models.User = Depends(require_portal_user),
                db: Session = Depends(get_db)):
    _require_multi(svc)
    _require_enter(db, user, svc, proj)
    return pr.stop_project(svc, proj)


@router.delete("/api/services/{svc}/projects/{proj}")
def delete_project(svc: str, proj: str, _: models.User = Depends(require_portal_admin),
                   db: Session = Depends(get_db)):
    _require_multi(svc)
    try:
        result = pr.delete_project(svc, proj)
    except FileNotFoundError:
        raise HTTPException(404, f"'{proj}' 없음")
    # Drop this project's per-project grants + pending requests. Otherwise creating a
    # NEW project with the same name later would silently re-grant everyone who had
    # access to the old one (permissions key on the name string, not identity).
    db.query(models.ServicePermission).filter(
        models.ServicePermission.service_name == svc,
        models.ServicePermission.project == proj,
    ).delete()
    db.query(models.AccessRequest).filter(
        models.AccessRequest.service_name == svc,
        models.AccessRequest.project == proj,
    ).delete()
    db.commit()
    return result


@router.get("/api/services/{svc}/projects/{proj}/export")
def export_project(svc: str, proj: str, _: models.User = Depends(require_portal_admin)):
    _require_multi(svc)
    _require_import_export(svc)
    try:
        data = pr.export_project(svc, proj)
    except FileNotFoundError:
        raise HTTPException(404, f"'{proj}' 없음")
    return Response(content=data, media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="{proj}.zip"'})


@router.post("/api/services/{svc}/projects/import", status_code=201)
async def import_project(svc: str, file: UploadFile = File(...), name: str | None = Form(None),
                        _: models.User = Depends(require_portal_admin)):
    _require_multi(svc)
    _require_import_export(svc)
    raw = await file.read()
    proj_name = (name or Path(file.filename or "imported").stem).strip()
    try:
        return pr.import_project(svc, raw, proj_name)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except FileExistsError:
        raise HTTPException(409, f"'{proj_name}' 이미 존재합니다")


# ── Per-project reverse proxy: /pp/{svc}/{proj}/… → that project's instance ────
def _proxy_guard(request: Request, svc: str, proj: str) -> None:
    """Enforce enter-permission on the project proxy. A top-level navigation has
    no Authorization header, so the token is read from the `lilak_portal_token`
    cookie (set by the frontend on login) or the header when present."""
    from .proxy import _block_if_mirror
    _block_if_mirror(request, svc)               # mirrored copy → reads only
    token = security.bearer(request.headers.get("authorization")) or request.cookies.get("lilak_portal_token")
    db = SessionLocal()
    try:
        user = permissions.user_from_request(db, token)
        if not user:
            raise login_redirect_or_401(request)
        if not permissions.can_enter_project(db, user, svc, proj):
            if not permissions.verification_current(user):
                raise HTTPException(403, "이메일 재인증이 필요합니다 (연 1회).")
            raise HTTPException(403, "이 프로젝트에 대한 권한이 없습니다.")
    finally:
        db.close()


@router.api_route("/pp/{svc}/{proj}/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def project_proxy(svc: str, proj: str, path: str, request: Request):
    _require_multi(svc)
    # Guard hits SQLite synchronously — run it off the event loop (see proxy.py).
    await run_in_threadpool(_proxy_guard, request, svc, proj)
    base = await run_in_threadpool(pr.target_base, svc, proj)
    if not base:
        raise HTTPException(502, f"'{svc}/{proj}' is not reachable")
    qs = request.url.query
    target = f"{base}/{path}" + (f"?{qs}" if qs else "")
    fwd = {}
    for h in ("authorization", "content-type", "accept"):
        if h in request.headers:
            fwd[h] = request.headers[h]
    return await stream_proxy(request, target, fwd, html_base=f"/pp/{svc}/{proj}")
