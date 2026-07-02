"""
sci-runner job API — a tiny FastAPI service that runs nptool/Geant4 simulations
ONE AT A TIME (a global lock = a serial queue) with a timeout, inside the
ROOT+Geant4+nptool environment (sourced by entrypoint.sh). Jobs + their output
live under $SCI_DATA on the shared volume, so the portal-side nptoy service reads
results straight off disk.

This container is INTERNAL (never published to the internet); the portal reaches
it at http://sci-runner:8100. An optional SCI_TOKEN adds a shared-secret check.
"""
from __future__ import annotations

import os
import shlex
import subprocess
import threading
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

SCI_DATA = Path(os.environ.get("SCI_DATA", "/data"))
JOBS_DIR = SCI_DATA / "jobs"
SCI_TOKEN = os.environ.get("SCI_TOKEN", "").strip()
JOB_TIMEOUT = int(os.environ.get("SCI_JOB_TIMEOUT", "1800"))     # seconds, hard cap
# Only these executables may be launched (they live on PATH via nptool/geant4/root).
ALLOWED = {"npsimulation", "npanalysis", "root", "root.exe", "nptool-example"}

app = FastAPI(title="lilak sci-runner")
_lock = threading.Lock()                         # serial queue: one sim at a time
_jobs: dict[str, dict] = {}


class JobSpec(BaseModel):
    argv: list[str]                              # e.g. ["npsimulation","-D","proj.detector","-E","reac.reaction","-O","out"]
    name: str | None = None
    timeout: int | None = None


def _auth(authorization: str | None) -> None:
    if SCI_TOKEN and authorization != f"Bearer {SCI_TOKEN}":
        raise HTTPException(401, "bad sci token")


@app.get("/health")
def health():
    return {"ok": True, "busy": _lock.locked(), "nptool": os.environ.get("NPTOOL")}


def _run(job_id: str, spec: JobSpec) -> None:
    jd = JOBS_DIR / job_id
    jd.mkdir(parents=True, exist_ok=True)
    logf = jd / "run.log"
    to = min(spec.timeout or JOB_TIMEOUT, JOB_TIMEOUT)
    with _lock:                                  # serialize: one job at a time
        _jobs[job_id].update(status="running", started=time.time())
        try:
            with open(logf, "w") as out:
                proc = subprocess.run(spec.argv, cwd=jd, stdout=out, stderr=subprocess.STDOUT,
                                      timeout=to, env=os.environ, check=False)
            rc = proc.returncode
            _jobs[job_id].update(status="done" if rc == 0 else "error", rc=rc, ended=time.time())
        except subprocess.TimeoutExpired:
            _jobs[job_id].update(status="timeout", rc=None, ended=time.time())
        except Exception as e:                   # noqa: BLE001
            _jobs[job_id].update(status="error", error=str(e), ended=time.time())


@app.post("/jobs", status_code=202)
def submit(spec: JobSpec, authorization: str | None = Header(default=None)):
    _auth(authorization)
    if not spec.argv or spec.argv[0] not in ALLOWED:
        raise HTTPException(400, f"argv[0] must be one of {sorted(ALLOWED)}")
    if any(not isinstance(a, str) for a in spec.argv):
        raise HTTPException(400, "argv must be strings")
    job_id = uuid.uuid4().hex[:12]
    _jobs[job_id] = {"id": job_id, "name": spec.name, "status": "queued",
                     "argv": spec.argv, "dir": str(JOBS_DIR / job_id)}
    threading.Thread(target=_run, args=(job_id, spec), daemon=True).start()
    return {"job_id": job_id, "queued": True}


@app.get("/jobs/{job_id}")
def status(job_id: str, authorization: str | None = Header(default=None)):
    _auth(authorization)
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "no such job")
    log = ""
    lf = JOBS_DIR / job_id / "run.log"
    if lf.is_file():
        log = lf.read_text(errors="replace")[-4000:]
    out = [f.name for f in (JOBS_DIR / job_id).glob("*") if f.name != "run.log"] if (JOBS_DIR / job_id).is_dir() else []
    return {**job, "log_tail": log, "outputs": out}
