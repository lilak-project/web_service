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
def _require_sync_token(svc: str, authorization: Optional[str]) -> None:
    if not registry.service_dir(svc).exists():
        raise HTTPException(404, "서비스를 찾을 수 없습니다.")
    if not sync.check_token(svc, security.bearer(authorization)):
        raise HTTPException(401, "동기화 토큰이 올바르지 않습니다.")


@router.get("/api/sync/{svc}/projects")
def sync_projects(svc: str, authorization: Optional[str] = Header(default=None)):
    _require_sync_token(svc, authorization)
    return {"service": svc, "projects": [p["name"] for p in pr.list_projects(svc)]}


@router.get("/api/sync/{svc}/stamps")
def sync_stamps(svc: str, authorization: Optional[str] = Header(default=None)):
    """{project: stamp} — what a live mirror polls every few seconds. Stat-only
    on this side, so polling it is cheap however large the projects are."""
    _require_sync_token(svc, authorization)
    out = {}
    for p in pr.list_projects(svc):
        try:
            out[p["name"]] = pr.project_stamp(svc, p["name"])
        except FileNotFoundError:
            pass
    return {"service": svc, "stamps": out}


@router.get("/api/sync/{svc}/projects/{proj}/manifest")
def sync_manifest(svc: str, proj: str, shared: int = 0,
                  authorization: Optional[str] = Header(default=None)):
    """`shared=1`: only what two-way sync moves — a server's bookkeeping is
    not even hashed."""
    _require_sync_token(svc, authorization)
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
    _require_sync_token(svc, authorization)
    if not sync.accepts_push(svc):
        raise HTTPException(403, "이 main 은 다른 서버의 쓰기를 받지 않습니다 (양방향 꺼짐).")
    if not registry.valid_name(proj) or not rel or sync_merge.local_only(rel) or rel.endswith(_DB_EXT):
        raise HTTPException(400, "이 파일은 동기화로 쓸 수 없습니다.")
    d = pr.project_dir(svc, proj).resolve()
    p = (d / rel).resolve()
    if not str(p).startswith(str(d) + os.sep):
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
    _require_sync_token(svc, authorization)
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
    (username, email) pairs it can match locally."""
    _require_sync_token(svc, authorization)
    rows = (db.query(models.ServicePermission, models.User)
            .filter(models.ServicePermission.service_name == svc,
                    models.User.id == models.ServicePermission.user_id)
            .all())
    return {"service": svc, "grants": [
        {"username": u.username, "email": u.email, "project": p.project or "",
         "is_admin": bool(p.is_admin)} for p, u in rows]}


@router.get("/api/sync/{svc}/projects/{proj}/export")
def sync_export(svc: str, proj: str, authorization: Optional[str] = Header(default=None)):
    _require_sync_token(svc, authorization)
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


def _public(svc: str) -> dict:
    cfg = sync.read(svc)
    return {"role": cfg.get("role", ""), "main_url": cfg.get("main_url"),
            "token": cfg.get("token"), "read_only": cfg.get("read_only", True),
            "last_sync": cfg.get("last_sync"), "last_error": cfg.get("last_error"),
            "interval_min": int(cfg.get("interval_min") or 0),
            "live": bool(cfg.get("live")),
            "two_way": bool(cfg.get("two_way")),
            "projects": list(cfg.get("projects") or []),
            "accept_push": bool(cfg.get("accept_push")),
            # what a sub operator must paste into their portal
            "pair_url": config.BASE_URL if cfg.get("role") == "main" else None}


@router.get("/api/admin/services/{svc}/sync")
def get_sync(svc: str, _: models.User = Depends(require_portal_admin)):
    return _public(svc)


@router.put("/api/admin/services/{svc}/sync")
def put_sync(svc: str, body: SyncCfg, _: models.User = Depends(require_portal_admin)):
    if body.role not in ("", "main", "sub"):
        raise HTTPException(400, "role 은 '', 'main', 'sub' 중 하나여야 합니다.")
    cfg = sync.read(svc)
    cfg["role"] = body.role
    if body.role == "main":
        # Keep an existing token so paired subs don't break on an unrelated edit.
        cfg["token"] = cfg.get("token") or sync.new_token()
        cfg["accept_push"] = bool(body.accept_push)
        cfg.pop("main_url", None)
    elif body.role == "sub":
        url = (body.main_url or "").strip().rstrip("/")
        if not url.startswith(("http://", "https://")):
            raise HTTPException(400, "main 주소는 http(s):// 로 시작해야 합니다.")
        cfg["main_url"] = url
        cfg["token"] = (body.token or "").strip()
        cfg["read_only"] = bool(body.read_only)
        cfg["interval_min"] = max(0, min(1440, int(body.interval_min or 0)))
        cfg["live"] = bool(body.live)
        cfg["two_way"] = bool(body.two_way)
        cfg["projects"] = sorted({p for p in body.projects if registry.valid_name(p)})
        if not cfg["token"]:
            raise HTTPException(400, "main 에서 발급한 토큰을 붙여넣으세요.")
    else:
        cfg = {"role": ""}
    sync.write(svc, cfg)
    return _public(svc)


@router.get("/api/admin/services/{svc}/sync/projects")
def sync_project_choices(svc: str, _: models.User = Depends(require_portal_admin)):
    """What a sub can choose from: main's projects and this server's own."""
    import json as _json
    cfg = sync.read(svc)
    local = [p["name"] for p in pr.list_projects(svc)]
    main, err = [], None
    if cfg.get("role") == "sub" and cfg.get("main_url") and cfg.get("token"):
        try:
            main = _json.loads(_get(f"{cfg['main_url'].rstrip('/')}/api/sync/{svc}/projects",
                                    cfg["token"], timeout=10)).get("projects") or []
        except Exception as e:                   # noqa: BLE001
            err = f"main 연결 실패: {e}"
    return {"main": main, "local": local, "error": err}


@router.post("/api/admin/services/{svc}/sync/rotate")
def rotate_token(svc: str, _: models.User = Depends(require_portal_admin)):
    """New token on the main — every paired sub must be re-paired."""
    cfg = sync.read(svc)
    if cfg.get("role") != "main":
        raise HTTPException(409, "main 으로 설정된 서비스만 토큰을 발급합니다.")
    cfg["token"] = sync.new_token()
    sync.write(svc, cfg)
    return _public(svc)


def _get(url: str, token: str, timeout: int = 60) -> bytes:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _send(method: str, url: str, token: str, data: bytes = None, timeout: int = 120) -> bytes:
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {token}", "Content-Type": "application/octet-stream"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


class _Moved(Exception):
    """The file changed while we were deciding — the next round sees it."""


def _two_way_project(job_id: str, base: str, token: str, svc: str, proj: str) -> int:
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
        _log(job_id, f"  ! {proj}: 데이터베이스 파일이 있어 양방향으로 합칠 수 없습니다 — 건너뜀")
        return 0

    d = pr.project_dir(svc, proj)
    d.mkdir(parents=True, exist_ok=True)
    bdir = registry.service_dir(svc) / ".sync-base" / proj
    try:
        agreed = _json.loads((bdir / "manifest.json").read_text(encoding="utf-8"))
    except Exception:                            # noqa: BLE001 — first round
        agreed = {}
    sha = lambda b: hashlib.sha256(b).hexdigest()
    local = lambda rel: (d / rel)

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
                f = bdir / "files" / rel
                f.parent.mkdir(parents=True, exist_ok=True)
                f.write_bytes(raw)
    for rel in set(agreed) - set(now):
        (bdir / "files" / rel).unlink(missing_ok=True)
    bdir.mkdir(parents=True, exist_ok=True)
    (bdir / "manifest.json").write_text(_json.dumps(now, ensure_ascii=False), encoding="utf-8")
    _log(job_id, f"  ✓ {proj} — " + (f"{moved}개 파일 주고받음" if moved else "변경 없음"))
    return moved


def _pull_project(job_id: str, base: str, token: str, svc: str, proj: str) -> int:
    """Bring ONE project in line with main, transferring only what differs.
    Returns the bytes moved. Compares main's manifest against a manifest of the
    local copy built the exact same way, so identical files cost nothing."""
    import json as _json
    remote = _json.loads(_get(f"{base}/api/sync/{svc}/projects/{proj}/manifest", token))["files"]
    try:
        localm = pr.project_manifest(svc, proj)["files"]
    except FileNotFoundError:
        localm = {}                              # not here yet → everything is new

    changed = [p for p, m in remote.items()
               if localm.get(p, {}).get("sha256") != m["sha256"]]
    stale = [p for p in localm if p not in remote]
    if not changed and not stale:
        _log(job_id, f"  · {proj} 변경 없음")
        return 0

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
        if not str(dest).startswith(str(d.resolve())):
            continue                             # path-traversal guard
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(dest.name + ".sync-tmp")
        tmp.write_bytes(raw)
        os.replace(tmp, dest)
        moved += len(raw)
    for rel in stale:                            # file removed on main → remove here
        p = (d / rel).resolve()
        if str(p).startswith(str(d.resolve())) and p.is_file():
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


def _run_pull(job_id: str, svc: str, only: Optional[dict] = None) -> None:
    """Pull every project — or, from a live tick, just the ones in `only`
    ({project: the stamp main reported}), recording each stamp once it lands."""
    import json as _json
    cfg = sync.read(svc)
    base, token = (cfg.get("main_url") or "").rstrip("/"), cfg.get("token") or ""
    _set(job_id, status="running")
    try:
        if only is not None:
            names = sorted(only)
        else:
            listing = _json.loads(_get(f"{base}/api/sync/{svc}/projects", token))
            names = listing.get("projects") or []
    except urllib.error.HTTPError as e:
        return _set(job_id, status="error",
                    error=f"main 연결 실패 (HTTP {e.code}) — 주소/토큰을 확인하세요.")
    except Exception as e:                       # noqa: BLE001
        return _set(job_id, status="error", error=f"main 연결 실패: {e}")

    _log(job_id, f"· main 프로젝트 {len(names)}개: {', '.join(names) or '(없음)'}")
    local = {p["name"] for p in pr.list_projects(svc)}
    two_way = bool(cfg.get("two_way"))
    if two_way and only is None:
        names = sorted(set(names) | local)     # a project made here goes to main too
    picked = set(cfg.get("projects") or [])
    if picked:                                 # the operator chose which ones travel
        names = [n for n in names if n in picked]
    ok, moved = 0, 0
    for n in names:
        try:
            if two_way:
                moved += _two_way_project(job_id, base, token, svc, n)
            else:
                moved += _pull_project(job_id, base, token, svc, n)
            ok += 1
            if only is not None:
                _seen.setdefault(svc, {})[n] = only[n]
            if two_way:
                _seen_local.setdefault(svc, {})[n] = pr.project_stamp(svc, n)
        except Exception as e:                   # noqa: BLE001
            _log(job_id, f"  ! {n} 실패: {e}")
    extra = sorted(local - set(names)) if only is None and not two_way else []
    if extra:
        _log(job_id, f"· main 에 없는 로컬 프로젝트는 그대로 둡니다: {', '.join(extra)}")

    from datetime import datetime
    cfg = sync.read(svc)
    cfg["last_sync"] = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    cfg["last_error"] = None if ok == len(names) else f"{len(names) - ok}개 실패"
    sync.write(svc, cfg)
    _log(job_id, f"✓ 동기화 완료 — {ok}/{len(names)} 프로젝트, "
                 + (f"파일 {moved}개" if two_way else f"전송 {moved // 1024} KB"))
    _set(job_id, status="done" if ok == len(names) else "error",
         error=None if ok == len(names) else f"{len(names) - ok}개 프로젝트 실패")


def _start_pull(svc: str, only: Optional[dict] = None) -> Optional[str]:
    """Kick off a pull unless one is already running for this service. Returns the
    job id, or None when a sync is in flight (a slow pull must never stack up
    behind the scheduler's ticks)."""
    with _lock:
        if svc in _busy:
            return None
        _busy.add(svc)
        job_id = uuid.uuid4().hex[:12]
        _jobs[job_id] = {"status": "queued", "log": [], "error": None, "name": svc}

    def run():
        try:
            _run_pull(job_id, svc, only)
        finally:
            with _lock:
                _busy.discard(svc)

    threading.Thread(target=run, daemon=True).start()
    return job_id


@router.post("/api/admin/services/{svc}/sync/run", status_code=202)
def run_sync(svc: str, _: models.User = Depends(require_portal_admin)):
    cfg = sync.read(svc)
    if cfg.get("role") != "sub":
        raise HTTPException(409, "sub 로 설정된 서비스만 동기화를 받습니다.")
    if not cfg.get("main_url") or not cfg.get("token"):
        raise HTTPException(400, "main 주소와 토큰을 먼저 설정하세요.")
    job_id = _start_pull(svc)
    if not job_id:
        raise HTTPException(409, "이미 동기화가 진행 중입니다.")
    return {"job_id": job_id, "name": svc}


# ── permission transfer (explicit, never part of a data sync) ─────────────────
@router.post("/api/admin/services/{svc}/sync/grants")
def import_grants(svc: str, apply: bool = False,
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
    cfg = sync.read(svc)
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


def _due(svc: str) -> bool:
    cfg = sync.read(svc)
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


def _live_tick(svc: str) -> None:
    """A live mirror: ask main for its stamps (stat-only on main's side) and
    pull exactly the projects whose stamp moved since the last one brought in."""
    import json as _json
    cfg = sync.read(svc)
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
        for p in pr.list_projects(svc):
            n = p["name"]
            try:
                if mine.get(n) != pr.project_stamp(svc, n):
                    moved.setdefault(n, stamps.get(n))
            except FileNotFoundError:
                pass
    picked = set(cfg.get("projects") or [])
    if picked:
        moved = {p: st for p, st in moved.items() if p in picked}
    if moved:
        _start_pull(svc, moved)                   # None while a pull is in flight


def _is_live(svc: str) -> bool:
    cfg = sync.read(svc)
    return bool(cfg.get("role") == "sub" and cfg.get("live")
                and cfg.get("main_url") and cfg.get("token"))


def _scheduler() -> None:
    import time
    waited = 0
    while True:
        time.sleep(LIVE_S)
        waited += LIVE_S
        try:
            names = registry.list_service_names()
            for svc in names:
                if _is_live(svc):
                    _live_tick(svc)
            if waited >= TICK_S:                  # minute-scale mirrors, as before
                waited = 0
                for svc in names:
                    if not _is_live(svc) and _due(svc):
                        _start_pull(svc)          # None if one is still running
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
