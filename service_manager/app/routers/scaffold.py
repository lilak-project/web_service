"""
Admin "create an empty service" — scaffold a lilak_ui-based service and register
it, with an async build job the Home UI polls.

Live + persistent by design: the generator (`scripts/new-service.mjs --data-service`)
writes the WHOLE service — frontend + backend + manifest — self-contained under
`PORTAL_DATA_ROOT/<name>/`, i.e. into the data volume, so a created service survives
image rebuilds (the data dir is a host bind mount). The frontend is built once at
creation (`--build`, needs node+npm + the lilak_ui source); the backend then runs
on the shared venv, and the portal proxy serves the built `dist`.

Because the build takes time, creation returns a job id immediately and the caller
polls `/api/admin/services/scaffold/{job_id}` for progress/log/status.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
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
from .services import get_or_create_service

router = APIRouter(tags=["portal-scaffold"])

# Paths to the generator + kit source. Overridable for Docker, where they live at
# fixed image locations (see the Dockerfile).
SCAFFOLD_SCRIPT = Path(os.environ.get(
    "PORTAL_SCAFFOLD_SCRIPT", str(config.ROOT.parent / "scripts" / "new-service.mjs")))
LILAK_UI_PATH = Path(os.environ.get(
    "LILAK_UI_PATH", str(config.ROOT.parent / "lilak_ui")))
# Where a new service's CODE is written — the stack root (web_service/), same as
# every other service. Its manifest goes to data/<name>/service.json and its
# runtime data to data/<name>/ (standard layout), NOT the code into data/.
SERVICES_ROOT = Path(os.environ.get("PORTAL_SERVICES_ROOT", str(config.ROOT.parent)))
# Committed seed manifests (copied into the data volume on a fresh deploy → the
# service is pre-registered). Writing one here makes a scaffolded service deploy
# exactly like the built-in ones once committed.
SEED_ROOT = Path(os.environ.get("PORTAL_SEED_ROOT", str(config.ROOT / "deploy" / "seed")))
# Optional prebuilt node_modules shared by all generated services (set in Docker) —
# makes the frontend build offline + fast (no per-service npm install).
SVC_NODE_MODULES = os.environ.get("PORTAL_SVC_NODE_MODULES", "").strip()

_NAME_RE = re.compile(r"^[a-z][a-z0-9_]*$")

# In-memory job store — fine for the single-worker portal process (dev + Docker).
_jobs: dict[str, dict] = {}
_lock = threading.Lock()


class TabSpec(BaseModel):
    id: str
    label: str
    icon: str = "circle"
    kind: str = ""                  # '' = placeholder; 'community' = built-in chat tab


class ScaffoldBody(BaseModel):
    name: str
    service: str = "app"            # brand subtitle (라일락 / <service>)
    brand: str = "라일락"
    icon: str = "lilak"             # service mark shown on its Home card
    tabs: list[TabSpec] = []
    color: str = "#000000"
    settings: bool = False
    command_bar: bool = True         # collapsible bottom `/` command bar


def _tabs_arg(tabs: list[TabSpec]) -> str:
    parts = []
    for t in tabs:
        tid = re.sub(r"[^a-z0-9_]", "", (t.id or "").lower())
        label = (t.label or tid).strip().replace(",", " ").replace(":", " ")
        icon = re.sub(r"[^a-z0-9_-]", "", (t.icon or "circle").lower()) or "circle"
        kind = re.sub(r"[^a-z]", "", (t.kind or "").lower())      # 'community' or ''
        if tid:
            parts.append(f"{tid}:{label}:{icon}:{kind}" if kind else f"{tid}:{label}:{icon}")
    return ",".join(parts) or "home:home:home"


def _node() -> Optional[str]:
    for c in ("node", "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"):
        p = which(c) if "/" not in c else (c if Path(c).exists() else None)
        if p:
            return p
    return None


def _set(job_id: str, **kw) -> None:
    with _lock:
        _jobs[job_id].update(kw)


def _log(job_id: str, msg: str) -> None:
    with _lock:
        _jobs[job_id]["log"].append(msg)


def _run_job(job_id: str, body: ScaffoldBody) -> None:
    node = _node()
    if not node:
        return _set(job_id, status="error", error="node 실행 파일을 찾을 수 없습니다 (서버에 Node 필요).")
    if not SCAFFOLD_SCRIPT.exists():
        return _set(job_id, status="error", error=f"스캐폴드 스크립트 없음: {SCAFFOLD_SCRIPT}")

    argv = [
        node, str(SCAFFOLD_SCRIPT),
        "--name", body.name,
        "--service", body.service or "app",
        "--brand", body.brand or "라일락",
        "--icon", re.sub(r"[^a-z0-9_-]", "", (body.icon or "lilak").lower()) or "lilak",
        "--tabs", _tabs_arg(body.tabs),
        "--color", (body.color or "#000000").lower(),
        "--out", str(SERVICES_ROOT),        # code → web_service/<name>/ (standard layout)
        "--lilak-ui", str(LILAK_UI_PATH),
        "--build",
    ]
    if SVC_NODE_MODULES:
        argv += ["--shared-modules", SVC_NODE_MODULES]
    if body.settings:
        argv.append("--settings")
    if not body.command_bar:
        argv.append("--no-command-bar")

    _set(job_id, status="running")
    _log(job_id, f"$ new-service.mjs --name {body.name} --tabs {_tabs_arg(body.tabs)} --build")
    try:
        proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, bufsize=1)
        assert proc.stdout is not None
        for line in proc.stdout:
            _log(job_id, line.rstrip())
        rc = proc.wait()
    except Exception as e:                       # noqa: BLE001
        return _set(job_id, status="error", error=f"생성 실행 오류: {e}")
    if rc != 0:
        return _set(job_id, status="error", error=f"스캐폴드/빌드 실패 (exit {rc})")

    dist = SERVICES_ROOT / body.name / "frontend" / "dist" / "index.html"
    if not dist.exists():
        return _set(job_id, status="error", error="빌드 결과(dist)가 생성되지 않았습니다.")

    # Register the DB row (the manifest is already on disk under the service dir).
    db = SessionLocal()
    try:
        get_or_create_service(db, body.name, "generic")
        db.commit()
    finally:
        db.close()

    # Write a SEED manifest (committed to git) so this service auto-registers on a
    # fresh deploy — same mechanism as elog/asset/scattering. The seed points cwd at
    # the container path; the local manifest keeps the local path.
    try:
        m = json.loads((config.DATA_ROOT / body.name / "service.json").read_text(encoding="utf-8"))
        m.setdefault("start", {})["cwd"] = f"/app/{body.name}/backend"
        seed = SEED_ROOT / body.name
        seed.mkdir(parents=True, exist_ok=True)
        (seed / "service.json").write_text(json.dumps(m, ensure_ascii=False, indent=2), encoding="utf-8")
        _log(job_id, f"seed → service_manager/deploy/seed/{body.name}/service.json (commit to auto-register on deploy)")
    except Exception as e:                       # noqa: BLE001
        _log(job_id, f"⚠ seed manifest write skipped: {e}")

    _log(job_id, f"✓ 등록 완료 — /p/{body.name}/ 에서 열람")
    _set(job_id, status="done")


@router.post("/api/admin/services/scaffold", status_code=202)
def scaffold_service(body: ScaffoldBody, _: models.User = Depends(require_portal_admin)):
    name = (body.name or "").strip().lower()
    if not _NAME_RE.match(name):
        raise HTTPException(400, "이름은 소문자로 시작하고 [a-z0-9_] 만 사용할 수 있습니다.")
    if registry.service_dir(name).exists() or (SERVICES_ROOT / name).exists():
        raise HTTPException(409, f"'{name}' 이(가) 이미 존재합니다.")
    body.name = name
    job_id = uuid.uuid4().hex[:12]
    with _lock:
        _jobs[job_id] = {"status": "queued", "log": [], "error": None, "name": name}
    threading.Thread(target=_run_job, args=(job_id, body), daemon=True).start()
    return {"job_id": job_id, "name": name}


@router.get("/api/admin/services/scaffold/{job_id}")
def scaffold_status(job_id: str, _: models.User = Depends(require_portal_admin)):
    with _lock:
        job = _jobs.get(job_id)
        if not job:
            raise HTTPException(404, "job을 찾을 수 없습니다.")
        return {"status": job["status"], "error": job["error"],
                "name": job["name"], "log": job["log"][-60:]}
