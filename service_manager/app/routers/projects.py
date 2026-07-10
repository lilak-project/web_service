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

from .. import registry
from ..adapters import get_adapter
from ..deps import require_portal_admin, require_portal_user

router = APIRouter(tags=["services-lifecycle"])


def raw_service(name: str) -> dict:
    """One service's launcher-level view: status (via its adapter) + cosmetics."""
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
        "import_export": bool(caps.get("import_export")),
        "order": manifest.get("order", 1000),      # admin-set display order (manage mode)
    }


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


@router.post("/api/projects/{name}/start")
def api_start(name: str, _admin=Depends(require_portal_admin)):
    if not registry.valid_name(name):
        raise HTTPException(400, "잘못된 서비스 이름")
    if not registry.service_dir(name).exists():
        raise HTTPException(404, f"'{name}' 없음")
    manifest = registry.read_manifest(name)
    try:
        st = get_adapter(manifest).start(name, manifest)
    except (FileNotFoundError, RuntimeError) as e:
        raise HTTPException(500, str(e))
    return {"name": name, **st}


@router.post("/api/projects/{name}/stop")
def api_stop(name: str, _admin=Depends(require_portal_admin)):
    if not registry.valid_name(name):
        raise HTTPException(400, "잘못된 서비스 이름")
    if not registry.service_dir(name).exists():
        raise HTTPException(404, f"'{name}' 없음")
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
