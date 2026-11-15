"""
Project management for multi-project services (model A) + per-project proxy.

Endpoints live under `/api/services/{svc}/projects…`; entering a project goes
through `/pp/{svc}/{proj}/…` (the per-project reverse proxy). A service must be
`capabilities.multi_project` to have projects; import/export needs
`capabilities.import_export`.
"""
from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from .. import models, permissions, prefs, project_runtime as pr
from .. import registry, security
from ..db import SessionLocal, get_db
from ..deps import require_portal_admin, require_portal_user
from ..proxy_util import cookie_bearer, login_redirect_or_401, service_facts, stream_proxy

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


@router.get("/api/services/{svc}/projects/{proj}/log")
def project_log(svc: str, proj: str, lines: int = 400,
                _: models.User = Depends(require_portal_admin)):
    """Tail one project's captured stdout/stderr (data/<svc>/projects/<proj>/
    service.log, truncated each start). For a multi-project service this is the
    log that matters: each project is its own process, and the service-level
    file says nothing about any of them. Manager-only — it shows server paths
    and the service's own errors as they are."""
    _require_multi(svc)
    # Only a project that exists: the name is a path segment.
    if proj not in {p["name"] for p in pr.list_projects(svc)}:
        raise HTTPException(404, f"'{proj}' 없음")
    logp = pr.project_dir(svc, proj) / "service.log"
    try:
        text = pr.tail_text(logp, lines)
    except OSError as e:
        raise HTTPException(500, f"로그를 읽을 수 없습니다: {e}")
    return {"service": svc, "project": proj, "path": str(logp), "text": text}


class EntryProject(BaseModel):
    project: str = ""        # "" clears it


@router.put("/api/services/{svc}/entry")
def set_entry_project(svc: str, body: EntryProject,
                      user: models.User = Depends(require_portal_user),
                      db: Session = Depends(get_db)):
    """Nominate one project as this service's entrance FOR THIS ACCOUNT, or clear it.

    With it set, pressing the service on the cover opens that project rather
    than listing them. It is the account's own choice (prefs.entry): someone
    else pressing the same service still gets theirs — or the service's
    default entrance (manifest `entry_project`) when they have made none.
    Clearing it stores an empty choice, so the list shows even where the
    service has a default.
    """
    _require_multi(svc)
    want = (body.project or "").strip()
    if want and want not in {p["name"] for p in pr.list_projects(svc)}:
        raise HTTPException(404, f"'{want}' 없음")
    entry = dict(prefs.get(user).get("entry") or {})
    entry[svc] = want
    prefs.put(user, entry=entry)
    db.commit()
    return {"service": svc, "entry_project": want}


class LinkProject(BaseModel):
    project: str


def _project_names(svc: str) -> list[str]:
    root = registry.service_dir(svc) / "projects"
    return sorted(d.name for d in root.iterdir() if d.is_dir()) if root.is_dir() else []


def _dicts_in(svc: str, proj: str):
    """Every {…} inside the records stored in a project."""
    root = pr.project_dir(svc, proj) / "data"
    def inside(v):
        if isinstance(v, dict):
            yield v
            v = list(v.values())
        if isinstance(v, list):
            for x in v:
                yield from inside(x)
    for f in root.rglob("*.json"):
        if any(part.startswith(".") for part in f.relative_to(root).parts):
            continue                     # .trash, .history: not what a link is read from
        try:
            yield from inside(json.loads(f.read_text("utf-8")))
        except (OSError, ValueError):
            continue


@router.get("/api/services/{svc}/link-project/impact")
def link_project_impact(svc: str, _: models.User = Depends(require_portal_admin)):
    """What moving this service's link project leaves behind, to say before it is
    moved. Links are not rewritten: an id means nothing in another project.

      links_in   links elsewhere addressed to it: still open it, but their names
                 are looked up in the new one
      links_out  its own links to other services: the reverse lists there stop
                 showing them
      notes_by_title  (note) a note field holds only {id, title}: it finds a note
                 of that title in the new project, or offers to make one
    """
    _require_multi(svc)
    old = registry.link_project(svc)
    if not old:
        raise HTTPException(404, f"'{svc}' 는 다른 서비스와 연동하지 않습니다")
    links_in = links_out = by_title = 0
    for other in registry.link_projects():
        if other == svc:
            continue
        for proj in _project_names(other):
            for d in _dicts_in(other, proj):
                if d.get("svc") == svc and d.get("proj") == old and d.get("id"):
                    links_in += 1
                elif svc == "note" and set(d) == {"id", "title"}:
                    by_title += 1
    for d in _dicts_in(svc, old):
        if d.get("svc") not in (None, svc) and d.get("proj") and d.get("id"):
            links_out += 1
    return {"project": old, "links_in": links_in, "links_out": links_out, "notes_by_title": by_title}


@router.put("/api/services/{svc}/link-project")
def set_link_project(svc: str, body: LinkProject, _: models.User = Depends(require_portal_admin)):
    """Choose the one project the other services see. The whole service's, so a
    manager's — and it is `entry_project`, what an account with no entrance of
    its own opens too."""
    manifest = _require_multi(svc)
    if not registry.link_project(svc, manifest):
        raise HTTPException(400, f"'{svc}' 는 다른 서비스와 연동하지 않습니다")
    if body.project not in _project_names(svc):
        raise HTTPException(404, f"'{body.project}' 없음")
    manifest["entry_project"] = body.project
    registry.write_manifest(svc, manifest)
    return {"service": svc, "link_project": body.project}


class ShareSet(BaseModel):
    name: str
    members: dict[str, str]
    id: str = ""                    # kept across renames; a new set gets one when written


class ShareSets(BaseModel):
    sets: list[ShareSet]


def _racklist_service(svc: str) -> bool:
    m = registry.read_manifest(svc)
    return bool((m.get("capabilities") or {}).get("multi_project")) and (
        m.get("kind") == "rack" or bool((m.get("capabilities") or {}).get("tags")))


def _set_maker(user: models.User = Depends(require_portal_user), db: Session = Depends(get_db)) -> models.User:
    """A manager, or a project's admin: they may make a set from a template (and are
    made admin of the projects it creates)."""
    if permissions.is_admin(user) or permissions.has_any_admin(db, user.id):
        return user
    raise HTTPException(403, "세트는 매니저나 프로젝트 관리자가 만듭니다.")


@router.get("/api/share-sets")
def get_share_sets(_: models.User = Depends(_set_maker)):
    sets, stored = registry.share_sets()
    return {"sets": sets, "stored": stored}


@router.put("/api/share-sets")
def put_share_sets(body: ShareSets, _: models.User = Depends(require_portal_admin)):
    """Replace every set. A project may sit in one set only (a link from it must
    have one place to point), and only a rack service's real projects count."""
    names = set(registry.list_service_names())
    seen: dict[tuple[str, str], str] = {}
    out = []
    for st in body.sets:
        name = st.name.strip()
        if not name:
            raise HTTPException(400, "세트 이름이 비어 있습니다")
        for svc, proj in st.members.items():
            if svc not in names or not _racklist_service(svc):
                raise HTTPException(400, f"'{svc}' 는 rack 서비스가 아닙니다")
            if proj not in _project_names(svc):
                raise HTTPException(400, f"'{svc}/{proj}' 프로젝트가 없습니다")
            if (svc, proj) in seen:
                raise HTTPException(400, f"'{svc}/{proj}' 가 '{seen[(svc, proj)]}' 와 '{name}' 두 세트에 있습니다")
            seen[(svc, proj)] = name
        out.append({"name": name, "members": dict(st.members), **({"id": st.id} if st.id else {})})
    # A set sent without its id (a page that loaded before ids, or never took one back) keeps the id
    # the set of that name has: a new id each save would unbind its tokens and its sidebar group.
    had = {s.get("name"): s.get("id") for s in registry.share_sets()[0] if s.get("id")}
    used = {s["id"] for s in out if s.get("id")}
    for s in out:
        if not s.get("id") and had.get(s["name"]) and had[s["name"]] not in used:
            s["id"] = had[s["name"]]
    registry.write_share_sets(out)
    _sync_groups()
    return {"sets": registry.share_sets()[0], "stored": True}


@router.delete("/api/share-sets")
def reset_share_sets(_: models.User = Depends(require_portal_admin)):
    """Back to the sets the manifests give. A set that keeps its name keeps its id, so the
    sidebar group and the MCP tokens bound to it (by id) stay bound; the file is rewritten
    rather than removed for that reason."""
    ids = {s.get("name"): s.get("id") for s in registry.share_sets()[0] if s.get("id")}
    registry._share_file().unlink(missing_ok=True)
    sets = [{**s, **({"id": ids[s["name"]]} if s["name"] in ids else {})} for s in registry.default_share_sets()]
    if any(s.get("id") for s in sets):
        registry.write_share_sets(sets)
    _sync_groups()
    got, stored = registry.share_sets()
    return {"sets": got, "stored": stored}


# What a set is usually made of, so one is made in one go rather than service by service.
# ponytail: two shapes named here; a manager's own templates can live in share_sets.json when wanted.
SET_TEMPLATES = [
    {"name": "jobboard", "services": ["jobboard", "project_manager", "inbox", "parameters", "reference_manager", "note"]},
    {"name": "manage", "services": ["project_manager", "inbox", "academic_activities", "author_manager", "reference_manager",
                                    "note"]},
]
# Joined to a set but kept off the cover: project_manager holds the set's projects,
# which every service's tags tab shows and edits now, so its own card is not opened.
HIDDEN_IN_SETS = {"project_manager"}


def _sync_groups():
    from . import service_groups
    service_groups.sync_set_groups()
    _show_left()


@router.get("/api/share-sets/templates")
def share_set_templates(_: models.User = Depends(_set_maker)):
    """The shapes a set can be made from: the named templates."""
    have = set(registry.list_service_names())
    shapes = SET_TEMPLATES
    return [{**t, "services": [x for x in t["services"] if x in have and _racklist_service(x)]} for t in shapes]


class MakeSet(BaseModel):
    name: str
    services: list[str]
    project: str = ""


@router.post("/api/share-sets/make")
def make_share_set(body: MakeSet, user: models.User = Depends(_set_maker), db: Session = Depends(get_db)):
    """A set made, or filled up, in one go: for each service it lacks, a project
    (named `project`, else the set's name) is made where it does not exist yet
    and joined to the set. Members the set already has stay as they are."""
    import copy
    name = body.name.strip()
    proj = (body.project or name).strip()
    if not name or not registry.valid_name(proj):
        raise HTTPException(400, "세트 이름과, 영문자·숫자·_·- 로 된 프로젝트 이름이 필요합니다")
    sets = copy.deepcopy(registry.share_sets()[0])
    target = next((s for s in sets if s.get("name") == name), None)
    if target is None:
        target = {"name": name, "members": {}}
        sets.append(target)
    names = set(registry.list_service_names())
    todo = [svc for svc in dict.fromkeys(body.services) if svc not in target["members"]]
    for svc in todo:                 # everything checked before anything is made
        if svc not in names or not _racklist_service(svc):
            raise HTTPException(400, f"'{svc}' 는 rack 서비스가 아닙니다")
        owner = next((s["name"] for s in sets if (s.get("members") or {}).get(svc) == proj), None)
        if owner:
            raise HTTPException(400, f"'{svc}/{proj}' 는 이미 '{owner}' 세트에 있습니다")
    made = []
    if not permissions.is_admin(user) and target["members"]:
        # A project admin fills up only a set that is theirs: every project in it theirs to administer.
        if not all(permissions.is_project_admin(db, user, sv, pj) for sv, pj in target["members"].items()):
            raise HTTPException(403, f"'{name}' 세트의 프로젝트를 관리하지 않습니다.")
    for svc in todo:
        if proj not in _project_names(svc):
            pr.create_project(svc, proj)
            made.append(f"{svc}/{proj}")
            if not permissions.is_admin(user):
                db.add(models.ServicePermission(user_id=user.id, service_name=svc, project=proj, is_admin=True))
        target["members"][svc] = proj
    db.commit()
    registry.write_share_sets(sets)
    _sync_groups()
    _hide_joined([svc for svc in todo if svc in HIDDEN_IN_SETS])
    return {"sets": sets, "stored": True, "made": made, "joined": todo}


# ── A set's admins: every project of the set at once ─────────────────────────
# A manager, or someone who administers EVERY project of the set (the set is theirs),
# edits who administers it. Taking someone off keeps their way in, as Accounts does.
def _the_set(key: str) -> dict:
    s = next((x for x in registry.share_sets()[0] if key and key in (x.get("id"), x.get("name"))), None)
    if not s or not s.get("members"):
        raise HTTPException(404, "그런 세트가 없습니다.")
    return s


def _set_admin_ok(db: Session, user: models.User, st: dict) -> None:
    if not (permissions.is_admin(user) or all(permissions.is_project_admin(db, user, sv, pj)
                                             for sv, pj in st["members"].items())):
        raise HTTPException(403, "이 세트의 프로젝트를 모두 관리하는 사람만 고칠 수 있습니다.")


@router.get("/api/share-sets/admins")
def set_admins(set: str, user: models.User = Depends(require_portal_user), db: Session = Depends(get_db)):
    """The accounts, each with the set's projects they administer (directly, or by a group)."""
    st = _the_set(set)
    _set_admin_ok(db, user, st)
    members = {(sv, pj) for sv, pj in st["members"].items()}
    direct: dict[int, list] = {}
    for p in db.query(models.ServicePermission).filter(models.ServicePermission.is_admin.is_(True)).all():
        if (p.service_name, p.project or "") in members:
            direct.setdefault(p.user_id, []).append({"service": p.service_name, "project": p.project or None, "admin": True})
    gname = {g.id: g.name for g in db.query(models.Group).all()}
    ggrants: dict[int, list] = {}
    for p in db.query(models.GroupPermission).filter(models.GroupPermission.is_admin.is_(True)).all():
        if (p.service_name, p.project or "") in members:
            ggrants.setdefault(p.group_id, []).append({"service": p.service_name, "project": p.project or None, "group": gname.get(p.group_id)})
    inherited: dict[int, list] = {}
    for m in db.query(models.GroupMembership).all():
        inherited.setdefault(m.user_id, []).extend(ggrants.get(m.group_id, []))
    return [{"id": u.id, "username": u.username, "display_name": u.display_name, "role": u.role, "is_active": u.is_active,
             "admin_scopes": direct.get(u.id, []), "inherited_permissions": inherited.get(u.id, [])}
            for u in db.query(models.User).order_by(models.User.id).all() if u.is_active]


class SetAdmin(BaseModel):
    set: str
    user_id: int
    admin: bool


@router.post("/api/share-sets/admins")
def set_set_admin(body: SetAdmin, user: models.User = Depends(require_portal_user), db: Session = Depends(get_db)):
    st = _the_set(body.set)
    _set_admin_ok(db, user, st)
    if not db.get(models.User, body.user_id):
        raise HTTPException(404, "그런 계정이 없습니다.")
    # A set's admin may not take its last admin off (themselves included): only a manager could
    # then give the set back to anyone. A manager may.
    if not body.admin and not permissions.is_admin(user) and not any(
            u.id != body.user_id and all(permissions.is_project_admin(db, u, sv, pj) for sv, pj in st["members"].items())
            for u in db.query(models.User).filter(models.User.is_active == True, models.User.role != "manager").all()):  # noqa: E712
        raise HTTPException(409, "이 세트의 마지막 관리자는 내릴 수 없습니다. 먼저 다른 관리자를 두거나 매니저에게 맡기세요.")
    for sv, pj in st["members"].items():
        row = db.query(models.ServicePermission).filter_by(user_id=body.user_id, service_name=sv, project=pj).first()
        if row:
            row.is_admin = body.admin
        elif body.admin:
            db.add(models.ServicePermission(user_id=body.user_id, service_name=sv, project=pj, is_admin=True))
    db.commit()
    return {"ok": True}


def _hide_joined(svcs: list[str]) -> None:
    """Off the cover, as Manage → hide does (home.json hidden_services); a manager still
    sees it dimmed in manage mode and can show it again there."""
    if not svcs:
        return
    from . import home as _home
    hd = _home._read()
    hs = hd.setdefault("hidden_services", [])
    hs.extend(s for s in svcs if s not in hs)
    by = hd.setdefault("hidden_by_set", [])          # so leaving every set can show it again
    by.extend(s for s in svcs if s not in by)
    _home._write(hd)


def _show_left() -> None:
    """A service this hid when it joined a set (hidden_by_set) and that is in no set now
    goes back on the cover; one a manager hid by hand is not in that list and stays hidden."""
    from . import home as _home
    hd = _home._read()
    gone = [s for s in hd.get("hidden_by_set") or []
            if not any(s in (st.get("members") or {}) for st in registry.share_sets()[0])]
    if gone:
        hd["hidden_by_set"] = [s for s in hd["hidden_by_set"] if s not in gone]
        hd["hidden_services"] = [s for s in hd.get("hidden_services") or [] if s not in gone]
        _home._write(hd)


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
    # The other services read this one: every link and tag to it would go dark.
    if proj == registry.link_project(svc):
        raise HTTPException(409, f"'{proj}' 는 대표 프로젝트입니다. 다른 프로젝트를 대표로 지정한 뒤 지우세요.")
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
    proj_name = (name or "").strip()
    if not proj_name:
        # Export names the file `<svc>-<proj>.zip`; take the project back out of it
        # so a round trip keeps the name (else `note` comes back as `note-note`).
        proj_name = Path(file.filename or "imported").stem.strip()
        if proj_name.startswith(f"{svc}-") and len(proj_name) > len(svc) + 1:
            proj_name = proj_name[len(svc) + 1:]
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
    from .proxy import _block_if_mirror, machine_caller
    _block_if_mirror(request, svc, proj)         # mirrored copy → reads only
    db = SessionLocal()
    try:
        user = permissions.user_at_proxy(db, request)
        if not user:
            # Same service-to-service path as /p/ — this is the one a remote DAQ
            # actually needs, since a run boundary is pushed to a PROJECT.
            if machine_caller(request, registry.read_manifest(svc)):
                return
            raise login_redirect_or_401(request)
        if not permissions.can_enter_project(db, user, svc, proj):
            if not permissions.verification_current(user):
                raise HTTPException(403, "이메일 재인증이 필요합니다 (연 1회).")
            raise HTTPException(403, "이 프로젝트에 대한 권한이 없습니다.")
    finally:
        db.close()


# A service renamed in place: its old address (a bookmark, a tab a page kept, an
# account's recent list) goes to the new one. {old service: (service, project)}.
RENAMED = {"jobbook": ("jobboard", "jobboard")}


@router.api_route("/pp/{svc}/{proj}/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def project_proxy(svc: str, proj: str, path: str, request: Request):
    if svc in RENAMED and not registry.service_dir(svc).exists():
        from fastapi.responses import RedirectResponse
        nsvc, nproj = RENAMED[svc]
        q = f"?{request.url.query}" if request.url.query else ""
        return RedirectResponse(f"/pp/{nsvc}/{nproj}/{path}{q}", status_code=307)   # 307 keeps the method and body
    _require_multi(svc)
    # Guard hits SQLite synchronously — run it off the event loop (see proxy.py).
    await run_in_threadpool(_proxy_guard, request, svc, proj)
    try:
        base = await run_in_threadpool(pr.target_base, svc, proj)
    except FileNotFoundError:
        raise HTTPException(404, f"'{svc}/{proj}' 프로젝트가 없습니다")
    if not base:
        raise HTTPException(502, f"'{svc}/{proj}' is not reachable")
    qs = request.url.query
    target = f"{base}/{path}" + (f"?{qs}" if qs else "")
    fwd = {}
    for h in ("authorization", "content-type", "accept",
              # Cache validators and ranges, so a build the browser already holds
              # is answered 304 instead of sent again (2.6 MB of script, 2 MB of
              # fonts, on every opening of a service).
              "if-none-match", "if-modified-since", "if-range", "range"):
        if h in request.headers:
            fwd[h] = request.headers[h]
    manifest = registry.read_manifest(svc)
    ident = manifest.get("identity") or {}
    carried = cookie_bearer(
        request, ident.get("accepts_portal_token", manifest.get("mode") == "managed"))
    if carried:
        fwd["authorization"] = carried
    return await stream_proxy(request, target, fwd, html_base=f"/pp/{svc}/{proj}",
                              service=service_facts(svc, registry.read_manifest(svc), proj))
