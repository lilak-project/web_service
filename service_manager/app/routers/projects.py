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

from .. import config, models, permissions, prefs, registry
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
        # A multi-project service can nominate ONE project as its entrance: the
        # cover then opens that project straight from the card, with no list in
        # between. The projects are all still there in manage mode — this says
        # which one a press means, not that the others are gone.
        "entry_project": manifest.get("entry_project") or "",
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
        # Shares its tags (GET /api/tags on its entry project): the rack services
        # and note offer each other's tags as you type one.
        "tags": bool(caps.get("tags")),
        "order": manifest.get("order", 1000),      # admin-set display order (manage mode)
        "autostart": bool(manifest.get("autostart")),   # portal brings it up on ITS start
        # Answers GET /api/live with a few compact numbers for the cover's live mode.
        "live": bool(manifest.get("live")),
        # Taken off this portal's cover in manage mode (data/_portal/home.json).
        "hidden": name in _hidden_services(),
        "live_hidden": name in _live_hidden(),
        "live_public": name in _live_public(),
        "version": gitinfo.service_version((manifest.get("start") or {}).get("cwd")),  # {sha,date}|null
    }


def _hidden_services() -> set[str]:
    from .home import hidden_services
    return hidden_services()


def _live_public() -> set[str]:
    from .home import live_public
    return live_public()


def _live_hidden() -> set[str]:
    from .home import live_hidden
    return live_hidden()


def list_raw_services() -> list[dict]:
    # Sort by the admin-set order (manage mode), then name for stability.
    return sorted((raw_service(n) for n in registry.list_service_names()),
                  key=lambda s: (s.get("order", 1000), s["name"]))


@router.get("/api/projects")
def api_projects(user=Depends(require_portal_user), db: Session = Depends(get_db)):
    # Which project a card opens straight away is each account's own choice
    # (prefs.entry), falling back to the service's default entrance.
    rows = list_raw_services()
    if not permissions.is_admin(user):
        # Only what /api/services shows this user — not hidden or admin-only ones.
        from .services import list_services
        seen = {s["name"] for s in list_services(user, db)}
        rows = [r for r in rows if r["name"] in seen]
    return prefs.with_entries(user, rows)


@router.get("/api/public-services")
def api_public_services(db: Session = Depends(get_db)):
    """The services a visitor may see BEFORE signing in — the signed-out cover
    lists these beside the login card.

    No auth on purpose, so it carries the bare minimum: a name, what it is
    called, its mark. Nothing here says who may enter or how to reach it, and a
    service is only in this list because an admin set its visibility to PUBLIC
    — the default is PROTECTED, so an untouched portal returns [].
    """
    public = {s.name for s in db.query(models.Service)
              .filter(models.Service.visibility == models.VIS_PUBLIC).all()}
    if not public:
        return []
    return [{k: s.get(k) for k in ("name", "label", "icon", "color", "kind",
                                   "multi_project", "open", "order")}
            for s in list_raw_services() if s["name"] in public]


# ── the live wall for visitors (signed out) ───────────────────────────────────
_PUBLIC_LIVE_CACHE: dict = {}


def _public_live_names() -> list[dict]:
    from .home import hidden_services
    out = []
    for s in list_raw_services():
        if s.get("live") and s.get("live_public") and not s.get("live_hidden") and s["name"] not in hidden_services():
            out.append(s)
    return out


@router.get("/api/public-live")
def api_public_live():
    """The cards a visitor's live wall shows: only services a manager opened
    to the signed-out wall (Manage → the service → Live wall). Name and mark,
    nothing about who may enter."""
    return [{k: s.get(k) for k in ("name", "label", "icon", "color", "multi_project")} | {"live": True, "public_live": True}
            for s in _public_live_names()]


@router.get("/api/public-live/{name}")
def api_public_live_one(name: str):
    """That service's live numbers, fetched by the portal on the visitor's
    behalf — the same `/api/live` answer a signed-in wall gets, for what is
    already running (nothing is started for an anonymous viewer). Cached a
    few seconds so a wall left open on many screens costs one request."""
    import json as _json
    import time
    import urllib.request
    if name not in {s["name"] for s in _public_live_names()}:
        raise HTTPException(404, "공개된 라이브가 아닙니다.")
    hit = _PUBLIC_LIVE_CACHE.get(name)
    if hit and time.time() - hit[0] < 3:
        return hit[1]
    manifest = registry.read_manifest(name)
    adapter = get_adapter(manifest)

    def ask(base, headers=None):
        req = urllib.request.Request(f"{base.rstrip('/')}/api/live", headers=headers or {})
        with urllib.request.urlopen(req, timeout=5) as r:
            return _json.loads(r.read())
    items, note, layout = [], None, None
    if (manifest.get("capabilities") or {}).get("multi_project"):
        from .. import project_runtime as pr
        for p in pr.list_projects(name):
            if not p.get("port"):
                continue
            try:
                d = ask(f"http://127.0.0.1:{p['port']}")
                items += [{**it, "label": f"{p['name']} · {it.get('label', '')}"} for it in d.get("items") or []]
            except Exception:                    # noqa: BLE001 — a project with nothing to say
                pass
    else:
        if not adapter.status(name, manifest).get("running"):
            out = {"items": [], "note": None}
            _PUBLIC_LIVE_CACHE[name] = (time.time(), out)
            return out
        try:
            d = ask(adapter.target_base(name, manifest), adapter.proxy_headers(manifest))
            items, note, layout = d.get("items") or [], d.get("note"), d.get("layout")
        except Exception:                        # noqa: BLE001
            pass
    out = {"items": items, "note": note, "layout": layout}
    _PUBLIC_LIVE_CACHE[name] = (time.time(), out)
    return out


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
        if not dest.is_relative_to(root):            # zip-slip guard
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
