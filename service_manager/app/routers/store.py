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
from shutil import rmtree, which
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import config, models, registry
from .. import project_runtime as pr
from ..db import SessionLocal
from ..deps import require_portal_admin
from .scaffold import LILAK_UI_PATH, SEED_ROOT, SERVICES_ROOT, ensure_kit
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


# git must never block a job thread on a credential prompt.
NO_PROMPT = {"GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "", "SSH_ASKPASS": ""}


def _ensure_kit(job_id: str) -> bool:
    """Clone the shared UI kit + install its node_modules — see scaffold.ensure_kit."""
    return ensure_kit(lambda m: _log(job_id, m))


def _frontend_dir(repo_dir: Path) -> Optional[Path]:
    """The service's frontend: `frontend/` if it has a package.json, else the repo
    root (asset_manager keeps its app at the root). None = backend-only service."""
    return next((d for d in (repo_dir / "frontend", repo_dir) if (d / "package.json").exists()), None)


def _is_vendored(repo_dir: Path) -> bool:
    """True when repo_dir holds code we did NOT clone and must not try to manage as a
    checkout — i.e. the copy the Docker image bakes in (COPY lilak_elog /app/... ;
    .dockerignore strips **/.git, so a baked service has code but no .git). A dev
    machine's stack dir is a real checkout and keeps the git path below."""
    return repo_dir.exists() and not (repo_dir / ".git").exists()


def _prebuilt(repo_dir: Path) -> bool:
    """True when the frontend dist is already there (the image builds every dist in
    stage 1), or the service has no frontend at all."""
    fe = _frontend_dir(repo_dir)
    return fe is None or (fe / "dist").is_dir()


def _build_frontend(job_id: str, repo_dir: Path, needs_kit: bool) -> bool:
    """npm install + build the first frontend found (frontend/ then repo root).
    Returns False only on a FAILED build; no frontend at all is fine (backend-only)."""
    fe = _frontend_dir(repo_dir)
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


def _pip_install(job_id: str, repo_dir: Path, entry: dict) -> bool:
    """pip install the first requirements file found into the SHARED portal venv
    (the venv that spawns managed backends). Missing file = nothing to do."""
    req = next((p for p in (repo_dir / "requirements.txt", repo_dir / "backend" / "requirements.txt")
                if p.exists()), None)
    # A bundle's own Python packages (lilak_rack's `rackstore`), installed in place.
    for pkg in entry.get("pip", []):
        if _stream(job_id, [sys.executable, "-m", "pip", "install", "-q", "-e", str(repo_dir / pkg)]) != 0:
            return False
    if req is None:
        _log(job_id, "· requirements 없음 — pip 생략")
        return True
    return _stream(job_id, [sys.executable, "-m", "pip", "install", "-q", "-r", str(req)]) == 0


def _members(entry: dict) -> list[tuple[str, Path]]:
    """(service name, its code dir) for every service the entry installs: one, or —
    for a bundle (lilak_rack: the rack services and the racklist frame they are all
    built on, which need one another) — each `bundle` name, a folder of the checkout."""
    repo_dir = SERVICES_ROOT / entry["dir"]
    return [(n, repo_dir / n) for n in entry["bundle"]] if entry.get("bundle") else [(entry["name"], repo_dir)]


def _registered(entry: dict) -> bool:
    return all(registry.manifest_path(n).exists() for n, _ in _members(entry))


def _register(job_id: str, name: str, entry: dict) -> bool:
    """Write the manifest (seed re-rooted at the local stack) + the DB row. A bundle
    carries its seeds (`seed/<name>/`); a service already registered keeps its own
    manifest (it may hold an admin's edits), and a missing entry project is made."""
    if entry.get("bundle") and registry.manifest_path(name).exists():
        _log(job_id, f"· '{name}' 이미 등록됨 — 그대로 둡니다")
        return True
    seed = SERVICES_ROOT / entry["dir"] / "seed" / name / "service.json"
    if not seed.exists():
        seed = SEED_ROOT / name / "service.json"
    if not seed.exists():
        _log(job_id, f"! seed 매니페스트 없음: {seed}")
        return False
    m = json.loads(seed.read_text(encoding="utf-8"))
    st = m.get("start") or {}

    def _reroot(v):
        """Container path (/app/<dir>) → this host's stack dir. Seeds are written for
        the Docker image, so cwd/cmd AND env values (e.g. ASSET_DIST_DIR) carry /app."""
        return v.replace("/app/", f"{SERVICES_ROOT}/") if isinstance(v, str) and "/app/" in v else v

    for k in ("cwd", "cmd"):
        st[k] = _reroot(st.get(k))
    st["env"] = {k: _reroot(v) for k, v in (st.get("env") or {}).items()}
    m["start"] = st
    # Seeds may omit display fields (or carry explicit nulls) — fill from the
    # catalog so the card looks right.
    if not m.get("icon"):
        m["icon"] = entry.get("icon")
    if not m.get("color"):
        m["color"] = entry.get("color")
    registry.write_manifest(name, m)
    # The project its card opens (and other services ask for its tags) must exist.
    proj = m.get("entry_project")
    if proj and not pr.project_dir(name, proj).exists():
        pr.create_project(name, proj)
    db = SessionLocal()
    try:
        get_or_create_service(db, name, m.get("kind") or "generic")
        db.commit()
    finally:
        db.close()
    _log(job_id, f"✓ 등록 완료 — 홈에 '{name}' 카드가 나타납니다")
    return True


def _rollback(job_id: str, repo_dir: Path) -> None:
    """Delete a checkout this job created, so a failed install can be retried instead
    of being skipped as "코드 이미 존재" on the next attempt."""
    try:
        rmtree(repo_dir, ignore_errors=True)
        _log(job_id, f"· 실패 — 받다 만 {repo_dir.name}/ 를 정리했습니다")
    except Exception as e:                       # noqa: BLE001
        _log(job_id, f"⚠ 정리 실패: {e}")


def _run_install(job_id: str, entry: dict) -> None:
    repo_dir = SERVICES_ROOT / entry["dir"]

    # In the container the code is ALREADY here — the image bakes every catalog
    # service and its built dist — so installing is purely REGISTERING. Taking the
    # git path here would be worse than useless: SERVICES_ROOT (/app) is an image
    # layer, not the data volume, so a clone/npm/pip would be thrown away by the next
    # `docker compose up --build` while the manifest in /app/data survived — leaving a
    # registered service whose code is gone. Register-only needs no git, no network,
    # and writes solely to the volume, so it survives a rebuild.
    members = _members(entry)
    if _is_vendored(repo_dir) and all(_prebuilt(d) for _, d in members):
        _set(job_id, status="running")
        _log(job_id, f"· 코드가 이미 있습니다 ({repo_dir}) — 내려받기/빌드 없이 등록만 합니다")
        if not all(_register(job_id, n, entry) for n, _ in members):
            return _set(job_id, status="error", error="서비스 등록 실패")
        return _set(job_id, status="done")

    # Source install (dev machine, or a service the image does not carry).
    git = _tool("git")
    if not git:
        return _set(job_id, status="error", error="git을 찾을 수 없습니다.")
    _set(job_id, status="running")

    # The shared UI kit first — service frontends are built against its source.
    if entry.get("needs_kit") and not _ensure_kit(job_id):
        return _set(job_id, status="error", error="lilak_ui (공용 UI 킷) 준비 실패")

    cloned_here = False
    if not repo_dir.exists():
        # `branch` matters: a service's portal-ready code may live off the default
        # branch (asset_manager's LILAK port is on `lilak-ui-frontend`, while its
        # main is still the pre-portal app).
        argv = [git, "clone", "--depth", "1"]
        if entry.get("branch"):
            argv += ["--branch", entry["branch"]]
        if _stream(job_id, argv + [entry["repo"], str(repo_dir)], env_extra=NO_PROMPT) != 0:
            _rollback(job_id, repo_dir)
            hint = ("비공개 레포입니다 — 이 서버에 GitHub 접근 권한(SSH 키)이 필요합니다."
                    if entry.get("private") else "레포 주소/브랜치/네트워크를 확인하세요.")
            return _set(job_id, status="error", error=f"git clone 실패 — {hint}")
        cloned_here = True
    else:
        _log(job_id, f"· 코드 이미 존재: {repo_dir} — 클론 생략")

    def fail(msg: str):
        # Only undo what THIS job created: a checkout that was already there (or the
        # user's own working copy) must survive a failed install.
        if cloned_here:
            _rollback(job_id, repo_dir)
        return _set(job_id, status="error", error=msg)

    if not all(_build_frontend(job_id, d, bool(entry.get("needs_kit"))) for _, d in members):
        return fail("프론트엔드 빌드 실패")
    if not _pip_install(job_id, repo_dir, entry):
        return fail("백엔드 의존성 설치 실패")
    if not all(_register(job_id, n, entry) for n, _ in members):
        return fail("서비스 등록 실패")
    _set(job_id, status="done")


def _run_update(job_id: str, entry: dict) -> None:
    """Refresh an installed service: git pull --ff-only, then rebuild + reinstall deps.
    ff-only so local edits/divergence are never rewritten — the operator sorts those
    out by hand. The manifest is left alone (it may carry admin edits)."""
    git = _tool("git")
    repo_dir = SERVICES_ROOT / entry["dir"]
    if not git:
        return _set(job_id, status="error", error="git을 찾을 수 없습니다.")
    if not (repo_dir / ".git").exists():
        return _set(job_id, status="error", error=f"git 체크아웃이 아닙니다: {repo_dir}")
    _set(job_id, status="running")
    if entry.get("needs_kit") and not _ensure_kit(job_id):
        return _set(job_id, status="error", error="lilak_ui (공용 UI 킷) 준비 실패")
    if _stream(job_id, [git, "-C", str(repo_dir), "pull", "--ff-only"], env_extra=NO_PROMPT) != 0:
        return _set(job_id, status="error",
                    error="git pull 실패 — 로컬 변경/분기 여부를 확인하세요 (ff-only).")
    if not all(_build_frontend(job_id, d, bool(entry.get("needs_kit"))) for _, d in _members(entry)):
        return _set(job_id, status="error", error="프론트엔드 빌드 실패")
    if not _pip_install(job_id, repo_dir, entry):
        return _set(job_id, status="error", error="백엔드 의존성 설치 실패")
    _log(job_id, "✓ 업데이트 완료 — 실행 중이면 서비스를 재시작하세요")
    _set(job_id, status="done")


def _run_build_portal(job_id: str, pull: bool) -> None:
    git = _tool("git")
    _set(job_id, status="running")
    if pull:
        if not git:
            return _set(job_id, status="error", error="git을 찾을 수 없습니다.")
        # ff-only so local (uncommitted or diverged) work is never rewritten.
        clean = _clean_submodules(git)
        if _stream(job_id, [git, "-C", str(SERVICES_ROOT), "pull", "--ff-only"], env_extra=NO_PROMPT) != 0:
            return _set(job_id, status="error",
                        error="git pull 실패 (로컬 변경/분기 확인 — 수동으로 정리 후 다시 시도)")
        # Submodules follow the new commit only where nobody was working in
        # them: one checked out at another commit is someone's work, left alone.
        if clean and _stream(job_id, [git, "-C", str(SERVICES_ROOT), "submodule", "update", "--", *clean],
                             env_extra=NO_PROMPT) != 0:
            return _set(job_id, status="error", error="서브모듈 업데이트 실패")
    # The portal's own frontend is built against the kit source too.
    if not _ensure_kit(job_id):
        return _set(job_id, status="error", error="lilak_ui (공용 UI 킷) 준비 실패")
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


def _clean_submodules(git: str) -> list[str]:
    """Submodules (listed in .gitmodules, checked out) sitting exactly at the
    recorded commit with nothing edited in them. Path by path: `git submodule status` stops at the first
    gitlink .gitmodules does not know."""
    def run(*a, cwd=SERVICES_ROOT):
        try:
            r = subprocess.run([git, "-C", str(cwd), *a], capture_output=True, text=True, timeout=30)
            return r.stdout if r.returncode == 0 else ""
        except Exception:                        # noqa: BLE001
            return ""
    known = {ln.split()[1] for ln in run("config", "-f", ".gitmodules", "--get-regexp", r"\.path$").splitlines()
             if len(ln.split()) == 2}
    out = []
    for ln in run("ls-files", "--stage").splitlines():
        meta, _, path = ln.partition("\t")
        mode, sha = meta.split()[:2]
        if mode == "160000" and path in known and (SERVICES_ROOT / path / ".git").exists() \
                and run("rev-parse", "HEAD", cwd=SERVICES_ROOT / path).strip() == sha \
                and not run("status", "--porcelain", "--untracked-files=no", cwd=SERVICES_ROOT / path).strip():
            out.append(path)
    return out


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
            "private": bool(e.get("private")),
            "code_present": (SERVICES_ROOT / e["dir"]).exists(),
            "registered": _registered(e),
            "bundle": e.get("bundle") or [],
        })
    return {"services": out, "stack_root": str(SERVICES_ROOT)}


class InstallBody(BaseModel):
    name: str


@router.post("/api/admin/store/install", status_code=202)
def store_install(body: InstallBody, _: models.User = Depends(require_portal_admin)):
    entry = _entry((body.name or "").strip())
    if not entry:
        raise HTTPException(404, "카탈로그에 없는 서비스입니다.")
    if _registered(entry):
        raise HTTPException(409, f"'{entry['name']}' 이(가) 이미 등록되어 있습니다.")
    job_id = _spawn(_run_install, entry, name=entry["name"])
    return {"job_id": job_id, "name": entry["name"]}


@router.post("/api/admin/store/update", status_code=202)
def store_update(body: InstallBody, _: models.User = Depends(require_portal_admin)):
    entry = _entry((body.name or "").strip())
    if not entry:
        raise HTTPException(404, "카탈로그에 없는 서비스입니다.")
    if not (SERVICES_ROOT / entry["dir"]).exists():
        raise HTTPException(409, f"'{entry['name']}' 코드가 없습니다 — 먼저 설치하세요.")
    job_id = _spawn(_run_update, entry, name=entry["name"])
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
