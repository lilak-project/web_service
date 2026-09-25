"""
Service lifecycle — `/api/projects*` (kept name-compatible with the elog portal
frontend). Generic over kind/mode via the manifest + adapter; export/import move
a service's whole data dir as one zip.
"""
from __future__ import annotations

import io
import shutil
import zipfile
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from sqlalchemy.orm import Session

from .. import config, models, permissions, registry
from ..adapters import get_adapter
from ..db import get_db
from ..deps import require_portal_admin, require_portal_user

router = APIRouter(tags=["services-lifecycle"])


def raw_service(name: str) -> dict:
    """One service's launcher-level view: status (via its adapter) + cosmetics."""
    from .. import gitinfo
    manifest = registry.read_manifest(name)
    adapter = get_adapter(manifest)
    st = adapter.status(name, manifest)
    caps = manifest.get("capabilities") or {}
    return {
        "name": name,
        "label": manifest.get("label"),     # optional display name (id stays the URL key)
        "kind": manifest.get("kind"),
        "mode": manifest.get("mode"),
        "running": st.get("running", False),
        "port": st.get("port"),
        "url": st.get("url"),
        "icon": manifest.get("icon"),
        "color": manifest.get("color"),
        "multi_project": bool(caps.get("multi_project")),
        # How the cover opens it: "panel" (inside the portal, in an iframe) or
        # "window" (its own tab). A multi-project service brings its own top bar,
        # command bar and drawer, which read as a second set of chrome inside a
        # panel — so those default to a window unless the manifest says otherwise.
        "open": (manifest.get("open")
                 or ("window" if caps.get("multi_project") else "panel")),
        # Shown on the sidebar card as `(4)`. A directory count, not list_projects():
        # that also probes each project's port, which is far too much for a label.
        "projects_count": (
            sum(1 for d in (config.DATA_ROOT / name / "projects").iterdir() if d.is_dir())
            if caps.get("multi_project") and (config.DATA_ROOT / name / "projects").is_dir()
            else None),
        "import_export": bool(caps.get("import_export")),
        "order": manifest.get("order", 1000),      # admin-set display order (manage mode)
        "autostart": bool(manifest.get("autostart")),   # portal brings it up on ITS start
        # Answers GET /api/live with a few compact numbers for the cover's live mode.
        "live": bool(manifest.get("live")),
        # Taken off this portal's cover in manage mode (data/_portal/home.json).
        "hidden": name in _hidden_services(),
        "live_hidden": name in _live_hidden(),
        "version": gitinfo.service_version((manifest.get("start") or {}).get("cwd")),  # {sha,date}|null
    }


def _hidden_services() -> set[str]:
    from .home import hidden_services
    return hidden_services()


def _live_hidden() -> set[str]:
    from .home import live_hidden
    return live_hidden()


def list_raw_services() -> list[dict]:
    # Sort by the admin-set order (manage mode), then name for stability.
    return sorted((raw_service(n) for n in registry.list_service_names()),
                  key=lambda s: (s.get("order", 1000), s["name"]))


@router.get("/api/projects")
def api_projects(_user=Depends(require_portal_user)):
    return list_raw_services()


class NewProject(BaseModel):
    name: str
    kind: str = "elog"
    icon: str | None = None
    color: str | None = None


@router.post("/api/projects", status_code=201)
def api_create(body: NewProject, _admin=Depends(require_portal_admin)):
    name = body.name.strip()
    if not registry.valid_name(name):
        raise HTTPException(400, "영문자·숫자·_·- 만 가능합니다 (1~64자)")
    sdir = registry.service_dir(name)
    if sdir.exists():
        raise HTTPException(409, f"'{name}' 이미 존재합니다")
    sdir.mkdir(parents=True)
    (sdir / "uploads").mkdir(exist_ok=True)
    manifest = registry.default_manifest(body.kind)
    manifest["icon"] = body.icon
    manifest["color"] = body.color
    registry.write_manifest(name, manifest)
    return {"name": name, "kind": body.kind, "icon": body.icon, "color": body.color}



def _require_enter(db: Session, user: models.User, name: str) -> None:
    """403 unless the caller may enter this service (project="" = whole service).

    Deliberately NOT admin-only. A permitted user can already cause a start just
    by opening `/p/<name>/` — the proxy's target_base boots an idle service on
    demand and gates only on this same permission — so requiring `manager` here
    made the button fail for exactly the people the proxy lets through, and made a
    single service behave unlike a project (project_mgmt.start_project has always
    used this check).
    """
    if not permissions.can_enter_project(db, user, name, ""):
        if not permissions.verification_current(user):
            raise HTTPException(403, "이메일 재인증이 필요합니다 (연 1회). 인증 후 입장할 수 있습니다.")
        raise HTTPException(403, "이 서비스에 대한 권한이 없습니다.")


@router.post("/api/projects/{name}/start")
def api_start(name: str, user: models.User = Depends(require_portal_user),
              db: Session = Depends(get_db)):
    if not registry.valid_name(name):
        raise HTTPException(400, "잘못된 서비스 이름")
    if not registry.service_dir(name).exists():
        raise HTTPException(404, f"'{name}' 없음")
    _require_enter(db, user, name)
    manifest = registry.read_manifest(name)
    try:
        st = get_adapter(manifest).start(name, manifest)
    except (FileNotFoundError, RuntimeError) as e:
        raise HTTPException(500, str(e))
    return {"name": name, **st}


@router.post("/api/projects/{name}/stop")
def api_stop(name: str, user: models.User = Depends(require_portal_user),
             db: Session = Depends(get_db)):
    # Same rule as start, and the same rule a project's stop already uses.
    if not registry.valid_name(name):
        raise HTTPException(400, "잘못된 서비스 이름")
    if not registry.service_dir(name).exists():
        raise HTTPException(404, f"'{name}' 없음")
    _require_enter(db, user, name)
    manifest = registry.read_manifest(name)
    return get_adapter(manifest).stop(name, manifest)


@router.delete("/api/projects/{name}")
def api_delete(name: str, _admin=Depends(require_portal_admin)):
    if not registry.valid_name(name):
        raise HTTPException(400, "잘못된 서비스 이름")
    sdir = registry.service_dir(name)
    if not sdir.exists():
        raise HTTPException(404, f"'{name}' 없음")
    manifest = registry.read_manifest(name)
    try:                                  # stop a managed service before removal
        get_adapter(manifest).stop(name, manifest)
    except Exception:
        pass
    shutil.rmtree(sdir)
    registry.tombstone(name)                 # keep it deleted across redeploys
    return {"deleted": name}


# ── Export / Import — the whole data dir as one .zip ──────────────────────────
@router.get("/api/projects/{name}/export")
def api_export(name: str, _admin=Depends(require_portal_admin)):
    if not registry.valid_name(name):
        raise HTTPException(400, "잘못된 서비스 이름")
    sdir = registry.service_dir(name)
    if not sdir.exists():
        raise HTTPException(404, f"'{name}' 없음")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(sdir.rglob("*")):
            if f.is_file() and f.name != ".port":   # .port is runtime-only
                z.write(f, f.relative_to(sdir))
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{name}.zip"'},
    )


@router.post("/api/projects/import", status_code=201)
async def api_import(file: UploadFile = File(...), name: str | None = Form(None),
                     _admin=Depends(require_portal_admin)):
    raw = await file.read()
    proj_name = (name or Path(file.filename or "imported").stem).strip()
    if not registry.valid_name(proj_name):
        raise HTTPException(400, "이름은 영문자·숫자·_·- 만 가능합니다 (1~64자)")
    sdir = registry.service_dir(proj_name)
    if sdir.exists():
        raise HTTPException(409, f"'{proj_name}' 이미 존재합니다")
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        raise HTTPException(400, "올바른 .zip 파일이 아닙니다")
    sdir.mkdir(parents=True)
    root = sdir.resolve()
    for member in zf.namelist():
        dest = (sdir / member).resolve()
        if not str(dest).startswith(str(root)):     # zip-slip guard
            continue
        if member.endswith("/"):
            dest.mkdir(parents=True, exist_ok=True)
        else:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(zf.read(member))
    (sdir / "uploads").mkdir(exist_ok=True)
    (sdir / ".port").unlink(missing_ok=True)        # never import a stale port
    registry.clear_tombstone(proj_name)             # re-importing un-deletes the name
    return {"name": proj_name}
