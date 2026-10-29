"""
Cross-portal service sync — mirror a service's project data (main → sub).

main side  (token-authed, no portal account involved):
  GET /api/sync/{svc}/projects              → project list
  GET /api/sync/{svc}/projects/{p}/manifest → {relpath: {size, sha256}}
  GET /api/sync/{svc}/projects/{p}/file     → one file's transfer bytes
  GET /api/sync/{svc}/projects/{p}/export   → the whole project as a .zip
  GET /api/sync/{svc}/grants                → who may use it, by (username, email)

sub side (portal admin):
  GET/PUT /api/admin/services/{svc}/sync     → read/write the local sync config
  POST    /api/admin/services/{svc}/sync/run → pull every project from main
  POST    /api/admin/services/{svc}/sync/grants[?apply] → preview/apply main's grants
  POST    /api/admin/services/{svc}/sync/rotate → new token (main only)

Only the files whose hash differs are fetched, so an unchanged project costs
nothing. Permissions move ONLY via the explicit grants call — never as a side
effect of a data sync.

A sub with interval_min > 0 is also pulled automatically by a background poller.

Two-way (a sub with two_way, a main with accept_push): the sub still drives —
main never has to reach it — but it also PUSHES. It remembers what the two
copies held when they last agreed (data/<svc>/.sync-base/<project>/), so a file
changed on one side only goes to the other, and a file changed on both is merged
(app/sync_merge.py). For file-per-record services only: a project holding a
database is skipped, since two SQLite files cannot be merged.
  PUT/DELETE /api/sync/{svc}/projects/{p}/file?path=&if_sha=   (main, token + accept_push)

The sub PULLS: main never needs to reach the sub, so only the sub has to know a
URL + token and only main has to be reachable. Projects that exist on the sub but
not on main are LEFT ALONE — a mirror adds and replaces, it does not delete.
"""
from __future__ import annotations

import os
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel

from .. import config, models, project_runtime as pr, registry, security, sync, sync_merge
from ..db import get_db
from ..deps import require_portal_admin

router = APIRouter(tags=["portal-sync"])

# Every request to another portal says who it is. A portal behind Cloudflare
# answers Python's default "Python-urllib/x.y" with 403 (error 1010, a bot
# signature) before the portal ever sees it.
UA = {"User-Agent": "lilak-portal-sync/1"}

_jobs: dict[str, dict] = {}
_lock = threading.Lock()
_busy: set[str] = set()          # services with a pull in flight
_scheduler_started = False


def _set(job_id: str, **kw) -> None:
    with _lock:
        _jobs[job_id].update(kw)


def _log(job_id: str, msg: str) -> None:
    with _lock:
        _jobs[job_id]["log"].append(msg)


# ── main side: serve snapshots to a paired sub ────────────────────────────────
def _scope(svc: str, authorization: Optional[str]) -> tuple:
    if not registry.service_dir(svc).exists():
        raise HTTPException(404, "서비스를 찾을 수 없습니다.")
    sc = sync.scope(svc, security.bearer(authorization))
    if sc is None:
        raise HTTPException(401, "동기화 토큰이 올바르지 않습니다.")
    return sc


def _require_sync_token(svc: str, authorization: Optional[str], proj: str) -> None:
    """The token must open this project. One it does not open is answered as
    absent, so a project's token cannot probe for the others."""
    if (proj and not registry.valid_name(proj)) or not sync.allows(_scope(svc, authorization), proj):
        raise HTTPException(404, f"'{proj}' 없음")


def _listed(svc: str, sc: tuple) -> list[str]:
    return [p["name"] for p in pr.list_projects(svc) if sync.allows(sc, p["name"])]


@router.get("/api/sync/{svc}/projects")
def sync_projects(svc: str, authorization: Optional[str] = Header(default=None)):
    return {"service": svc, "projects": _listed(svc, _scope(svc, authorization))}


@router.get("/api/sync/{svc}/stamps")
def sync_stamps(svc: str, authorization: Optional[str] = Header(default=None)):
    """{project: stamp} — what a live mirror polls every few seconds. Stat-only
    on this side, so polling it is cheap however large the projects are."""
    out = {}
    for n in _listed(svc, _scope(svc, authorization)):
        try:
            out[n] = pr.project_stamp(svc, n)
        except FileNotFoundError:
            pass
    return {"service": svc, "stamps": out}


@router.get("/api/sync/{svc}/projects/{proj}/manifest")
def sync_manifest(svc: str, proj: str, shared: int = 0,
                  authorization: Optional[str] = Header(default=None)):
    """`shared=1`: only what two-way sync moves — a server's bookkeeping is
    not even hashed."""
    _require_sync_token(svc, authorization, proj)
    try:
        return pr.project_manifest(svc, proj, skip=sync_merge.local_only if shared else None)
    except FileNotFoundError:
        raise HTTPException(404, f"'{proj}' 없음")


# ── main side: writes from a two-way sub ─────────────────────────────────────
_write_lock = threading.Lock()


def _sha(p) -> str:
    import hashlib
    return hashlib.sha256(pr.file_bytes(p)).hexdigest() if p.is_file() else ""


def _writable(svc: str, proj: str, rel: str, authorization: Optional[str]):
    """The file a sub may write: inside the project, not this server's own
    bookkeeping, not a database."""
    _require_sync_token(svc, authorization, proj)
    if not sync.accepts_push(svc, proj):
        raise HTTPException(403, "이 main 은 다른 서버의 쓰기를 받지 않습니다 (양방향 꺼짐).")
    if not registry.valid_name(proj) or not rel or sync_merge.local_only(rel) or rel.endswith(_DB_EXT):
        raise HTTPException(400, "이 파일은 동기화로 쓸 수 없습니다.")
    d = pr.project_dir(svc, proj).resolve()
    p = (d / rel).resolve()
    if p == d or not p.is_relative_to(d):
        raise HTTPException(400, "프로젝트 밖의 경로입니다.")
    return p


@router.put("/api/sync/{svc}/projects/{proj}/file")
async def sync_put_file(svc: str, proj: str, path: str, request: Request, if_sha: str = "",
                        authorization: Optional[str] = Header(default=None)):
    """Write one file — only if it is still what the sub last saw here
    (`if_sha`, '' = absent). Otherwise 409, and the sub merges again next round."""
    p = _writable(svc, proj, path, authorization)
    raw = await request.body()
    with _write_lock:
        if _sha(p) != if_sha:
            raise HTTPException(409, "그 사이 바뀌었습니다.")
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(p.name + ".sync-tmp")
        tmp.write_bytes(raw)
        os.replace(tmp, p)
    return {"ok": True}


@router.delete("/api/sync/{svc}/projects/{proj}/file")
def sync_delete_file(svc: str, proj: str, path: str, if_sha: str = "",
                     authorization: Optional[str] = Header(default=None)):
    p = _writable(svc, proj, path, authorization)
    with _write_lock:
        if _sha(p) != if_sha:
            raise HTTPException(409, "그 사이 바뀌었습니다.")
        p.unlink(missing_ok=True)
    return {"ok": True}


@router.get("/api/sync/{svc}/projects/{proj}/file")
def sync_file(svc: str, proj: str, path: str, authorization: Optional[str] = Header(default=None)):
    _require_sync_token(svc, authorization, proj)
    try:
        return Response(content=pr.project_file(svc, proj, path),
                        media_type="application/octet-stream")
    except FileNotFoundError:
        raise HTTPException(404, f"'{path}' 없음")


@router.get("/api/sync/{svc}/grants")
def sync_grants(svc: str, authorization: Optional[str] = Header(default=None),
                db=Depends(get_db)):
    """Who may use this service on MAIN, described by account identity rather than
    row ids — the sub has its own users table, so grants only travel as
    (username, email) pairs it can match locally.

    A project's token sees who may use THAT project — a whole-service grant
    included, but handed over as a grant on the project alone: the partner
    holds one project, so nobody arrives there with rights to the rest."""
    kind, names = _scope(svc, authorization)
    rows = (db.query(models.ServicePermission, models.User)
            .filter(models.ServicePermission.service_name == svc,
                    models.User.id == models.ServicePermission.user_id)
            .all())
    one = next(iter(names)) if kind == "project" else None
    out = []
    for p, u in rows:
        proj = p.project or ""
        if one is not None:
            if proj not in ("", one):
                continue
            proj = one
        elif proj and proj in names:              # linked on its own: not this token's
            continue
        out.append({"username": u.username, "email": u.email, "project": proj,
                    "is_admin": bool(p.is_admin)})
    return {"service": svc, "grants": out}


def _has_files(svc: str, proj: str) -> bool:
    d = pr.project_dir(svc, proj)
    return d.is_dir() and any(pr._syncable_files(d))


@router.put("/api/sync/{svc}/projects/{proj}/seed")
async def sync_seed(svc: str, proj: str, request: Request, authorization: Optional[str] = Header(default=None)):
    """A sub that already holds data, linked to a main that holds none: the
    sub's whole project becomes main's. Only into a project that is missing or
    empty here — it can start a main, never overwrite one."""
    _require_sync_token(svc, authorization, proj)
    if not registry.valid_name(proj):
        raise HTTPException(400, "프로젝트 이름이 올바르지 않습니다.")
    raw = await request.body()
    with _write_lock:
        if _has_files(svc, proj):
            raise HTTPException(409, "main 의 이 프로젝트에 이미 데이터가 있어 올리지 않습니다.")
        try:
            pr.import_project(svc, raw, proj, replace=True)
        except ValueError as e:
            raise HTTPException(400, str(e))
    return {"ok": True}


@router.get("/api/sync/{svc}/projects/{proj}/export")
def sync_export(svc: str, proj: str, authorization: Optional[str] = Header(default=None)):
    _require_sync_token(svc, authorization, proj)
    try:
        data = pr.export_project(svc, proj)
    except FileNotFoundError:
        raise HTTPException(404, f"'{proj}' 없음")
    return Response(content=data, media_type="application/zip")


# ── sub side: config + pull ───────────────────────────────────────────────────
class SyncCfg(BaseModel):
    role: str = ""                 # '' | 'main' | 'sub'
    main_url: Optional[str] = None  # sub: the MAIN portal's base URL
    token: Optional[str] = None     # main: issued here; sub: pasted from main
    read_only: bool = True          # sub: refuse writes through the proxy
    interval_min: int = 0           # sub: auto-pull every N minutes (0 = manual only)
    projects: list[str] = []        # sub: only these projects ([] = every one)
    live: bool = False              # sub: follow main within seconds (overrides interval)
    two_way: bool = False           # sub: send local edits to main too (main must accept_push)
    accept_push: bool = False       # main: let paired subs write back


def _public(svc: str, proj: str = "") -> dict:
    cfg = sync.read(svc, proj)
    return {"role": cfg.get("role", ""), "main_url": cfg.get("main_url"),
            # main needs its token to build the connection code; a sub's never
            # has to leave the server again (a save without one keeps it).
            "token": cfg.get("token") if cfg.get("role") == "main" else None,
            "read_only": cfg.get("read_only", True),
            "last_sync": cfg.get("last_sync"), "last_error": cfg.get("last_error"),
            "interval_min": int(cfg.get("interval_min") or 0),
            "live": bool(cfg.get("live")),
            "two_way": bool(cfg.get("two_way")),
            "projects": list(cfg.get("projects") or []),
            "accept_push": bool(cfg.get("accept_push")),
            "project": proj or None,
            # Service level: the projects that travel by a link of their own.
            "own_links": [] if proj else sync.own_links(svc),
            # what a sub operator must paste into their portal
            "pair_url": config.BASE_URL if cfg.get("role") == "main" else None}


def _check_project(svc: str, proj: str) -> None:
    if not registry.valid_name(proj) or not pr.project_dir(svc, proj).is_dir():
        raise HTTPException(404, f"'{proj}' 없음")


def _put(svc: str, body: SyncCfg, proj: str = "") -> dict:
    if body.role not in ("", "main", "sub"):
        raise HTTPException(400, "role 은 '', 'main', 'sub' 중 하나여야 합니다.")
    cfg = sync.read(svc, proj)
    cfg["role"] = body.role
    if body.role == "main":
        # Keep an existing token so paired subs don't break on an unrelated edit.
        cfg["token"] = cfg.get("token") or sync.new_token()
        cfg["accept_push"] = bool(body.accept_push)
        cfg.pop("main_url", None)
    elif body.role == "sub":
        was = cfg if cfg.get("role") == "sub" else {}
        url = ((body.main_url or "").strip() or was.get("main_url") or "").rstrip("/")
        if not url.startswith(("http://", "https://")):
            raise HTTPException(400, "main 주소는 http(s):// 로 시작해야 합니다.")
        if was.get("main_url") != url:          # another main: its first sync again
            for k in ("settled", "last_sync", "last_error"):
                cfg.pop(k, None)
        cfg["main_url"] = url
        cfg["token"] = (body.token or "").strip() or was.get("token") or ""
        cfg["read_only"] = bool(body.read_only)
        cfg["interval_min"] = max(0, min(1440, int(body.interval_min or 0)))
        cfg["live"] = bool(body.live)
        cfg["two_way"] = bool(body.two_way)
        cfg["projects"] = [] if proj else sorted({p for p in body.projects if registry.valid_name(p)})
        if not cfg["token"]:
            raise HTTPException(400, "main 의 연결 코드를 붙여넣으세요.")
    else:
        cfg = {"role": ""}
    sync.write(svc, cfg, proj)
    return _public(svc, proj)


def _rotate(svc: str, proj: str = "") -> dict:
    """New token on the main — every paired sub must be re-paired."""
    cfg = sync.read(svc, proj)
    if cfg.get("role") != "main":
        raise HTTPException(409, "main 으로 설정된 것만 토큰을 발급합니다.")
    cfg["token"] = sync.new_token()
    sync.write(svc, cfg, proj)
    return _public(svc, proj)


@router.get("/api/admin/services/{svc}/sync")
def get_sync(svc: str, _: models.User = Depends(require_portal_admin)):
    return _public(svc)


@router.put("/api/admin/services/{svc}/sync")
def put_sync(svc: str, body: SyncCfg, _: models.User = Depends(require_portal_admin)):
    return _put(svc, body)


@router.post("/api/admin/services/{svc}/sync/rotate")
def rotate_token(svc: str, _: models.User = Depends(require_portal_admin)):
    return _rotate(svc)


# One project, linked on its own: the same settings, its own partner and token.
@router.get("/api/admin/services/{svc}/projects/{proj}/sync")
def get_project_sync(svc: str, proj: str, _: models.User = Depends(require_portal_admin)):
    _check_project(svc, proj)
    return _public(svc, proj)


@router.put("/api/admin/services/{svc}/projects/{proj}/sync")
def put_project_sync(svc: str, proj: str, body: SyncCfg, _: models.User = Depends(require_portal_admin)):
    _check_project(svc, proj)
    return _put(svc, body, proj)


@router.post("/api/admin/services/{svc}/projects/{proj}/sync/rotate")
def rotate_project_token(svc: str, proj: str, _: models.User = Depends(require_portal_admin)):
    _check_project(svc, proj)
    return _rotate(svc, proj)


# ── joining from a code: everything the sub needs, in one paste ──────────────
CODE_PREFIX = "lilak-sync:"


class JoinBody(BaseModel):
    code: str
    live: bool = True               # follow main within seconds from the start


def _decode(code: str) -> dict:
    """main's connection code → {url, svc, proj, token, two_way}. Built by the
    main's sync panel: the prefix and url-safe base64 of a small JSON."""
    import base64
    import json as _json
    raw = (code or "").strip()
    if raw.startswith(CODE_PREFIX):
        raw = raw[len(CODE_PREFIX):]
    try:
        d = _json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)).decode("utf-8"))
        assert isinstance(d, dict) and d.get("url") and d.get("svc") and d.get("token")
    except Exception:                            # noqa: BLE001
        raise HTTPException(400, "연결 코드를 읽을 수 없습니다 — main 에서 복사한 코드 전체를 붙여넣으세요.")
    return d


@router.post("/api/admin/services/{svc}/sync/join", status_code=202)
def join_sync(svc: str, body: JoinBody, _: models.User = Depends(require_portal_admin)):
    """Become a sub from main's connection code alone."""
    d = _decode(body.code)
    if d["svc"] != svc:
        raise HTTPException(400, f"이 코드는 '{d['svc']}' 서비스용입니다.")
    return _join(svc, str(d["url"]), d["token"], str(d.get("proj") or ""),
                 bool(d.get("two_way")), bool(body.live))


def _join(svc: str, url: str, token: str, proj: str, two_way: bool, live: bool) -> dict:
    """Check that main answers to the token, make the project here if there is
    none, link it (the project's own link for a project, the service's
    otherwise) and start the first sync. What a code and an approved request
    both end in."""
    import json as _json
    url = url.strip().rstrip("/")
    if proj and not registry.valid_name(proj):
        raise HTTPException(400, "프로젝트 이름이 올바르지 않습니다.")
    d = {"token": token}
    try:
        listed = _json.loads(_get(f"{url}/api/sync/{svc}/projects", d["token"], timeout=10)).get("projects") or []
    except urllib.error.HTTPError as e:
        raise HTTPException(502, f"main 이 코드를 받지 않습니다 (HTTP {e.code}) — 토큰이 바뀌었으면 새 코드를 받으세요.")
    except Exception as e:                       # noqa: BLE001
        raise HTTPException(502, f"main 에 닿지 않습니다: {e} — 코드 속 주소({url})가 이 서버에서 열리는지 확인하세요.")
    if proj and proj not in listed:
        raise HTTPException(404, f"main 에 '{proj}' 프로젝트가 없습니다.")
    made = False
    if proj and not pr.project_dir(svc, proj).is_dir():
        pr.create_project(svc, proj)
        made = True
    cfg = _put(svc, SyncCfg(role="sub", main_url=url, token=token,
                            two_way=two_way, live=live), proj)
    job_id = _start_pull(svc, key=proj)
    return {"job_id": job_id, "project": proj or None, "made": made,
            "two_way": cfg["two_way"], "projects": listed}


# ── pairing by request (handshake): sub asks with an address, main approves ───
class PairAsk(BaseModel):             # sub → main, no credentials
    project: str = ""
    two_way: bool = False
    from_url: str = ""
    from_name: str = ""
    by: str = ""
    batch: str = ""                   # one "every service" request from one server


@router.post("/api/sync/{svc}/requests", status_code=201)
def pair_ask(svc: str, body: PairAsk):
    """Another portal asks to follow this service (or one project of it). Open
    to anyone — it grants nothing until an admin here approves — so it is kept
    small: a capped, expiring list, every text field clipped."""
    import secrets as _secrets
    import time as _time
    if not registry.service_dir(svc).exists():
        raise HTTPException(404, "서비스를 찾을 수 없습니다.")
    proj = (body.project or "").strip()
    if proj and (not registry.valid_name(proj) or not pr.project_dir(svc, proj).is_dir()):
        raise HTTPException(404, f"이 서버에 '{proj}' 프로젝트가 없습니다.")
    if sync.effective(svc, proj).get("role") == "sub":
        raise HTTPException(409, "이쪽도 다른 서버를 따르는 사본이라 원본이 될 수 없습니다.")
    now = _time.time()
    rows = [r for r in sync.read_list(svc, "sync-requests.json") if now - r.get("at", 0) < sync.REQ_KEEP_S]
    if sum(1 for r in rows if r.get("status") == "pending") >= sync.REQ_MAX:
        raise HTTPException(429, "대기 중인 연결 요청이 너무 많습니다. 관리자에게 정리를 부탁하세요.")
    claim = _secrets.token_urlsafe(24)
    clip = lambda v, n=200: str(v or "")[:n]
    row = {"id": uuid.uuid4().hex[:12], "claim": claim, "status": "pending", "at": now,
           "project": proj, "two_way": bool(body.two_way), "from_url": clip(body.from_url),
           "from_name": clip(body.from_name, 80), "by": clip(body.by, 80), "batch": clip(body.batch, 40)}
    sync.write_list(svc, "sync-requests.json", rows + [row])
    return {"id": row["id"], "claim": claim, "pin": sync.pin(claim)}


@router.get("/api/sync/{svc}/requests/{rid}")
def pair_status(svc: str, rid: str, claim: str = ""):
    """The sender (and only the sender — the claim) asks how its request went.
    An approved request hands over the token once, then forgets it."""
    import secrets as _secrets
    rows = sync.read_list(svc, "sync-requests.json")
    r = next((x for x in rows if x.get("id") == rid), None)
    if not r or not _secrets.compare_digest(r.get("claim", ""), claim or ""):
        raise HTTPException(404, "요청을 찾을 수 없습니다 (만료되었을 수 있습니다).")
    out = {"status": r["status"], "project": r.get("project") or "", "two_way": bool(r.get("accept_push"))}
    if r["status"] == "approved" and r.get("token"):
        out["token"] = r.pop("token")
        r["status"] = "delivered"
        sync.write_list(svc, "sync-requests.json", rows)
    return out


class PairDecide(BaseModel):
    action: str                     # approve | reject
    accept_push: bool = False       # approve: let that sub write back


@router.get("/api/admin/services/{svc}/sync/requests")
def pair_list(svc: str, _: models.User = Depends(require_portal_admin)):
    """What other servers asked for, newest first — never the claim or token."""
    rows = sync.read_list(svc, "sync-requests.json")
    return [{k: r.get(k) for k in ("id", "status", "at", "project", "two_way", "from_url", "from_name", "by")}
            | {"pin": sync.pin(r.get("claim", ""))} for r in reversed(rows)]


@router.post("/api/admin/services/{svc}/sync/requests/{rid}")
def pair_decide(svc: str, rid: str, body: PairDecide, _: models.User = Depends(require_portal_admin)):
    """Approve: this side becomes main for that link (the project's own, or the
    service's) if it was not already, and the token waits for the sender to
    collect it. Reject: the sender is told so."""
    return _decide(svc, rid, body)


def _decide(svc: str, rid: str, body: PairDecide) -> dict:
    rows = sync.read_list(svc, "sync-requests.json")
    r = next((x for x in rows if x.get("id") == rid), None)
    if not r or r.get("status") != "pending":
        raise HTTPException(404, "대기 중인 요청이 아닙니다.")
    if body.action == "reject":
        r["status"] = "rejected"
    elif body.action == "approve":
        key = r.get("project") or ""
        cfg = sync.read(svc, key)
        if cfg.get("role") == "sub":
            raise HTTPException(409, "이 서버가 다른 서버를 따르고 있어 원본이 될 수 없습니다.")
        if cfg.get("role") != "main" or (body.accept_push and not cfg.get("accept_push")):
            _put(svc, SyncCfg(role="main", accept_push=bool(body.accept_push or cfg.get("accept_push"))), key)
        r.update(status="approved", token=sync.read(svc, key)["token"],
                 accept_push=bool(sync.read(svc, key).get("accept_push")))
    else:
        raise HTTPException(400, "action 은 approve 또는 reject 입니다.")
    sync.write_list(svc, "sync-requests.json", rows)
    return {"ok": True, "status": r["status"]}


class PairRequest(BaseModel):         # admin on the sub
    url: str
    project: str = ""
    two_way: bool = False
    live: bool = True


@router.post("/api/admin/services/{svc}/sync/request")
def pair_request(svc: str, body: PairRequest, user: models.User = Depends(require_portal_admin)):
    """Ask main, at an address, to let this server follow it. Waits for the
    approval in the background (see _check_pending)."""
    return _ask(svc, body, user.username)


def _ask(svc: str, body: PairRequest, by: str, batch: str = "") -> dict:
    import json as _json
    import socket
    url = body.url.strip().rstrip("/")
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "main 주소는 http(s):// 로 시작해야 합니다.")
    proj = body.project.strip()
    if proj and not registry.valid_name(proj):
        raise HTTPException(400, "프로젝트 이름이 올바르지 않습니다.")
    ask = _json.dumps({"project": proj, "two_way": body.two_way, "from_url": config.BASE_URL,
                       "from_name": socket.gethostname(), "by": by, "batch": batch}).encode()
    try:
        req = urllib.request.Request(f"{url}/api/sync/{svc}/requests", data=ask, method="POST",
                                     headers={"Content-Type": "application/json", **UA})
        with urllib.request.urlopen(req, timeout=10) as r:
            got = _json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            why = _json.loads(e.read()).get("detail")
        except Exception:                        # noqa: BLE001
            why = None
        raise HTTPException(502, why or f"main 이 요청을 받지 않았습니다 (HTTP {e.code}) — 같은 서비스가 있는 포털 주소인지 확인하세요.")
    except Exception as e:                       # noqa: BLE001
        raise HTTPException(502, f"main 에 닿지 않습니다: {e} — 주소({url})가 이 서버에서 열리는지 확인하세요.")
    rows = [p for p in sync.read_list(svc, "sync-pending.json")
            if not (p["url"] == url and p["project"] == proj)]
    row = {"id": got["id"], "claim": got["claim"], "pin": got["pin"], "url": url, "project": proj,
           "two_way": body.two_way, "live": body.live, "status": "pending",
           "bpin": sync.pin(batch) if batch else ""}
    sync.write_list(svc, "sync-pending.json", rows + [row])
    return {k: row[k] for k in ("id", "pin", "url", "project", "status")}


def _check_pending(svc: str) -> list:
    """Ask main how each waiting request went; an approved one is joined on
    the spot. Returns the list as it now stands (claims left out)."""
    import json as _json
    rows = sync.read_list(svc, "sync-pending.json")
    changed = False
    for p in rows:
        if p["status"] != "pending":
            continue
        try:
            st = _json.loads(_get(f"{p['url']}/api/sync/{svc}/requests/{p['id']}?claim="
                                  f"{urllib.parse.quote(p['claim'])}", "", timeout=5))
        except urllib.error.HTTPError as e:
            if e.code == 404:
                p["status"], changed = "expired", True
            continue
        except Exception:                        # noqa: BLE001 — main away: next time
            continue
        if st["status"] == "rejected":
            p["status"], changed = "rejected", True
        elif st.get("token"):
            try:
                res = _join(svc, p["url"], st["token"], p["project"],
                            bool(p["two_way"] and st.get("two_way")), bool(p["live"]))
                p.update(status="joined", job_id=res.get("job_id"), two_way=res["two_way"])
            except HTTPException as e:
                p.update(status="failed", error=str(e.detail))
            changed = True
    if changed:
        sync.write_list(svc, "sync-pending.json", rows)
    return [{k: v for k, v in p.items() if k != "claim"} for p in rows]


@router.get("/api/admin/services/{svc}/sync/pending")
def pair_pending(svc: str, _: models.User = Depends(require_portal_admin)):
    return _check_pending(svc)


@router.delete("/api/admin/services/{svc}/sync/pending/{rid}")
def pair_forget(svc: str, rid: str, _: models.User = Depends(require_portal_admin)):
    sync.write_list(svc, "sync-pending.json",
                    [p for p in sync.read_list(svc, "sync-pending.json") if p["id"] != rid])
    return {"ok": True}


@router.get("/api/admin/services/{svc}/sync/projects")
def sync_project_choices(svc: str, _: models.User = Depends(require_portal_admin)):
    """What the service's sub link can choose from: main's projects and this
    server's own — minus those linked on their own."""
    import json as _json
    cfg = sync.read(svc)
    own = set(sync.own_links(svc))
    local = [p["name"] for p in pr.list_projects(svc) if p["name"] not in own]
    main, err = [], None
    if cfg.get("role") == "sub" and cfg.get("main_url") and cfg.get("token"):
        try:
            main = _json.loads(_get(f"{cfg['main_url'].rstrip('/')}/api/sync/{svc}/projects",
                                    cfg["token"], timeout=10)).get("projects") or []
        except Exception as e:                   # noqa: BLE001
            err = f"main 연결 실패: {e}"
    return {"main": [p for p in main if p not in own], "local": local, "error": err}


def _get(url: str, token: str, timeout: int = 60) -> bytes:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", **UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _send(method: str, url: str, token: str, data: bytes = None, timeout: int = 120) -> bytes:
    req = urllib.request.Request(url, data=data, method=method, headers={**UA,
        "Authorization": f"Bearer {token}", "Content-Type": "application/octet-stream"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


class _Moved(Exception):
    """The file changed while we were deciding — the next round sees it."""


def _two_way_project(job_id: str, base: str, token: str, svc: str, proj: str, fresh: bool = False) -> int:
    """Bring this server's copy of ONE project and main's to the same files:
    what changed on one side goes to the other, what changed on both is merged.
    Returns the number of files that moved.

    ponytail: a local file is checked just before it is replaced, not locked —
    a save landing in that instant is caught by the next round's compare, not
    lost, because the base is only advanced for what actually went through."""
    import hashlib
    import json as _json
    q = urllib.parse.quote
    url = f"{base}/api/sync/{svc}/projects/{proj}"
    try:
        theirs = {r: m["sha256"] for r, m in
                  _json.loads(_get(f"{url}/manifest?shared=1", token))["files"].items()}
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise
        theirs = {}                              # not on main yet: it is ours to send
    try:
        mine = {r: m["sha256"] for r, m in
                pr.project_manifest(svc, proj, skip=sync_merge.local_only)["files"].items()}
    except FileNotFoundError:
        mine = {}
    if any(r.endswith(_DB_EXT) for r in list(mine) + list(theirs)):
        if fresh and mine and not theirs:
            return _seed(job_id, base, token, svc, proj)
        _log(job_id, f"  ! {proj}: 데이터베이스 파일이 있어 양방향으로 합칠 수 없습니다 — 건너뜀")
        return 0
    if fresh and mine and theirs:
        _backup(job_id, svc, proj)

    d = pr.project_dir(svc, proj)
    d.mkdir(parents=True, exist_ok=True)
    bdir = registry.service_dir(svc) / ".sync-base" / proj
    try:
        agreed = _json.loads((bdir / "manifest.json").read_text(encoding="utf-8"))
    except Exception:                            # noqa: BLE001 — first round
        agreed = {}
    sha = lambda b: hashlib.sha256(b).hexdigest()

    def inside(root, rel):
        # File names come from the other server: never let one leave the folder.
        p = (root / rel).resolve()
        if p == root.resolve() or not p.is_relative_to(root.resolve()):
            raise HTTPException(400, f"프로젝트 밖의 경로입니다: {rel}")
        return p
    local = lambda rel: inside(d, rel)

    def put_local(rel, raw, expect):
        p = local(rel)
        if (_sha(p) or None) != expect:
            raise _Moved(rel)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(p.name + ".sync-tmp")
        tmp.write_bytes(raw)
        os.replace(tmp, p)

    def read_local(rel, expect):
        raw = pr.file_bytes(local(rel))
        if sha(raw) != expect:
            raise _Moved(rel)
        return raw

    def push(rel, raw, expect):
        _send("PUT", f"{url}/file?path={q(rel)}&if_sha={expect or ''}", token, raw)

    def base_bytes(rel):
        f = bdir / "files" / rel
        return f.read_bytes() if f.is_file() else None

    now = {r: s for r, s in mine.items() if theirs.get(r) == s}     # already the same
    moved = 0
    for rel, act in sync_merge.plan(agreed, mine, theirs):
        try:
            if act == "pull":
                raw = _get(f"{url}/file?path={q(rel)}", token, timeout=600)
                put_local(rel, raw, mine.get(rel))
                now[rel] = sha(raw)
            elif act == "push":
                push(rel, read_local(rel, mine[rel]), theirs.get(rel))
                now[rel] = mine[rel]
            elif act == "del_mine":
                if _sha(local(rel)) != mine[rel]:
                    raise _Moved(rel)
                local(rel).unlink(missing_ok=True)
            elif act == "del_theirs":
                _send("DELETE", f"{url}/file?path={q(rel)}&if_sha={theirs[rel]}", token)
            else:                                # changed on both sides
                m = read_local(rel, mine[rel])
                t = _get(f"{url}/file?path={q(rel)}", token, timeout=600)
                merged = sync_merge.merge_json(rel, base_bytes(rel), m, t) \
                    if sync_merge.keeps_base(rel) else None
                if merged is not None:
                    put_local(rel, merged, mine[rel])
                    push(rel, merged, theirs[rel])
                    now[rel] = sha(merged)
                    _log(job_id, f"    ⇄ {rel} 양쪽 수정 → 합침")
                else:
                    # Both kept: main's at the name, ours beside it.
                    copy = sync_merge.conflict_name(rel, set(mine) | set(theirs))
                    put_local(copy, m, None)
                    push(copy, m, None)
                    put_local(rel, t, mine[rel])
                    now[rel], now[copy] = theirs[rel], mine[rel]
                    _log(job_id, f"    ⇄ {rel} 양쪽 수정 → 사본 {copy}")
            moved += 1
        except (_Moved, urllib.error.HTTPError) as e:
            if isinstance(e, urllib.error.HTTPError) and e.code != 409:
                raise
            if rel in agreed:
                now[rel] = agreed[rel]           # not settled: compare again next round
            _log(job_id, f"    · {rel} 그 사이 바뀜 — 다음 차례에")

    # The agreed copies a later merge starts from.
    for rel, s_ in now.items():
        if sync_merge.keeps_base(rel) and agreed.get(rel) != s_ and local(rel).is_file():
            raw = pr.file_bytes(local(rel))
            if sha(raw) == s_:
                f = inside(bdir / "files", rel)
                f.parent.mkdir(parents=True, exist_ok=True)
                f.write_bytes(raw)
    for rel in set(agreed) - set(now):
        inside(bdir / "files", rel).unlink(missing_ok=True)
    bdir.mkdir(parents=True, exist_ok=True)
    registry._atomic_write_text((bdir / "manifest.json"), _json.dumps(now, ensure_ascii=False))
    _log(job_id, f"  ✓ {proj} — " + (f"{moved}개 파일 주고받음" if moved else "변경 없음"))
    return moved


def _backup(job_id: str, svc: str, proj: str) -> None:
    """Before a link's first sync touches a project that already holds data,
    keep a copy of it: data/_backups/sync-<svc>-<proj>-<time>.zip."""
    from datetime import datetime
    if not _has_files(svc, proj):
        return
    out = config.DATA_ROOT / "_backups" / f"sync-{svc}-{proj}-{datetime.now():%Y%m%d-%H%M%S}.zip"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(pr.export_project(svc, proj))
    _log(job_id, f"  · 처음 맞추기 전에 이쪽 사본을 남김: _backups/{out.name}")


def _seed(job_id: str, base: str, token: str, svc: str, proj: str) -> int:
    """main has nothing for this project: send ours whole (main's /seed)."""
    raw = pr.export_project(svc, proj)
    _send("PUT", f"{base}/api/sync/{svc}/projects/{proj}/seed", token, raw, timeout=600)
    _log(job_id, f"  ↑ {proj} — main 이 비어 있어 이쪽 데이터를 올림 ({len(raw) // 1024} KB)")
    return len(raw)


def _pull_project(job_id: str, base: str, token: str, svc: str, proj: str, fresh: bool = False) -> int:
    """Bring ONE project in line with main, transferring only what differs.
    Returns the bytes moved. Compares main's manifest against a manifest of the
    local copy built the exact same way, so identical files cost nothing."""
    import json as _json
    try:
        remote = _json.loads(_get(f"{base}/api/sync/{svc}/projects/{proj}/manifest", token))["files"]
    except urllib.error.HTTPError as e:
        if e.code != 404 or not fresh:
            raise
        remote = None                            # main has no such project
    try:
        localm = pr.project_manifest(svc, proj)["files"]
    except FileNotFoundError:
        localm = {}                              # not here yet → everything is new
    # A link's first sync never costs this server its data: an empty main is
    # given ours, and a main with data of its own replaces ours only after a
    # copy is kept.
    if fresh and localm and not remote:
        return _seed(job_id, base, token, svc, proj)
    if remote is None and not localm:
        _log(job_id, f"  · {proj} 양쪽 다 비어 있음")
        return 0
    if remote is None:
        raise RuntimeError("main 에 이 프로젝트가 없습니다")

    changed = [p for p, m in remote.items()
               if localm.get(p, {}).get("sha256") != m["sha256"]]
    stale = [p for p in localm if p not in remote]
    if not changed and not stale:
        _log(job_id, f"  · {proj} 변경 없음")
        return 0
    if fresh and (stale or any(p in localm for p in changed)):
        _backup(job_id, svc, proj)

    d = pr.project_dir(svc, proj)
    # A database has to be released before it is replaced. A service that keeps
    # its state in plain files (the rack services: JSON, markdown) does not:
    # each file is swapped in whole (below), so a reader sees the old file or
    # the new one, never half of one — and a live mirror does not restart the
    # project on every change.
    if any(rel.endswith(_DB_EXT) for rel in changed + stale):
        pr.stop_project(svc, proj)
    d.mkdir(parents=True, exist_ok=True)
    moved = 0
    for rel in changed:
        raw = _get(f"{base}/api/sync/{svc}/projects/{proj}/file?path={urllib.parse.quote(rel)}",
                   token, timeout=600)
        dest = (d / rel).resolve()
        if dest == d.resolve() or not dest.is_relative_to(d.resolve()):
            continue                             # path-traversal guard
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(dest.name + ".sync-tmp")
        tmp.write_bytes(raw)
        os.replace(tmp, dest)
        moved += len(raw)
    for rel in stale:                            # file removed on main → remove here
        p = (d / rel).resolve()
        if p.is_relative_to(d.resolve()) and p.is_file():
            p.unlink(missing_ok=True)
    # The snapshot folds the WAL in; leftover siblings would resurrect old pages.
    for w in list(d.rglob("*-wal")) + list(d.rglob("*-shm")):
        w.unlink(missing_ok=True)
    _log(job_id, f"  ✓ {proj} — 파일 {len(changed)}개 {moved // 1024} KB"
                 + (f", 삭제 {len(stale)}개" if stale else ""))
    return moved


# The last stamp of each main project this mirror has brought in, per service.
# Memory, not disk: after a restart the first live tick compares manifests once
# (cheaply — identical files move nothing) and fills it again.
_seen: dict = {}
# …and, for a two-way sub, the stamp of each LOCAL project after it was synced.
_seen_local: dict = {}


def _run_pull(job_id: str, svc: str, only: Optional[dict] = None, key: str = "") -> None:
    """Sync every project of one link — the service's (key '') or one project's
    own (key = that project) — or, from a live tick, just the ones in `only`
    ({project: the stamp main reported}), recording each stamp once it lands."""
    import json as _json
    cfg = sync.read(svc, key)
    base, token = (cfg.get("main_url") or "").rstrip("/"), cfg.get("token") or ""
    own = set(sync.own_links(svc))
    _set(job_id, status="running")
    try:
        if only is not None:
            names = sorted(only)
        elif key:
            names = [key]                       # a project's link is that project
        else:
            listing = _json.loads(_get(f"{base}/api/sync/{svc}/projects", token))
            names = [n for n in listing.get("projects") or [] if n not in own]
    except urllib.error.HTTPError as e:
        return _set(job_id, status="error",
                    error=f"main 연결 실패 (HTTP {e.code}) — 주소/토큰을 확인하세요.")
    except Exception as e:                       # noqa: BLE001
        return _set(job_id, status="error", error=f"main 연결 실패: {e}")

    _log(job_id, f"· main 프로젝트 {len(names)}개: {', '.join(names) or '(없음)'}")
    local = {p["name"] for p in pr.list_projects(svc)} - (set() if key else own)
    two_way = bool(cfg.get("two_way"))
    # The link's first sync: this server's data may start an empty main.
    # (`settled` is written only once a round went through whole — a first try
    # that failed, say main lacked the service, is still a first sync.)
    # A link from before this flag that synced cleanly counts as settled.
    fresh = only is None and not (cfg.get("settled") or (cfg.get("last_sync") and not cfg.get("last_error")))
    if (two_way or fresh) and only is None and not key:
        names = sorted(set(names) | local)     # a project made here goes to main too
    picked = set(cfg.get("projects") or [])
    if picked:                                 # the operator chose which ones travel
        names = [n for n in names if n in picked]
    ok, moved = 0, 0
    for n in names:
        try:
            if two_way:
                moved += _two_way_project(job_id, base, token, svc, n, fresh)
            else:
                moved += _pull_project(job_id, base, token, svc, n, fresh)
            ok += 1
            if only is not None and only[n] is not None:
                _seen.setdefault(svc, {})[n] = only[n]
            if two_way:
                _seen_local.setdefault(svc, {})[n] = pr.project_stamp(svc, n)
        except Exception as e:                   # noqa: BLE001
            _log(job_id, f"  ! {n} 실패: {e}")
    extra = sorted(local - set(names)) if only is None and not two_way and not key else []
    if extra:
        _log(job_id, f"· main 에 없는 로컬 프로젝트는 그대로 둡니다: {', '.join(extra)}")

    from datetime import datetime
    cfg = sync.read(svc, key)
    if cfg.get("role"):                         # not turned off meanwhile
        cfg["last_sync"] = datetime.utcnow().isoformat(timespec="seconds") + "Z"
        cfg["last_error"] = None if ok == len(names) else f"{len(names) - ok}개 실패"
        if ok == len(names) and only is None:
            cfg["settled"] = True
        sync.write(svc, cfg, key)
    _log(job_id, f"✓ 동기화 완료 — {ok}/{len(names)} 프로젝트, "
                 + (f"파일 {moved}개" if two_way else f"전송 {moved // 1024} KB"))
    _set(job_id, status="done" if ok == len(names) else "error",
         error=None if ok == len(names) else f"{len(names) - ok}개 프로젝트 실패")


def _start_pull(svc: str, only: Optional[dict] = None, key: str = "") -> Optional[str]:
    """Kick off a sync of one link unless one is already running for it. Returns
    the job id, or None when a sync is in flight (a slow pull must never stack
    up behind the scheduler's ticks)."""
    busy = f"{svc}/{key}"
    with _lock:
        if busy in _busy:
            return None
        _busy.add(busy)
        job_id = uuid.uuid4().hex[:12]
        _jobs[job_id] = {"status": "queued", "log": [], "error": None, "name": svc}

    def run():
        try:
            _run_pull(job_id, svc, only, key)
        finally:
            with _lock:
                _busy.discard(busy)

    threading.Thread(target=run, daemon=True).start()
    return job_id


def _run(svc: str, key: str = "") -> dict:
    cfg = sync.read(svc, key)
    if cfg.get("role") != "sub":
        raise HTTPException(409, "sub 로 설정된 것만 동기화를 받습니다.")
    if not cfg.get("main_url") or not cfg.get("token"):
        raise HTTPException(400, "main 주소와 토큰을 먼저 설정하세요.")
    job_id = _start_pull(svc, key=key)
    if not job_id:
        raise HTTPException(409, "이미 동기화가 진행 중입니다.")
    return {"job_id": job_id, "name": svc}


@router.post("/api/admin/services/{svc}/sync/run", status_code=202)
def run_sync(svc: str, _: models.User = Depends(require_portal_admin)):
    return _run(svc)


@router.post("/api/admin/services/{svc}/projects/{proj}/sync/run", status_code=202)
def run_project_sync(svc: str, proj: str, _: models.User = Depends(require_portal_admin)):
    _check_project(svc, proj)
    return _run(svc, proj)


# ── permission transfer (explicit, never part of a data sync) ─────────────────
@router.post("/api/admin/services/{svc}/sync/grants")
def import_grants(svc: str, apply: bool = False, project: str = "",
                  _: models.User = Depends(require_portal_admin), db=Depends(get_db)):
    """Copy MAIN's grants for this service onto LOCAL accounts of the same person.

    Identity is matched by username, else by email — the two servers keep separate
    user tables, so a grant can only land on someone who already has an account
    here. Anyone without a local account is reported, never created: this must not
    become a way to mint accounts on another server.

    Runs only when an admin asks (and defaults to a preview) — access must never
    spread across servers as a side effect of a data sync.
    """
    import json as _json
    if project:
        _check_project(svc, project)
    cfg = sync.read(svc, project)
    if cfg.get("role") != "sub" or not (cfg.get("main_url") and cfg.get("token")):
        raise HTTPException(409, "sub 로 연결된 서비스에서만 권한을 가져올 수 있습니다.")
    try:
        remote = _json.loads(_get(f"{cfg['main_url'].rstrip('/')}/api/sync/{svc}/grants",
                                  cfg["token"]))["grants"]
    except urllib.error.HTTPError as e:
        raise HTTPException(502, f"main 연결 실패 (HTTP {e.code}) — 주소/토큰을 확인하세요.")
    except Exception as e:                       # noqa: BLE001
        raise HTTPException(502, f"main 연결 실패: {e}")

    matched, skipped, applied = [], [], 0
    for g in remote:
        uname, email = (g.get("username") or "").strip(), (g.get("email") or "").strip()
        user = db.query(models.User).filter(models.User.username == uname).first()
        how = "username"
        if not user and email:
            user = db.query(models.User).filter(models.User.email == email).first()
            how = "email"
        if not user:
            skipped.append({**g, "reason": "no_local_account"})
            continue
        proj, is_admin = g.get("project") or "", bool(g.get("is_admin"))
        exists = (db.query(models.ServicePermission)
                  .filter(models.ServicePermission.user_id == user.id,
                          models.ServicePermission.service_name == svc,
                          models.ServicePermission.project == proj).first())
        matched.append({"username": uname, "local_user": user.username, "matched_by": how,
                        "email_differs": bool(email and user.email and email != user.email),
                        "project": proj, "is_admin": is_admin,
                        "already": bool(exists)})
        if not apply or exists:
            continue
        db.add(models.ServicePermission(user_id=user.id, service_name=svc,
                                        project=proj, is_admin=is_admin))
        applied += 1
    if apply:
        db.commit()
    return {"applied": applied, "preview": not apply,
            "matched": matched, "skipped": skipped}


# ── periodic auto-pull ────────────────────────────────────────────────────────
TICK_S = 20                      # how often the scheduler re-checks what is due
LIVE_S = 3                       # how often a live mirror asks main what changed
_DB_EXT = (".db", ".sqlite", ".sqlite3")


def _due(svc: str, key: str = "") -> bool:
    cfg = sync.read(svc, key)
    if cfg.get("role") != "sub" or not (cfg.get("main_url") and cfg.get("token")):
        return False
    iv = int(cfg.get("interval_min") or 0)
    if iv <= 0:
        return False                              # manual only
    last = cfg.get("last_sync")
    if not last:
        return True
    from datetime import datetime, timedelta
    try:
        prev = datetime.fromisoformat(str(last).rstrip("Z"))
    except ValueError:
        return True
    return datetime.utcnow() - prev >= timedelta(minutes=iv)


def _live_tick(svc: str, key: str = "") -> None:
    """A live mirror: ask main for its stamps (stat-only on main's side) and
    pull exactly the projects whose stamp moved since the last one brought in."""
    import json as _json
    cfg = sync.read(svc, key)
    base, token = (cfg.get("main_url") or "").rstrip("/"), cfg.get("token") or ""
    try:
        stamps = _json.loads(_get(f"{base}/api/sync/{svc}/stamps", token, timeout=10))["stamps"]
    except Exception:                             # noqa: BLE001 — main away: try next tick
        return
    seen = _seen.get(svc, {})
    moved = {p: st for p, st in stamps.items() if seen.get(p) != st}
    if cfg.get("two_way"):
        # An edit here is a reason to sync as much as one there.
        mine = _seen_local.get(svc, {})
        own = set(sync.own_links(svc))
        ours = [key] if key else [p["name"] for p in pr.list_projects(svc) if p["name"] not in own]
        for n in ours:
            try:
                if mine.get(n) != pr.project_stamp(svc, n):
                    moved.setdefault(n, stamps.get(n))
            except FileNotFoundError:
                pass
    picked = set(cfg.get("projects") or [])
    if picked:
        moved = {p: st for p, st in moved.items() if p in picked}
    if moved:
        _start_pull(svc, moved, key)              # None while a pull is in flight


def _is_live(svc: str, key: str = "") -> bool:
    cfg = sync.read(svc, key)
    return bool(cfg.get("role") == "sub" and cfg.get("live")
                and cfg.get("main_url") and cfg.get("token"))


def _scheduler() -> None:
    import time
    waited = 0
    while True:
        time.sleep(LIVE_S)
        waited += LIVE_S
        try:
            # Every link: the service's, and each project linked on its own.
            links = [(svc, key) for svc in registry.list_service_names()
                     for key in [""] + sync.own_links(svc)]
            for svc, key in links:
                if _is_live(svc, key):
                    _live_tick(svc, key)
            if waited >= TICK_S:                  # minute-scale mirrors, as before
                waited = 0
                for svc in registry.list_service_names():
                    if any(p.get("status") == "pending" for p in sync.read_list(svc, "sync-pending.json")):
                        _check_pending(svc)       # an approval lands without anyone watching
                for svc, key in links:
                    if not _is_live(svc, key) and _due(svc, key):
                        _start_pull(svc, key=key)  # None if one is still running
        except Exception as e:                    # noqa: BLE001 — a bad service must not kill the loop
            print(f"[sync] scheduler tick failed: {e}", flush=True)


def start_scheduler() -> None:
    """One background poller for the whole portal (single-worker by design — see
    scaffold.py). Daemon, so it dies with the process and never blocks shutdown."""
    global _scheduler_started
    with _lock:
        if _scheduler_started:
            return
        _scheduler_started = True
    threading.Thread(target=_scheduler, daemon=True, name="sync-scheduler").start()


@router.get("/api/admin/services/{svc}/sync/jobs/{job_id}")
def sync_job(svc: str, job_id: str, _: models.User = Depends(require_portal_admin)):
    with _lock:
        job = _jobs.get(job_id)
        if not job:
            raise HTTPException(404, "job을 찾을 수 없습니다.")
        return {"status": job["status"], "error": job["error"], "log": job["log"][-60:]}


# ── every service at once ─────────────────────────────────────────────────────
# The per-service panel still does one service (or one project); these do the
# same things for every service with projects, from one place (Settings → Sync).
def _services() -> list[str]:
    return [n for n in registry.list_service_names()
            if registry.manifest_path(n).exists() and pr.list_projects(n)]


def _holds_db(svc: str) -> bool:
    """Two-way cannot merge a database, so such a service is asked one-way."""
    root = pr.projects_root(svc)
    return root.is_dir() and any(f.suffix in _DB_EXT for f in root.rglob("*") if f.is_file())


def _link_row(svc: str, key: str = "") -> dict:
    cfg = sync.read(svc, key)
    return {"project": key, "role": cfg.get("role") or "", "main_url": cfg.get("main_url"),
            "two_way": bool(cfg.get("two_way")), "accept_push": bool(cfg.get("accept_push")),
            "live": bool(cfg.get("live")), "last_sync": cfg.get("last_sync"),
            "last_error": cfg.get("last_error"), "busy": f"{svc}/{key}" in _busy}


@router.get("/api/admin/sync-all")
def all_status(_: models.User = Depends(require_portal_admin)):
    out = []
    for svc in _services():
        pend = sync.read_list(svc, "sync-pending.json")
        if any(p.get("status") == "pending" for p in pend):
            pend = _check_pending(svc)           # ask main how it went
        out.append({"svc": svc, "db": _holds_db(svc), **_link_row(svc),
                    "links": [_link_row(svc, p) for p in sync.own_links(svc)],
                    "pending": [p for p in pend if p.get("status") in ("pending", "failed")],
                    "asked": sum(1 for r in sync.read_list(svc, "sync-requests.json")
                                 if r.get("status") == "pending")})
    return out


class AllRequest(BaseModel):
    url: str
    live: bool = True
    services: list[str] = []          # [] = every service not linked yet


@router.post("/api/admin/sync-all/request")
def all_request(body: AllRequest, user: models.User = Depends(require_portal_admin)):
    """Ask one main for every service at once. One batch, one pin: main's admin
    approves them together. Two-way wherever the data allows it."""
    import secrets as _secrets
    batch = _secrets.token_urlsafe(9)
    want = set(body.services)
    out = []
    for svc in _services():
        if (want and svc not in want) or (not want and sync.role(svc)):
            continue
        try:
            r = _ask(svc, PairRequest(url=body.url, two_way=not _holds_db(svc), live=body.live),
                     user.username, batch)
            out.append({"svc": svc, "ok": True, "two_way": not _holds_db(svc)})
        except HTTPException as e:
            out.append({"svc": svc, "ok": False, "error": str(e.detail)})
    return {"pin": sync.pin(batch), "results": out}


@router.get("/api/admin/sync-all/requests")
def all_asked(_: models.User = Depends(require_portal_admin)):
    """What other servers asked of this one, one row per batch (or per lone request)."""
    groups: dict = {}
    for svc in registry.list_service_names():
        for r in sync.read_list(svc, "sync-requests.json"):
            if r.get("status") != "pending":
                continue
            k = r.get("batch") or f"{svc}:{r['id']}"
            g = groups.setdefault(k, {"batch": k, "pin": sync.pin(r.get("batch") or r.get("claim", "")),
                                      "from_url": r.get("from_url"), "from_name": r.get("from_name"),
                                      "by": r.get("by"), "at": r.get("at"), "items": []})
            g["items"].append({"svc": svc, "id": r["id"], "project": r.get("project") or "",
                               "two_way": bool(r.get("two_way"))})
    return sorted(groups.values(), key=lambda g: -(g["at"] or 0))


class AllDecide(BaseModel):
    batch: str
    action: str                       # approve | reject
    accept_push: bool = True          # approve: two-way where the asker asked for it


@router.post("/api/admin/sync-all/requests/decide")
def all_decide(body: AllDecide, _: models.User = Depends(require_portal_admin)):
    out = []
    for g in all_asked(_):
        if g["batch"] != body.batch:
            continue
        for it in g["items"]:
            try:
                _decide(it["svc"], it["id"], PairDecide(action=body.action,
                                                        accept_push=body.accept_push and it["two_way"]))
                out.append({"svc": it["svc"], "ok": True})
            except HTTPException as e:
                out.append({"svc": it["svc"], "ok": False, "error": str(e.detail)})
    return {"results": out}


@router.post("/api/admin/sync-all/run")
def all_run(_: models.User = Depends(require_portal_admin)):
    """Sync now: every sub link — each service's, and each project linked on its own."""
    out = []
    for svc in _services():
        for key in [""] + sync.own_links(svc):
            if sync.read(svc, key).get("role") != "sub":
                continue
            out.append({"svc": svc, "project": key, "job_id": _start_pull(svc, key=key)})
    return {"started": out}
