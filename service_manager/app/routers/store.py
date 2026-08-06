"""
Service store — install catalog services from git, and rebuild the portal, from
the admin-only "Service Manager" Home card.

The portal is generic over services (manifest + adapter), so nothing requires the
service repos to be present at install time. This router closes the loop: a fresh
host needs only the portal repo — every other service is `git clone`d + built on
demand from `app/store_catalog.json`, then registered exactly like a hand-cloned
one. The committed seed manifest (deploy/seed/<name>/service.json) is the source
of truth for the service's manifest; its container paths (/app/<dir>) are re-rooted
at the local stack directory, which also fixes the per-machine `start.cwd` chore.

Long steps (clone / npm build / pip install) run as async jobs the UI polls —
the same pattern as scaffold.py.
"""
from __future__ import annotations

import json
import subprocess
import sys
import threading
import uuid
from pathlib import Path
from shutil import which
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import config, models, registry
from ..db import SessionLocal
from ..deps import require_portal_admin
from .scaffold import LILAK_UI_PATH, SEED_ROOT, SERVICES_ROOT
from .services import get_or_create_service

router = APIRouter(tags=["portal-store"])

CATALOG_PATH = Path(__file__).resolve().parent.parent / "store_catalog.json"

# In-memory job store (single-worker portal process), same shape as scaffold's.
_jobs: dict[str, dict] = {}
_lock = threading.Lock()


def _catalog() -> dict:
    return json.loads(CATALOG_PATH.read_text(encoding="utf-8"))


def _entry(name: str) -> Optional[dict]:
    return next((e for e in _catalog()["services"] if e["name"] == name), None)


def _set(job_id: str, **kw) -> None:
    with _lock:
        _jobs[job_id].update(kw)


def _log(job_id: str, msg: str) -> None:
    with _lock:
        _jobs[job_id]["log"].append(msg)


def _tool(name: str) -> Optional[str]:
    """Locate a CLI tool, checking the usual GUI-less launchd paths too."""
    for c in (name, f"/opt/homebrew/bin/{name}", f"/usr/local/bin/{name}", f"/usr/bin/{name}"):
        p = which(c) if "/" not in c else (c if Path(c).exists() else None)
        if p:
            return p
    return None


def _stream(job_id: str, argv: list[str], cwd: Optional[Path] = None,
            env_extra: Optional[dict] = None) -> int:
    """Run a command, streaming its output into the job log. Returns the exit code."""
    import os
    _log(job_id, "$ " + " ".join(argv))
    env = {**os.environ, **(env_extra or {})}
    try:
        proc = subprocess.Popen(argv, cwd=str(cwd) if cwd else None, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, bufsize=1)
        assert proc.stdout is not None
        for line in proc.stdout:
            _log(job_id, line.rstrip())
        return proc.wait()
    except Exception as e:                       # noqa: BLE001
        _log(job_id, f"! {e}")
        return -1


def _build_frontend(job_id: str, repo_dir: Path, needs_kit: bool) -> bool:
    """npm install + build the first frontend found (frontend/ then repo root).
    Returns False only on a FAILED build; no frontend at all is fine (backend-only)."""
    fe = next((d for d in (repo_dir / "frontend", repo_dir) if (d / "package.json").exists()), None)
    if fe is None:
        _log(job_id, "· 프론트엔드 없음 — 빌드 생략")
        return True
    npm = _tool("npm")
    if not npm:
        _log(job_id, "! npm을 찾을 수 없습니다 (Node 설치 필요)")
        return False
    env = {"LILAK_UI_PATH": str(LILAK_UI_PATH)} if needs_kit else {}
    if not (fe / "node_modules").exists():
        if _stream(job_id, [npm, "install", "--no-audit", "--no-fund"], cwd=fe, env_extra=env) != 0:
            return False
    return _stream(job_id, [npm, "run", "build"], cwd=fe, env_extra=env) == 0


def _pip_install(job_id: str, repo_dir: Path) -> bool:
    """pip install the first requirements file found into the SHARED portal venv
    (the venv that spawns managed backends). Missing file = nothing to do."""
    req = next((p for p in (repo_dir / "requirements.txt", repo_dir / "backend" / "requirements.txt")
                if p.exists()), None)
    if req is None:
        _log(job_id, "· requirements 없음 — pip 생략")
        return True
    return _stream(job_id, [sys.executable, "-m", "pip", "install", "-q", "-r", str(req)]) == 0


def _register(job_id: str, name: str, entry: dict) -> bool:
    """Write the manifest (seed re-rooted at the local stack) + the DB row."""
    seed = SEED_ROOT / name / "service.json"
    if not seed.exists():
        _log(job_id, f"! seed 매니페스트 없음: {seed}")
        return False
    m = json.loads(seed.read_text(encoding="utf-8"))
    st = m.get("start") or {}
    for k in ("cwd", "cmd"):
        v = st.get(k)
        if isinstance(v, str) and "/app/" in v:
            st[k] = v.replace("/app/", f"{SERVICES_ROOT}/")
    m["start"] = st
    # Seeds may omit display fields (or carry explicit nulls) — fill from the
    # catalog so the card looks right.
    if not m.get("icon"):
        m["icon"] = entry.get("icon")
    if not m.get("color"):
        m["color"] = entry.get("color")
    registry.write_manifest(name, m)
    db = SessionLocal()
    try:
        get_or_create_service(db, name, m.get("kind") or "generic")
        db.commit()
    finally:
        db.close()
    _log(job_id, f"✓ 등록 완료 — 홈에 '{name}' 카드가 나타납니다")
    return True


def _run_install(job_id: str, entry: dict) -> None:
    git = _tool("git")
    if not git:
        return _set(job_id, status="error", error="git을 찾을 수 없습니다.")
    _set(job_id, status="running")

    # The shared UI kit first — service frontends are built against its source.
    if entry.get("needs_kit") and not LILAK_UI_PATH.exists():
        kit = _catalog().get("kit") or {}
        _log(job_id, "· lilak_ui (공용 UI 킷) 클론")
        if _stream(job_id, [git, "clone", "--depth", "1", kit.get("repo", ""), str(LILAK_UI_PATH)]) != 0:
            return _set(job_id, status="error", error="lilak_ui 클론 실패")

    repo_dir = SERVICES_ROOT / entry["dir"]
    if not repo_dir.exists():
        if _stream(job_id, [git, "clone", "--depth", "1", entry["repo"], str(repo_dir)]) != 0:
            return _set(job_id, status="error", error="git clone 실패 (레포 주소/네트워크 확인)")
    else:
        _log(job_id, f"· 코드 이미 존재: {repo_dir} — 클론 생략")

    if not _build_frontend(job_id, repo_dir, bool(entry.get("needs_kit"))):
        return _set(job_id, status="error", error="프론트엔드 빌드 실패")
    if not _pip_install(job_id, repo_dir):
        return _set(job_id, status="error", error="백엔드 의존성 설치 실패")
    if not _register(job_id, entry["name"], entry):
        return _set(job_id, status="error", error="서비스 등록 실패")
    _set(job_id, status="done")


def _run_build_portal(job_id: str, pull: bool) -> None:
    git = _tool("git")
    _set(job_id, status="running")
    if pull:
        if not git:
            return _set(job_id, status="error", error="git을 찾을 수 없습니다.")
        # ff-only so local (uncommitted or diverged) work is never rewritten.
        if _stream(job_id, [git, "-C", str(SERVICES_ROOT), "pull", "--ff-only"]) != 0:
            return _set(job_id, status="error",
                        error="git pull 실패 (로컬 변경/분기 확인 — 수동으로 정리 후 다시 시도)")
    fe = config.ROOT / "frontend"
    npm = _tool("npm")
    if not npm:
        return _set(job_id, status="error", error="npm을 찾을 수 없습니다.")
    env = {"LILAK_UI_PATH": str(LILAK_UI_PATH)}
    if not (fe / "node_modules").exists():
        if _stream(job_id, [npm, "install", "--no-audit", "--no-fund"], cwd=fe, env_extra=env) != 0:
            return _set(job_id, status="error", error="npm install 실패")
    if _stream(job_id, [npm, "run", "build"], cwd=fe, env_extra=env) != 0:
        return _set(job_id, status="error", error="포털 빌드 실패")
    # dist is read per-request (FileResponse), so the new build serves immediately;
    # backend code changes are picked up by uvicorn --reload.
    _log(job_id, "✓ 포털 빌드 완료 — 새로고침하면 반영됩니다")
    _set(job_id, status="done")


def _spawn(target, *args, name: str) -> str:
    job_id = uuid.uuid4().hex[:12]
    with _lock:
        _jobs[job_id] = {"status": "queued", "log": [], "error": None, "name": name}
    threading.Thread(target=target, args=(job_id, *args), daemon=True).start()
    return job_id


# ── API ───────────────────────────────────────────────────────────────────────
@router.get("/api/admin/store")
def store_list(_: models.User = Depends(require_portal_admin)):
    out = []
    for e in _catalog()["services"]:
        out.append({
            "name": e["name"], "dir": e["dir"], "repo": e["repo"], "label": e.get("label"),
            "icon": e.get("icon"), "color": e.get("color"), "ko": e.get("ko"), "en": e.get("en"),
            "code_present": (SERVICES_ROOT / e["dir"]).exists(),
            "registered": registry.manifest_path(e["name"]).exists(),
        })
    return {"services": out, "stack_root": str(SERVICES_ROOT)}


class InstallBody(BaseModel):
    name: str


@router.post("/api/admin/store/install", status_code=202)
def store_install(body: InstallBody, _: models.User = Depends(require_portal_admin)):
    entry = _entry((body.name or "").strip())
    if not entry:
        raise HTTPException(404, "카탈로그에 없는 서비스입니다.")
    if (config.DATA_ROOT / entry["name"] / "service.json").exists():
        raise HTTPException(409, f"'{entry['name']}' 이(가) 이미 등록되어 있습니다.")
    job_id = _spawn(_run_install, entry, name=entry["name"])
    return {"job_id": job_id, "name": entry["name"]}


class BuildBody(BaseModel):
    pull: bool = False


@router.post("/api/admin/store/build-portal", status_code=202)
def store_build_portal(body: BuildBody, _: models.User = Depends(require_portal_admin)):
    job_id = _spawn(_run_build_portal, bool(body.pull), name="portal")
    return {"job_id": job_id, "name": "portal"}


@router.get("/api/admin/store/jobs/{job_id}")
def store_job(job_id: str, _: models.User = Depends(require_portal_admin)):
    with _lock:
        job = _jobs.get(job_id)
        if not job:
            raise HTTPException(404, "job을 찾을 수 없습니다.")
        return {"status": job["status"], "error": job["error"],
                "name": job["name"], "log": job["log"][-80:]}
