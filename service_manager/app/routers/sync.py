"""
Cross-portal service sync — mirror a service's project data (main → sub).

main side  (token-authed, no portal account involved):
  GET /api/sync/{svc}/projects            → project list + service label
  GET /api/sync/{svc}/projects/{p}/export → consistent snapshot .zip

sub side (portal admin):
  GET/PUT /api/admin/services/{svc}/sync  → read/write the local sync config
  POST    /api/admin/services/{svc}/sync/run → pull every project from main

A sub with interval_min > 0 is also pulled automatically by a background poller.

The sub PULLS: main never needs to reach the sub, so only the sub has to know a
URL + token and only main has to be reachable. Projects that exist on the sub but
not on main are LEFT ALONE — a mirror adds and replaces, it does not delete.
"""
from __future__ import annotations

import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel

from .. import config, models, project_runtime as pr, registry, security, sync
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


@router.get("/api/sync/{svc}/projects/{proj}/manifest")
def sync_manifest(svc: str, proj: str, authorization: Optional[str] = Header(default=None)):
    _require_sync_token(svc, authorization)
    try:
        return pr.project_manifest(svc, proj)
    except FileNotFoundError:
        raise HTTPException(404, f"'{proj}' 없음")


@router.get("/api/sync/{svc}/projects/{proj}/file")
def sync_file(svc: str, proj: str, path: str, authorization: Optional[str] = Header(default=None)):
    _require_sync_token(svc, authorization)
    try:
        return Response(content=pr.project_file(svc, proj, path),
                        media_type="application/octet-stream")
    except FileNotFoundError:
        raise HTTPException(404, f"'{path}' 없음")


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


def _public(svc: str) -> dict:
    cfg = sync.read(svc)
    return {"role": cfg.get("role", ""), "main_url": cfg.get("main_url"),
            "token": cfg.get("token"), "read_only": cfg.get("read_only", True),
            "last_sync": cfg.get("last_sync"), "last_error": cfg.get("last_error"),
            "interval_min": int(cfg.get("interval_min") or 0),
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
        cfg.pop("main_url", None)
    elif body.role == "sub":
        url = (body.main_url or "").strip().rstrip("/")
        if not url.startswith(("http://", "https://")):
            raise HTTPException(400, "main 주소는 http(s):// 로 시작해야 합니다.")
        cfg["main_url"] = url
        cfg["token"] = (body.token or "").strip()
        cfg["read_only"] = bool(body.read_only)
        cfg["interval_min"] = max(0, min(1440, int(body.interval_min or 0)))
        if not cfg["token"]:
            raise HTTPException(400, "main 에서 발급한 토큰을 붙여넣으세요.")
    else:
        cfg = {"role": ""}
    sync.write(svc, cfg)
    return _public(svc)


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
    pr.stop_project(svc, proj)                   # release the DB before writing it
    d.mkdir(parents=True, exist_ok=True)
    moved = 0
    for rel in changed:
        raw = _get(f"{base}/api/sync/{svc}/projects/{proj}/file?path={urllib.parse.quote(rel)}",
                   token, timeout=600)
        dest = (d / rel).resolve()
        if not str(dest).startswith(str(d.resolve())):
            continue                             # path-traversal guard
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(raw)
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


def _run_pull(job_id: str, svc: str) -> None:
    import json as _json
    cfg = sync.read(svc)
    base, token = (cfg.get("main_url") or "").rstrip("/"), cfg.get("token") or ""
    _set(job_id, status="running")
    try:
        listing = _json.loads(_get(f"{base}/api/sync/{svc}/projects", token))
        names = listing.get("projects") or []
    except urllib.error.HTTPError as e:
        return _set(job_id, status="error",
                    error=f"main 연결 실패 (HTTP {e.code}) — 주소/토큰을 확인하세요.")
    except Exception as e:                       # noqa: BLE001
        return _set(job_id, status="error", error=f"main 연결 실패: {e}")

    _log(job_id, f"· main 프로젝트 {len(names)}개: {', '.join(names) or '(없음)'}")
    local = {p["name"] for p in pr.list_projects(svc)}
    ok, moved = 0, 0
    for n in names:
        try:
            moved += _pull_project(job_id, base, token, svc, n)
            ok += 1
        except Exception as e:                   # noqa: BLE001
            _log(job_id, f"  ! {n} 실패: {e}")
    extra = sorted(local - set(names))
    if extra:
        _log(job_id, f"· main 에 없는 로컬 프로젝트는 그대로 둡니다: {', '.join(extra)}")

    from datetime import datetime
    cfg = sync.read(svc)
    cfg["last_sync"] = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    cfg["last_error"] = None if ok == len(names) else f"{len(names) - ok}개 실패"
    sync.write(svc, cfg)
    _log(job_id, f"✓ 동기화 완료 — {ok}/{len(names)} 프로젝트, 전송 {moved // 1024} KB")
    _set(job_id, status="done" if ok == len(names) else "error",
         error=None if ok == len(names) else f"{len(names) - ok}개 프로젝트 실패")


def _start_pull(svc: str) -> Optional[str]:
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
            _run_pull(job_id, svc)
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


# ── periodic auto-pull ────────────────────────────────────────────────────────
TICK_S = 20                      # how often the scheduler re-checks what is due


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


def _scheduler() -> None:
    import time
    while True:
        time.sleep(TICK_S)
        try:
            for svc in registry.list_service_names():
                if _due(svc):
                    _start_pull(svc)              # None if one is still running
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
