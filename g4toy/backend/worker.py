"""The single global worker (PLAN §4.2 / §7).

One background thread runs at most one job at a time: it promotes the oldest
`queued` job to `running`, launches the simulator as its own process group, and
enforces the per-job timeout by killing the whole tree. Because there is exactly
one loop, FIFO ordering and "one job at a time" hold across all users without any
lock beyond the DB.
"""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone

import config
import db
import inputs
import params as params_mod
import session as session_mod
import workspace

# Shared state between the worker loop and the cancel endpoint. Only the worker
# writes `_current`; the API thread reads it and records cancel requests.
_current_lock = threading.Lock()
_current_job_id: str | None = None
_current_proc: subprocess.Popen | None = None
_cancel_requested: set[str] = set()
_started = False


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def request_cancel(job_id: str) -> str:
    """Cancel a job the caller owns. A queued job is cancelled in place; the
    running job (if it is this one) gets its process tree killed. Returns the
    resulting status hint ('cancelled' / 'queued-cancelled' / 'not-cancellable')."""
    session = db.Session()
    try:
        job = session.get(db.Job, job_id)
        if not job or job.status in db.TERMINAL:
            return "not-cancellable"
        with _current_lock:
            if job_id == _current_job_id and _current_proc is not None:
                _cancel_requested.add(job_id)
                _kill_tree(_current_proc)
                return "cancelled"
        # Still queued — mark terminal so the worker skips it when reached.
        job.status = db.STATUS_CANCELLED
        job.finished_at = _now()
        job.error = "cancelled while queued"
        session.commit()
        return "queued-cancelled"
    finally:
        session.close()


def _kill_tree(proc: subprocess.Popen) -> None:
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        try:
            proc.kill()
        except ProcessLookupError:
            pass


def _next_queued(session) -> db.Job | None:
    return (
        session.query(db.Job)
        .filter(db.Job.status == db.STATUS_QUEUED)
        .order_by(db.Job.created_at.asc())
        .first()
    )


def _run_job(session, job: db.Job) -> None:
    global _current_job_id, _current_proc

    workdir = workspace.job_dir(job.user_key, job.id)
    job.status = db.STATUS_RUNNING
    job.started_at = _now()
    session.commit()

    # Real nptool batch run: isolated project copy in the job dir, fixed beamOn
    # macro, `npsimulation -B`. Own process group so timeout/cancel kills the whole
    # Geant4 subtree. stdout/stderr → sim.log for the log tail.
    proj_dir = workdir / "proj"
    man = inputs.prepare_run(job.user_key, proj_dir)   # the user's edited workspace
    # Export geometry once, then beamOn. Stream first N events for the viewer.
    (proj_dir / "run.mac").write_text(
        "/det/export_gdml geometry.gdml\n" + params_mod.build_macro(job.params))
    cmd = session_mod.nptool_cmd(man, batch_macro="run.mac", online=config.ONLINE_EVENTS)
    logf = open(workdir / "sim.log", "w")
    proc = subprocess.Popen(
        ["bash", "-lc", cmd], cwd=str(proj_dir),
        stdout=logf, stderr=subprocess.STDOUT, start_new_session=True,
    )
    with _current_lock:
        _current_job_id, _current_proc = job.id, proc

    timed_out = False
    try:
        proc.wait(timeout=config.JOB_TIMEOUT_SEC)
    except subprocess.TimeoutExpired:
        timed_out = True
        _kill_tree(proc)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pass

    with _current_lock:
        cancelled = job.id in _cancel_requested
        _cancel_requested.discard(job.id)
        _current_job_id, _current_proc = None, None

    logf.close()
    job.exit_code = proc.returncode
    job.finished_at = _now()
    job.size_bytes = workspace.dir_size(workdir)
    if cancelled:
        job.status = db.STATUS_CANCELLED
        job.error = "cancelled"
    elif timed_out:
        job.status = db.STATUS_TIMEOUT
        job.error = f"exceeded {config.JOB_TIMEOUT_SEC}s timeout"
    elif proc.returncode == 0:
        job.status = db.STATUS_DONE
    else:
        job.status = db.STATUS_FAILED
        job.error = f"simulator exited with code {proc.returncode}"
    session.commit()


def _loop() -> None:
    while True:
        session = db.Session()
        try:
            job = _next_queued(session)
            if job is not None:
                _run_job(session, job)
                continue  # immediately look for the next one
        except Exception as exc:  # keep the worker alive across job failures
            print(f"[g4toy worker] error: {exc}", file=sys.stderr)
        finally:
            session.close()
        time.sleep(config.WORKER_POLL_SEC)


def start() -> None:
    global _started
    if _started:
        return
    _started = True
    db.recover_orphans()
    threading.Thread(target=_loop, name="g4toy-worker", daemon=True).start()
