"""
Cross-portal service sync — stage 1: manual mirror (main → sub).

main side  (token-authed, no portal account involved):
  GET /api/sync/{svc}/projects            → project list + service label
  GET /api/sync/{svc}/projects/{p}/export → consistent snapshot .zip

sub side (portal admin):
  GET/PUT /api/admin/services/{svc}/sync  → read/write the local sync config
  POST    /api/admin/services/{svc}/sync/run → pull every project from main

The sub PULLS: main never needs to reach the sub, so only the sub has to know a
URL + token and only main has to be reachable. Projects that exist on the sub but
not on main are LEFT ALONE — a mirror adds and replaces, it does not delete.
"""
from __future__ import annotations

import threading
import urllib.error
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


def _public(svc: str) -> dict:
    cfg = sync.read(svc)
    return {"role": cfg.get("role", ""), "main_url": cfg.get("main_url"),
            "token": cfg.get("token"), "read_only": cfg.get("read_only", True),
            "last_sync": cfg.get("last_sync"), "last_error": cfg.get("last_error"),
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
    ok = 0
    for n in names:
        try:
            _log(job_id, f"· {n} 내려받는 중…")
            raw = _get(f"{base}/api/sync/{svc}/projects/{n}/export", token, timeout=600)
            pr.stop_project(svc, n)              # release the DB before replacing it
            pr.import_project(svc, raw, n, replace=True)
            ok += 1
            _log(job_id, f"  ✓ {n} ({len(raw) // 1024} KB)")
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
    _log(job_id, f"✓ 동기화 완료 — {ok}/{len(names)}")
    _set(job_id, status="done" if ok == len(names) else "error",
         error=None if ok == len(names) else f"{len(names) - ok}개 프로젝트 실패")


@router.post("/api/admin/services/{svc}/sync/run", status_code=202)
def run_sync(svc: str, _: models.User = Depends(require_portal_admin)):
    cfg = sync.read(svc)
    if cfg.get("role") != "sub":
        raise HTTPException(409, "sub 로 설정된 서비스만 동기화를 받습니다.")
    if not cfg.get("main_url") or not cfg.get("token"):
        raise HTTPException(400, "main 주소와 토큰을 먼저 설정하세요.")
    job_id = uuid.uuid4().hex[:12]
    with _lock:
        _jobs[job_id] = {"status": "queued", "log": [], "error": None, "name": svc}
    threading.Thread(target=_run_pull, args=(job_id, svc), daemon=True).start()
    return {"job_id": job_id, "name": svc}


@router.get("/api/admin/services/{svc}/sync/jobs/{job_id}")
def sync_job(svc: str, job_id: str, _: models.User = Depends(require_portal_admin)):
    with _lock:
        job = _jobs.get(job_id)
        if not job:
            raise HTTPException(404, "job을 찾을 수 없습니다.")
        return {"status": job["status"], "error": job["error"], "log": job["log"][-60:]}
