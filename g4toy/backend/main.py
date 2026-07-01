"""g4toy backend — FastAPI app (PLAN §5).

Mounted behind the portal proxy at `/p/g4toy/`. The portal strips that prefix, so
this app sees plain `/…` paths. SSO via the portal JWT (auth.require_user); each
user gets an isolated workspace and a slice of the global single-worker queue.
"""
from __future__ import annotations

import io
import uuid
import zipfile
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import config
import configs as configs_mod
import db
import inputs
import params as params_mod
import scene
import session as session_mod
import worker
import workspace
from auth import PortalUser, require_user

app = FastAPI(title="g4toy", docs_url="/api/docs", openapi_url="/api/openapi.json")


@app.on_event("startup")
def _startup() -> None:
    config.ensure_dirs()
    worker.start()


# ── health (no auth — SERVICE_CONTRACT §2 health) ─────────────────────────────
@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "service": config.SERVICE_NAME}


# ── identity + quota (PLAN §5 /api/me) ────────────────────────────────────────
@app.get("/api/me")
def me(user: PortalUser = Depends(require_user)) -> dict:
    used = workspace.user_usage(user.user_key)
    return {
        "email": user.email,
        "username": user.username,
        "name": user.name,
        "role": user.role,
        "quota_bytes": workspace.quota(),
        "used_bytes": used,
    }


@app.get("/api/params/schema")
def params_schema(_: PortalUser = Depends(require_user)) -> dict:
    return {"fields": params_mod.PARAM_SCHEMA}


# ── jobs ──────────────────────────────────────────────────────────────────────
class SubmitJob(BaseModel):
    params: dict = {}


def _queue_position(session, job: db.Job) -> int | None:
    """0 = the currently running job; 1.. = place in the FIFO queue."""
    if job.status == db.STATUS_RUNNING:
        return 0
    if job.status != db.STATUS_QUEUED:
        return None
    ahead = (
        session.query(db.Job)
        .filter(db.Job.status == db.STATUS_QUEUED, db.Job.created_at < job.created_at)
        .count()
    )
    running = session.query(db.Job).filter(db.Job.status == db.STATUS_RUNNING).count()
    return ahead + running + 1


@app.post("/api/jobs", status_code=201)
def submit_job(body: SubmitJob, user: PortalUser = Depends(require_user)) -> dict:
    # 1) validate params against the whitelist (PLAN §4.1 / §8)
    try:
        clean = params_mod.validate(body.params)
    except params_mod.ParamError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # 2) quota gate (PLAN §4.3): refuse if already over.
    if workspace.user_usage(user.user_key) >= workspace.quota():
        raise HTTPException(status_code=413,
                            detail="디스크 용량 초과 — 이전 잡 결과를 정리하세요.")

    # 3) create the workspace + input macro, then enqueue.
    job_id = uuid.uuid4().hex[:16]
    wd = workspace.job_dir(user.user_key, job_id)
    wd.mkdir(parents=True, exist_ok=True)
    import json
    (wd / "params.json").write_text(json.dumps(clean, indent=2))
    (wd / "run.mac").write_text(params_mod.build_macro(clean))

    session = db.Session()
    try:
        job = db.Job(
            id=job_id, user_key=user.user_key, email=user.email,
            status=db.STATUS_QUEUED, params_json=json.dumps(clean), workdir=str(wd),
        )
        session.add(job)
        session.commit()
        return job.to_dict(queue_position=_queue_position(session, job))
    finally:
        session.close()


@app.get("/api/jobs")
def list_jobs(user: PortalUser = Depends(require_user)) -> dict:
    session = db.Session()
    try:
        jobs = (
            session.query(db.Job)
            .filter(db.Job.user_key == user.user_key)
            .order_by(db.Job.created_at.desc())
            .all()
        )
        return {"jobs": [j.to_dict(queue_position=_queue_position(session, j)) for j in jobs]}
    finally:
        session.close()


def _owned_job(session, job_id: str, user: PortalUser) -> db.Job:
    job = session.get(db.Job, job_id)
    if not job or job.user_key != user.user_key:
        raise HTTPException(status_code=404, detail="잡을 찾을 수 없습니다.")
    return job


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str, user: PortalUser = Depends(require_user)) -> dict:
    session = db.Session()
    try:
        job = _owned_job(session, job_id, user)
        out = job.to_dict(queue_position=_queue_position(session, job))
        log = workspace.job_dir(user.user_key, job_id) / "sim.log"
        if log.exists():
            out["log_tail"] = "\n".join(log.read_text().splitlines()[-40:])
        return out
    finally:
        session.close()


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str, user: PortalUser = Depends(require_user)) -> dict:
    session = db.Session()
    try:
        _owned_job(session, job_id, user)  # ownership check (raises 404 otherwise)
    finally:
        session.close()
    result = worker.request_cancel(job_id)
    if result == "not-cancellable":
        raise HTTPException(status_code=409, detail="이미 끝난 잡입니다.")
    return {"ok": True, "result": result}


@app.get("/api/jobs/{job_id}/viewer")
def job_viewer(job_id: str, user: PortalUser = Depends(require_user)) -> JSONResponse:
    """Scene JSON for the 3D viewer (PLAN §4.4). Geometry from GDML if exported;
    nptool track/point extraction from the ROOT output is the next step."""
    session = db.Session()
    try:
        job = _owned_job(session, job_id, user)
        n_events = int(job.params.get("n_events", 0))
    finally:
        session.close()
    wd = workspace.job_dir(user.user_key, job_id) / "proj"
    return JSONResponse(scene.from_online(wd))


@app.get("/api/jobs/{job_id}/result")
def job_result(job_id: str, user: PortalUser = Depends(require_user)) -> StreamingResponse:
    """Zip of the job's workspace — owner only (PLAN §4.5)."""
    session = db.Session()
    try:
        _owned_job(session, job_id, user)
    finally:
        session.close()
    wd = workspace.job_dir(user.user_key, job_id)
    if not wd.exists():
        raise HTTPException(status_code=404, detail="결과가 없습니다.")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in sorted(wd.rglob("*")):
            if f.is_file():
                zf.write(f, f.relative_to(wd))
    buf.seek(0)
    return StreamingResponse(
        buf, media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="g4toy-{job_id}.zip"'},
    )


# ── queue (global, PLAN §5 /api/queue) ────────────────────────────────────────
@app.get("/api/queue")
def queue(_: PortalUser = Depends(require_user)) -> dict:
    session = db.Session()
    try:
        running = session.query(db.Job).filter(db.Job.status == db.STATUS_RUNNING).count()
        queued = session.query(db.Job).filter(db.Job.status == db.STATUS_QUEUED).count()
        return {"running": running, "queued": queued}
    finally:
        session.close()


# ── input workspace (3 editable slots: physics / detector / reaction) ─────────
class SaveSlot(BaseModel):
    slot: str
    content: str


class LoadExample(BaseModel):
    example: str


@app.get("/api/inputs")
def inputs_state(user: PortalUser = Depends(require_user)) -> dict:
    inputs.ensure(user.user_key, user.username)
    return {
        "slots": inputs.SLOTS,
        "crosssection": inputs.cs_info(user.user_key),
        "project": inputs.project_name(user.user_key),
        "examples": [{"key": k, "label": v["label"]} for k, v in config.PROJECTS.items()],
    }


class SaveContent(BaseModel):
    content: str


@app.get("/api/inputs/crosssection")
def cs_get(name: str | None = None, user: PortalUser = Depends(require_user)) -> dict:
    path = name or inputs.cs_info(user.user_key)["path"]
    return {"path": path, "content": inputs.read_cs(user.user_key, name)}


@app.get("/api/inputs/crosssections")
def cs_candidates(user: PortalUser = Depends(require_user)) -> dict:
    return {"files": inputs.cs_candidates(user.user_key)}


class SaveCS(BaseModel):
    content: str
    name: str | None = None


@app.put("/api/inputs/crosssection")
def cs_put(body: SaveCS, user: PortalUser = Depends(require_user)) -> dict:
    name = body.name.strip() if body.name else None
    if name and "." not in name.rsplit("/", 1)[-1]:
        name += ".txt"                         # give bare names a .txt extension
    inputs.write_cs(user.user_key, body.content, name)
    return {"ok": True, "path": name or inputs.cs_info(user.user_key)["path"]}


# ── named / shareable configurations ──────────────────────────────────────────
class SaveConfig(BaseModel):
    name: str = ""
    shared: bool = False


class ShareConfig(BaseModel):
    shared: bool


@app.get("/api/configs")
def configs_list(user: PortalUser = Depends(require_user)) -> dict:
    return {"configs": configs_mod.list_for(user.user_key)}


@app.post("/api/configs")
def configs_save(body: SaveConfig, user: PortalUser = Depends(require_user)) -> dict:
    return configs_mod.save(user.user_key, user.username, body.name, body.shared)


@app.post("/api/configs/{cid}/load")
def configs_load(cid: str, user: PortalUser = Depends(require_user)) -> dict:
    s = session_mod.manager.get(user.user_key)
    if s and s.alive():
        raise HTTPException(status_code=409, detail="세션 실행 중에는 불러올 수 없습니다.")
    try:
        return {"manifest": configs_mod.load(user.user_key, user.username, cid)}
    except KeyError:
        raise HTTPException(status_code=404, detail="설정을 찾을 수 없습니다.")
    except PermissionError:
        raise HTTPException(status_code=403, detail="접근 권한이 없습니다.")


@app.post("/api/configs/{cid}/share")
def configs_share(cid: str, body: ShareConfig, user: PortalUser = Depends(require_user)) -> dict:
    try:
        return configs_mod.set_shared(user.user_key, cid, body.shared)
    except KeyError:
        raise HTTPException(status_code=404, detail="설정을 찾을 수 없습니다.")
    except PermissionError:
        raise HTTPException(status_code=403, detail="소유자만 공유할 수 있습니다.")


@app.delete("/api/configs/{cid}")
def configs_delete(cid: str, user: PortalUser = Depends(require_user)) -> dict:
    try:
        configs_mod.delete(user.user_key, cid)
    except KeyError:
        raise HTTPException(status_code=404, detail="설정을 찾을 수 없습니다.")
    except PermissionError:
        raise HTTPException(status_code=403, detail="소유자만 삭제할 수 있습니다.")
    return {"ok": True}


@app.get("/api/inputs/file")
def inputs_get_file(slot: str, user: PortalUser = Depends(require_user)) -> dict:
    try:
        return {"slot": slot, "content": inputs.read_slot(user.user_key, slot)}
    except (ValueError, FileNotFoundError):
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.")


@app.put("/api/inputs/file")
def inputs_put_file(body: SaveSlot, user: PortalUser = Depends(require_user)) -> dict:
    try:
        inputs.write_slot(user.user_key, body.slot, body.content)
    except (ValueError, FileNotFoundError):
        raise HTTPException(status_code=400, detail="잘못된 슬롯입니다.")
    return {"ok": True}


@app.post("/api/inputs/load-example")
def inputs_load_example(body: LoadExample, user: PortalUser = Depends(require_user)) -> dict:
    s = session_mod.manager.get(user.user_key)
    if s and s.alive():
        raise HTTPException(status_code=409, detail="세션 실행 중에는 프리셋을 불러올 수 없습니다.")
    try:
        inputs.seed(user.user_key, body.example, user.username)
    except KeyError:
        raise HTTPException(status_code=404, detail="알 수 없는 프리셋입니다.")
    return {"ok": True, "project": inputs.project_name(user.user_key)}


# ── interactive nptool sessions (live npsimulation -N + Run button) ───────────
class RunBeamOn(BaseModel):
    n: int


@app.get("/api/session")
def session_status(user: PortalUser = Depends(require_user)) -> dict:
    s = session_mod.manager.get(user.user_key)
    return {"session": s.to_dict() if s else None}


@app.post("/api/session/start")
def session_start(user: PortalUser = Depends(require_user)) -> dict:
    """Start a session running the user's current input workspace (/api/inputs)."""
    try:
        s = session_mod.manager.start(user.user_key)
    except RuntimeError as exc:
        raise HTTPException(status_code=429, detail=str(exc))
    return s.to_dict()


@app.post("/api/session/run")
def session_run(body: RunBeamOn, user: PortalUser = Depends(require_user)) -> dict:
    s = session_mod.manager.get(user.user_key)
    if not s or not s.alive():
        raise HTTPException(status_code=409, detail="실행 중인 세션이 없습니다.")
    if body.n < 1 or body.n > config.SESSION_MAX_BEAMON:
        raise HTTPException(status_code=400,
                            detail=f"이벤트 수는 1..{config.SESSION_MAX_BEAMON} 사이여야 합니다.")
    try:
        s.run_beamon(body.n)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc))  # not idle yet
    return s.to_dict()


@app.get("/api/session/log")
def session_log(since: int = 0, user: PortalUser = Depends(require_user)) -> dict:
    s = session_mod.manager.get(user.user_key)
    if not s:
        raise HTTPException(status_code=409, detail="세션이 없습니다.")
    return s.log_since(since)


@app.get("/api/session/scene")
def session_scene(user: PortalUser = Depends(require_user)) -> JSONResponse:
    """Live 3D scene for the current session: GDML geometry + the streamed
    tracks/energy points (`online_stream.dat`), updating as /run/beamOn runs."""
    s = session_mod.manager.get(user.user_key)
    if not s:
        raise HTTPException(status_code=409, detail="세션이 없습니다.")
    return JSONResponse(scene.from_online(s.workdir))


@app.post("/api/session/stop")
def session_stop(user: PortalUser = Depends(require_user)) -> dict:
    return {"stopped": session_mod.manager.stop(user.user_key)}


# ── frontend ──────────────────────────────────────────────────────────────────
# The base-path-aware UI is served from public/ (Vite build lands here later).
# Mounted last so it never shadows the /api/* routes.
if config.PUBLIC_DIR.exists():
    app.mount("/", StaticFiles(directory=str(config.PUBLIC_DIR), html=True), name="public")
