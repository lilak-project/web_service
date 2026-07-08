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
import re
import select
import shlex
import signal
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from pydantic import BaseModel
import websockets

SCI_DATA = Path(os.environ.get("SCI_DATA", "/data"))
JOBS_DIR = SCI_DATA / "jobs"
PORTAL_DATA = Path(os.environ.get("PORTAL_DATA", "/portal-data"))
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
    # Working dir for the run, as a path RELATIVE to SCI_DATA (the shared volume).
    # Lets the caller (nptoy) stage a self-contained workspace and run there, so the
    # sim's own relative paths resolve exactly as on the dev box. Defaults to the
    # job's dir; must stay inside SCI_DATA.
    cwd: str | None = None


def _resolve_cwd(cwd: str | None, jd: Path) -> Path:
    if not cwd:
        return jd
    base = SCI_DATA.resolve()
    cand = (SCI_DATA / cwd).resolve()
    if cand != base and base not in cand.parents:
        raise ValueError("cwd escapes SCI_DATA")
    cand.mkdir(parents=True, exist_ok=True)
    return cand


def _auth(authorization: str | None) -> None:
    if SCI_TOKEN and authorization != f"Bearer {SCI_TOKEN}":
        raise HTTPException(401, "bad sci token")


@app.get("/health")
def health():
    return {"ok": True, "busy": _lock.locked(), "nptool": os.environ.get("NPTOOL")}


# ── server-side ROOT draw ─────────────────────────────────────────────────────
# JSROOT (the browser viewer) can't stream nptool's unsplit custom objects, so the
# web viewer asks us to TTree::Draw a chosen expression with REAL ROOT here and hands
# back the resulting histogram as JSON, which JSROOT renders client-side. Supports 1D
# and 2D ("vary:varx"), an optional selection cut, and explicit binning.
_DRAW_MACRO = Path("/tmp/np_draw_branch.C")
# Each axis variable: a Branch.member, optionally element-indexed (…[0]). No spaces,
# quotes, semicolons or call syntax — a plain leaf reference, not a formula.
_DRAW_VAR_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.]*(?:\[[0-9]+\])?$")
_DRAW_TREE_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
# A TTreeFormula selection: leaf references, numbers, comparison/logic/arithmetic
# operators, parentheses, array indexing and the `$` of Sum$()/Alt$() etc. NO quotes,
# semicolons, or shell metacharacters — this is a formula string, never a shell one.
_DRAW_CUT_RE = re.compile(r"^[A-Za-z0-9_.\s()\[\]<>=!&|+\-*/$]*$")


def _hdef_from(hist: str) -> str:
    """Build a SAFE `>>h(...)` histogram definition from a comma list of numbers, by
    reparsing every value (no passthrough) so nothing but digits can reach ROOT.
    Empty → 'h' (ROOT auto-bins). 3 numbers = 1D (nbins,lo,hi); 6 = 2D."""
    hist = (hist or "").strip()
    if not hist:
        return "h"
    parts = [p.strip() for p in hist.split(",")]
    if len(parts) not in (3, 6):
        raise ValueError("binning needs 3 (1D) or 6 (2D) numbers")
    nums: list[str] = []
    for i, p in enumerate(parts):
        if i % 3 == 0:                       # positions 0 and 3 are bin COUNTS → int
            v = int(p)
            if not (1 <= v <= 100000):
                raise ValueError("bin count out of range (1..100000)")
            nums.append(str(v))
        else:                                # edges → float
            nums.append(repr(float(p)))
    return "h(" + ",".join(nums) + ")"


def _write_draw_macro() -> None:
    _DRAW_MACRO.write_text(
        '#include "TFile.h"\n#include "TTree.h"\n#include "TH1.h"\n'
        '#include "TBufferJSON.h"\n#include "TSystem.h"\n'
        'void np_draw_branch() {\n'
        '  const char* fname = gSystem->Getenv("RD_FILE");\n'
        '  const char* tname = gSystem->Getenv("RD_TREE");\n'
        '  const char* expr  = gSystem->Getenv("RD_EXPR");\n'
        '  const char* cut   = gSystem->Getenv("RD_CUT");\n'
        '  const char* hdef  = gSystem->Getenv("RD_HDEF");\n'
        '  const char* out   = gSystem->Getenv("RD_OUT");\n'
        '  TFile* f = TFile::Open(fname, "READ");\n'
        '  if (!f || f->IsZombie()) { printf("RD_ERR open\\n"); return; }\n'
        '  TTree* t = (TTree*) f->Get(tname);\n'
        '  if (!t) { printf("RD_ERR tree\\n"); return; }\n'
        '  TString drawcmd = TString(expr) + ">>" + hdef;\n'
        '  Long64_t n = t->Draw(drawcmd, cut, "goff");\n'
        '  TH1* h = (TH1*) gDirectory->Get("h");\n'   # TH2 derives from TH1 → same cast
        '  if (!h) { printf("RD_ERR nohist n=%lld\\n", n); return; }\n'
        '  h->SetName("h"); h->SetTitle(expr);\n'
        '  TBufferJSON::ExportToFile(out, h);\n'
        '  printf("RD_OK %lld\\n", n);\n'
        '}\n'
    )


_write_draw_macro()


# Temp-save: same TTree::Draw as above, but instead of exporting JSON we write the
# histogram AND a TCanvas showing it into a real .root file (so it reopens as a
# drawable object/canvas in the Files-tab viewer).
_SAVE_MACRO = Path("/tmp/np_save_hist.C")


def _write_save_macro() -> None:
    _SAVE_MACRO.write_text(
        '#include "TFile.h"\n#include "TTree.h"\n#include "TH1.h"\n'
        '#include "TCanvas.h"\n#include "TSystem.h"\n'
        'void np_save_hist() {\n'
        '  const char* fname = gSystem->Getenv("RD_FILE");\n'
        '  const char* tname = gSystem->Getenv("RD_TREE");\n'
        '  const char* expr  = gSystem->Getenv("RD_EXPR");\n'
        '  const char* cut   = gSystem->Getenv("RD_CUT");\n'
        '  const char* hdef  = gSystem->Getenv("RD_HDEF");\n'
        '  const char* out   = gSystem->Getenv("RD_OUT");\n'
        '  const char* name  = gSystem->Getenv("RD_NAME");\n'
        '  const char* opt   = gSystem->Getenv("RD_OPT");\n'
        '  TFile* f = TFile::Open(fname, "READ");\n'
        '  if (!f || f->IsZombie()) { printf("RD_ERR open\\n"); return; }\n'
        '  TTree* t = (TTree*) f->Get(tname);\n'
        '  if (!t) { printf("RD_ERR tree\\n"); return; }\n'
        '  TString drawcmd = TString(expr) + ">>" + hdef;\n'
        '  Long64_t n = t->Draw(drawcmd, cut, "goff");\n'
        '  TH1* h = (TH1*) gDirectory->Get("h");\n'
        '  if (!h) { printf("RD_ERR nohist n=%lld\\n", n); return; }\n'
        '  h->SetName(name); h->SetTitle(expr); h->SetDirectory(0);\n'
        '  TFile fout(out, "RECREATE");\n'
        '  h->Write();\n'
        '  TCanvas c(Form("c_%s", name), expr, 700, 500);\n'
        '  h->Draw(opt);\n'
        '  c.Write();\n'
        '  fout.Close();\n'
        '  printf("RD_OK %lld\\n", n);\n'
        '}\n'
    )


_write_save_macro()
# object/canvas name inside the saved file: a plain C++ identifier
_SAVE_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
# a ROOT draw option token (colz, hist, e, lego2, …) — letters/digits/space only
_SAVE_OPT_RE = re.compile(r"^[A-Za-z0-9 ]{0,20}$")


class DrawSpec(BaseModel):
    file: str                    # path RELATIVE to SCI_DATA (nptoy stages it there)
    tree: str = "SimulatedTree"
    expr: str                    # "varx" (1D) or "vary:varx" (2D)
    cut: str = ""                # optional TTreeFormula selection
    hist: str = ""               # optional binning: "nbins,lo,hi" (1D) / "…,…,…,…,…,…" (2D)


@app.post("/root/draw")
def root_draw(spec: DrawSpec, authorization: str | None = Header(default=None)):
    _auth(authorization)
    if not _DRAW_TREE_RE.match(spec.tree):
        raise HTTPException(400, "bad tree")
    axes = spec.expr.split(":")
    if len(axes) not in (1, 2) or not all(_DRAW_VAR_RE.match(a) for a in axes):
        raise HTTPException(400, "bad expr")
    if len(spec.cut) > 200 or not _DRAW_CUT_RE.match(spec.cut):
        raise HTTPException(400, "bad cut")
    try:
        hdef = _hdef_from(spec.hist)
    except ValueError as e:
        raise HTTPException(400, f"bad binning: {e}")
    base = SCI_DATA.resolve()
    src = (SCI_DATA / spec.file).resolve()
    if src != base and base not in src.parents:
        raise HTTPException(403, "file escapes shared volume")
    if not src.is_file():
        raise HTTPException(404, "file not found")

    fd, outp = tempfile.mkstemp(suffix=".json", prefix="npdraw_")
    os.close(fd)
    try:
        env = {**os.environ, "RD_FILE": str(src), "RD_TREE": spec.tree,
               "RD_EXPR": spec.expr, "RD_CUT": spec.cut, "RD_HDEF": hdef, "RD_OUT": outp}
        proc = subprocess.run(["root", "-l", "-b", "-q", str(_DRAW_MACRO)],
                              capture_output=True, text=True, timeout=60, env=env)
        data = Path(outp).read_text() if os.path.getsize(outp) > 0 else ""
        if not data:
            tail = ((proc.stdout or "")[-600:] + (proc.stderr or "")[-300:]).strip()
            raise HTTPException(500, f"draw produced no histogram: {tail or 'empty'}")
        return Response(content=data, media_type="application/json")
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "draw timed out")
    finally:
        try:
            os.unlink(outp)
        except OSError:
            pass


class SaveSpec(DrawSpec):
    name: str = "canvas"         # object/canvas name inside the .root
    opt: str = ""                # draw option for the canvas (colz / hist / …)
    out: str                     # output path RELATIVE to SCI_DATA (nptoy copies it back)


@app.post("/root/save")
def root_save(spec: SaveSpec, authorization: str | None = Header(default=None)):
    _auth(authorization)
    if not _DRAW_TREE_RE.match(spec.tree):
        raise HTTPException(400, "bad tree")
    axes = spec.expr.split(":")
    if len(axes) not in (1, 2) or not all(_DRAW_VAR_RE.match(a) for a in axes):
        raise HTTPException(400, "bad expr")
    if len(spec.cut) > 200 or not _DRAW_CUT_RE.match(spec.cut):
        raise HTTPException(400, "bad cut")
    if not _SAVE_NAME_RE.match(spec.name):
        raise HTTPException(400, "bad name")
    if not _SAVE_OPT_RE.match(spec.opt or ""):
        raise HTTPException(400, "bad opt")
    try:
        hdef = _hdef_from(spec.hist)
    except ValueError as e:
        raise HTTPException(400, f"bad binning: {e}")
    base = SCI_DATA.resolve()
    src = (SCI_DATA / spec.file).resolve()
    if src != base and base not in src.parents:
        raise HTTPException(403, "file escapes shared volume")
    if not src.is_file():
        raise HTTPException(404, "file not found")
    outp = (SCI_DATA / spec.out).resolve()
    if base not in outp.parents:
        raise HTTPException(403, "output escapes shared volume")
    outp.parent.mkdir(parents=True, exist_ok=True)
    try:
        env = {**os.environ, "RD_FILE": str(src), "RD_TREE": spec.tree,
               "RD_EXPR": spec.expr, "RD_CUT": spec.cut, "RD_HDEF": hdef,
               "RD_OUT": str(outp), "RD_NAME": spec.name, "RD_OPT": spec.opt or ""}
        proc = subprocess.run(["root", "-l", "-b", "-q", str(_SAVE_MACRO)],
                              capture_output=True, text=True, timeout=60, env=env)
        if not outp.is_file() or outp.stat().st_size == 0:
            tail = ((proc.stdout or "")[-600:] + (proc.stderr or "")[-300:]).strip()
            raise HTTPException(500, f"save produced no file: {tail or 'empty'}")
        return {"ok": True, "out": spec.out}
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "save timed out")


# ── ROOT inbox (shared-folder bridge) ─────────────────────────────────────────
# A host-owned shared folder (`/work/root-inbox`, = ./sci-work/root-inbox on the host)
# lets someone OUTSIDE the container run ad-hoc ROOT macros against the data without
# docker access: drop `<name>.C`, the watcher runs `root -l -b -q <name>.C` in that
# folder, and writes stdout+stderr to `<name>.out`. It re-runs whenever the macro is
# newer than its .out, so overwriting the macro re-runs it. Macros can read the read-
# only data at /portal-data and the shared volume at /data. NOTE: this auto-executes
# any macro dropped there — same trust level as host write access to ./sci-work.
_WORK_DIR = Path(os.environ.get("SCI_WORK_DIR", "/work"))
_ROOT_INBOX = _WORK_DIR / "root-inbox"


def _root_inbox_watcher() -> None:
    try:
        _ROOT_INBOX.mkdir(parents=True, exist_ok=True)
    except Exception:
        return
    while True:
        time.sleep(2)
        try:
            macros = sorted(_ROOT_INBOX.glob("*.C"))
        except Exception:
            continue
        for m in macros:
            try:
                mt = m.stat().st_mtime
            except OSError:
                continue
            if time.time() - mt < 1.5:                 # still being written — wait
                continue
            outp = _ROOT_INBOX / (m.stem + ".out")
            try:                                        # already ran this version?
                if outp.exists() and outp.stat().st_mtime >= mt:
                    continue
            except OSError:
                pass
            try:
                proc = subprocess.run(["root", "-l", "-b", "-q", m.name],
                                      cwd=str(_ROOT_INBOX), capture_output=True, text=True,
                                      timeout=180, env=os.environ)
                out = (proc.stdout or "") + (proc.stderr or "")
            except subprocess.TimeoutExpired:
                out = "RD_INBOX_TIMEOUT\n"
            except Exception as e:                       # noqa: BLE001
                out = f"RD_INBOX_ERR {e}\n"
            try:
                outp.write_text(out)
            except Exception:
                pass


threading.Thread(target=_root_inbox_watcher, name="root-inbox", daemon=True).start()


def _run(job_id: str, spec: JobSpec) -> None:
    jd = JOBS_DIR / job_id
    jd.mkdir(parents=True, exist_ok=True)
    logf = jd / "run.log"
    to = min(spec.timeout or JOB_TIMEOUT, JOB_TIMEOUT)
    with _lock:                                  # serialize: one job at a time
        _jobs[job_id].update(status="running", started=time.time())
        try:
            wd = _resolve_cwd(spec.cwd, jd)      # run in the caller's staged dir if given
            with open(logf, "w") as out:
                proc = subprocess.run(spec.argv, cwd=wd, stdout=out, stderr=subprocess.STDOUT,
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


# ── RBrowser sessions (ROOT lives in this container) ──────────────────────────
_rb_lock = threading.Lock()
_rb_sessions: dict[str, dict] = {}
_rb_runtime = SCI_DATA / "rbrowser"
_SAFE_USER_KEY = re.compile(r"^[A-Za-z0-9._@-]+$")
_HOP_HEADERS = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade",
}


class RBrowserSpec(BaseModel):
    user_key: str


def _free_port() -> int:
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _port_open(port: int) -> bool:
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.3)
    try:
        return s.connect_ex(("127.0.0.1", port)) == 0
    finally:
        s.close()


def _write_rb_macro(port: int, working: str) -> Path:
    _rb_runtime.mkdir(parents=True, exist_ok=True)
    macro = _rb_runtime / f"rb_{port}.C"
    macro.write_text(
        "{\n"
        f'  gEnv->SetValue("WebGui.HttpPort", {port});\n'
        '  gEnv->SetValue("WebGui.OnetimeKey", "no");\n'
        '  gEnv->SetValue("WebGui.SingleConnMode", "no");\n'
        '  auto b = new ROOT::RBrowser();\n'
        f'  b->SetWorkingPath("{working}");\n'
        "  while (true) { gSystem->ProcessEvents(); gSystem->Sleep(50); }\n"
        "}\n"
    )
    return macro


_RB_KEY_RE = re.compile(r"key=([a-z0-9]+)")


def _read_rb_key(proc: subprocess.Popen, port: int, timeout: float = 25.0) -> tuple[str | None, str]:
    deadline = time.time() + timeout
    key = None
    lines: list[str] = []
    while time.time() < deadline:
        if proc.poll() is not None:
            return None, "\n".join(lines[-40:])
        ready, _, _ = select.select([proc.stdout], [], [], 0.1) if proc.stdout else ([], [], [])
        if ready:
            line = proc.stdout.readline()
            lines.append(line.rstrip())
            m = _RB_KEY_RE.search(line)
            if m:
                key = m.group(1)
        # ROOT opens the HTTP port BEFORE it prints the `…?key=<key>` line, so we must
        # wait for BOTH — returning on port-open alone hands back an empty key and the
        # RBrowser window closes itself on connect (mirrors portal rbrowser._read_key).
        if key and _port_open(port):
            return key, "\n".join(lines[-40:])
    return None, "\n".join(lines[-40:])


def _rb_user_dir(user_key: str) -> Path:
    if not _SAFE_USER_KEY.match(user_key) or "/" in user_key or ".." in user_key:
        raise HTTPException(400, "bad user_key")
    base = (PORTAL_DATA / "nptoy" / "user").resolve()
    p = (base / user_key).resolve()
    if p != base and base not in p.parents:
        raise HTTPException(403, "path escapes user root")
    if not p.is_dir():
        raise HTTPException(404, "user data not mounted")
    return p


def _kill_rb(sess: dict) -> None:
    proc = sess.get("proc")
    if proc and proc.poll() is None:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


_RB_CRASH_HINTS = ("error", "break ***", "segmentation", "violation", "traceback",
                   "abort", "fatal", "assert", "exception", "core dump", "stack trace")


def _drain_stream(stream, port: int) -> None:
    """Keep the RBrowser process's stdout drained for the life of the session. After
    the key is read nobody reads this pipe, yet ROOT/RBrowser logs every request — a
    busy session fills the 64 KB pipe buffer, ROOT blocks on its next write, its event
    loop stalls, and the browser freezes/errors mid-navigation. We read to EOF, tee the
    FULL output to /tmp/rb-<port>.log for diagnosis, and echo crash-looking lines to OUR
    stdout so `docker logs` reveals why ROOT died (its output is otherwise lost)."""
    try:
        logf = open(f"/tmp/rb-{port}.log", "w", buffering=1)
    except Exception:
        logf = None
    try:
        for line in iter(stream.readline, ""):
            if logf is not None:
                try:
                    logf.write(line)
                except Exception:
                    pass
            if any(h in line.lower() for h in _RB_CRASH_HINTS):
                print(f"[rbrowser:{port}] {line}", end="", flush=True)
    except Exception:
        pass
    finally:
        if logf is not None:
            try:
                logf.close()
            except Exception:
                pass


@app.post("/rbrowser/open")
def rbrowser_open(spec: RBrowserSpec, authorization: str | None = Header(default=None)):
    _auth(authorization)
    user_dir = _rb_user_dir(spec.user_key)
    with _rb_lock:
        old = _rb_sessions.get(spec.user_key)
        if old and old["proc"].poll() is None:
            old["last_used"] = time.time()
            return {"token": old["token"]}
        if old:
            _rb_sessions.pop(spec.user_key, None)
        port = _free_port()
        macro = _write_rb_macro(port, str(user_dir))
        proc = subprocess.Popen(
            ["root", "-l", "-b", "-q", "--web=server", str(macro)],
            cwd=str(user_dir),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
            env=os.environ,
        )
        key, log_tail = _read_rb_key(proc, port)
        if key is None or proc.poll() is not None:
            _kill_rb({"proc": proc})
            detail = "RBrowser failed to start"
            if log_tail:
                detail += f": {log_tail[-1200:]}"
            raise HTTPException(503, detail)
        token = uuid.uuid4().hex
        _rb_sessions[spec.user_key] = {
            "token": token, "port": port, "key": key, "proc": proc,
            "last_used": time.time(),
        }
        threading.Thread(target=_drain_stream, args=(proc.stdout, port),
                         name=f"rb-drain-{port}", daemon=True).start()
        return {"token": token, "key": key}


def _rb_session(token: str) -> dict:
    with _rb_lock:
        for sess in _rb_sessions.values():
            if sess.get("token") == token and sess["proc"].poll() is None:
                sess["last_used"] = time.time()
                return sess
    raise HTTPException(403, "no rbrowser session")


@app.api_route("/rbrowser/proxy/{token}/{path:path}", methods=["GET", "POST", "HEAD"])
async def rbrowser_proxy(token: str, path: str, request: Request):
    sess = _rb_session(token)
    query = urllib.parse.urlencode(list(request.query_params.multi_items()), doseq=True)
    url = f"http://127.0.0.1:{sess['port']}/{path}"
    if query:
        url += "?" + query
    headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in _HOP_HEADERS and k.lower() not in {"host", "accept-encoding"}
    }
    headers["Accept-Encoding"] = "identity"
    data = await request.body() if request.method in ("POST", "PUT", "PATCH") else None
    req = urllib.request.Request(url, data=data, headers=headers, method=request.method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            out_headers = {
                k: v for k, v in r.headers.items()
                if k.lower() not in _HOP_HEADERS and k.lower() not in {"content-length", "content-encoding"}
            }
            return Response(content=r.read(), status_code=r.status, headers=out_headers,
                            media_type=r.headers.get_content_type())
    except urllib.error.HTTPError as e:
        return Response(content=e.read(), status_code=e.code,
                        media_type=e.headers.get_content_type() if e.headers else None)


@app.websocket("/rbrowser/proxy/{token}/{path:path}")
async def rbrowser_proxy_ws(token: str, path: str, websocket: WebSocket):
    try:
        sess = _rb_session(token)
    except HTTPException:
        await websocket.close(code=1008)
        return
    query = urllib.parse.urlencode(list(websocket.query_params.multi_items()), doseq=True)
    url = f"ws://127.0.0.1:{sess['port']}/{path}"
    if query:
        url += "?" + query
    await websocket.accept()
    try:
        async with websockets.connect(url, max_size=None) as upstream:  # RBrowser dir/histogram frames exceed 1 MB
            import asyncio

            async def c2u():
                try:
                    while True:
                        msg = await websocket.receive()
                        if msg.get("text") is not None:
                            await upstream.send(msg["text"])
                        elif msg.get("bytes") is not None:
                            await upstream.send(msg["bytes"])
                except WebSocketDisconnect:
                    await upstream.close()

            async def u2c():
                async for msg in upstream:
                    if isinstance(msg, bytes):
                        await websocket.send_bytes(msg)
                    else:
                        await websocket.send_text(msg)

            done, pending = await asyncio.wait(
                [asyncio.create_task(c2u()), asyncio.create_task(u2c())],
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
            for task in done:
                task.result()
    except Exception:
        try:
            await websocket.close()
        except Exception:
            pass


# ── interactive sessions (persistent `npsimulation -N`) ───────────────────────
# The portal (nptoy) can't run npsimulation — the binary lives here. So the live
# "start once, /run/beamOn many times" session runs in THIS container: a persistent
# process whose stdin we feed fixed commands and whose stdout we buffer. The portal
# stages the workspace on the shared volume and proxies over HTTP (see nptoy
# backend/session.py SciSession). This mirrors nptoy's local Session state machine.
_SESS_LOG_CAP = 4000


class _Session:
    def __init__(self, sid: str, argv: list[str], cwd: Path, geom_cmd: str | None):
        self.id = sid
        self.state = "starting"          # starting → idle → running → idle … → stopped
        self.runs = 0
        self.lines: list[str] = []
        self._lock = threading.Lock()
        self._io_lock = threading.Lock()
        self._geom_cmd = geom_cmd        # sent once at first Idle> (the viewer geometry dump)
        self._geom_sent = False
        self.last_touch = time.time()    # updated on every poll; the reaper kills the idle-forgotten
        self._proc = subprocess.Popen(
            argv, cwd=str(cwd),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            start_new_session=True, bufsize=0, env=os.environ,
        )
        threading.Thread(target=self._reader, name=f"sci-sess-{sid}", daemon=True).start()

    def _set(self, st: str) -> None:
        with self._lock:
            if self.state != "stopped":
                self.state = st

    def _add(self, line: str) -> None:
        with self._lock:
            self.lines.append(line)
            if len(self.lines) > _SESS_LOG_CAP:
                del self.lines[: len(self.lines) - _SESS_LOG_CAP]

    def _reader(self) -> None:
        fd = self._proc.stdout.fileno()
        buf = ""
        while True:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                break
            if not chunk:
                break
            buf += chunk.decode(errors="replace")
            while "\n" in buf:
                line, buf = buf.split("\n", 1)
                self._add(line.rstrip("\r"))
            # The `Idle> ` prompt has no trailing newline → detect on the tail.
            if buf.rstrip().endswith("Idle>"):
                self._set("idle")
                if self._geom_cmd and not self._geom_sent and self.alive():
                    self._geom_sent = True
                    self._send(self._geom_cmd)
        self._set("stopped")

    def _send(self, command: str) -> None:
        with self._io_lock:
            try:
                self._proc.stdin.write(f"{command}\n".encode())
                self._proc.stdin.flush()
            except (BrokenPipeError, OSError):
                pass

    def alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def beamon(self, n: int) -> None:
        if self.state != "idle":
            raise ValueError("session is not idle")
        self._add(f"» /run/beamOn {n}")
        with self._lock:
            self.runs += 1
            self.state = "running"
        self._send(f"/run/beamOn {n}")

    def set_verbose(self, on: bool) -> None:
        """Toggle Geant4 per-step tracking output on the live terminal. Only ever the
        fixed `/tracking/verbose 0|1` command — never user text. Applies to the next
        /run/beamOn (queued in stdin if sent while a run is in flight)."""
        if self.alive():
            self._add(f"» /tracking/verbose {1 if on else 0}")
            self._send(f"/tracking/verbose {1 if on else 0}")

    def stop(self, force: bool = False) -> None:
        if self.alive():
            if force:
                # abort a long/heavy run NOW — SIGKILL the process group, no graceful wait
                try:
                    os.killpg(os.getpgid(self._proc.pid), signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
            else:
                try:
                    self._proc.stdin.write(b"exit\n")
                    self._proc.stdin.flush()
                except (BrokenPipeError, OSError):
                    pass
                try:
                    self._proc.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(os.getpgid(self._proc.pid), signal.SIGKILL)
                    except (ProcessLookupError, PermissionError):
                        pass
        self._set("stopped")

    def touch(self) -> None:
        self.last_touch = time.time()

    def status(self) -> dict:
        self.touch()
        with self._lock:
            return {"id": self.id, "state": self.state, "runs": self.runs, "alive": self.alive()}

    def log_since(self, since: int) -> dict:
        self.touch()
        with self._lock:
            since = max(0, min(since, len(self.lines)))
            return {"lines": self.lines[since:], "next": len(self.lines), "state": self.state}


_sessions: dict[str, _Session] = {}
_sessions_lock = threading.Lock()
# The portal stops sessions when the user does, but if it restarts / crashes it
# forgets them — leaving an orphan npsimulation sitting at Idle> forever. Reap any
# session that's dead, or that no one has polled in SESSION_IDLE_TIMEOUT seconds.
SESSION_IDLE_TIMEOUT = int(os.environ.get("SCI_SESSION_IDLE_TIMEOUT", "1800"))


def _reap_sessions() -> None:
    while True:
        time.sleep(60)
        now = time.time()
        for sid, s in list(_sessions.items()):
            if not s.alive() or (now - s.last_touch) > SESSION_IDLE_TIMEOUT:
                with _sessions_lock:
                    _sessions.pop(sid, None)
                try:
                    s.stop()
                except Exception:
                    pass


threading.Thread(target=_reap_sessions, name="sci-session-reaper", daemon=True).start()


class SessionSpec(BaseModel):
    argv: list[str]                              # e.g. ["npsimulation","-D",...,"-N","--record-track"]
    cwd: str | None = None                       # run dir, relative to SCI_DATA (staged by the caller)
    name: str | None = None
    geom_cmd: str | None = None                  # /det/export_geometry <rel> sent once when Idle>


class BeamOn(BaseModel):
    n: int


class Verbose(BaseModel):
    on: bool


class StopSpec(BaseModel):
    force: bool = False


def _get_session(sid: str) -> _Session:
    with _sessions_lock:
        s = _sessions.get(sid)
    if not s:
        raise HTTPException(404, "no such session")
    return s


@app.post("/session", status_code=201)
def session_create(spec: SessionSpec, authorization: str | None = Header(default=None)):
    _auth(authorization)
    if not spec.argv or spec.argv[0] not in ALLOWED:
        raise HTTPException(400, f"argv[0] must be one of {sorted(ALLOWED)}")
    if any(not isinstance(a, str) for a in spec.argv):
        raise HTTPException(400, "argv must be strings")
    # geom_cmd is the ONLY free-form string we send to the G4 terminal at startup;
    # constrain it to the geometry-export command so it can't smuggle other commands.
    if spec.geom_cmd is not None and not spec.geom_cmd.startswith("/det/export_geometry "):
        raise HTTPException(400, "geom_cmd must be a /det/export_geometry command")
    sid = uuid.uuid4().hex[:12]
    wd = _resolve_cwd(spec.cwd, JOBS_DIR / sid)
    s = _Session(sid, spec.argv, wd, spec.geom_cmd)
    with _sessions_lock:
        _sessions[sid] = s
    return {"session_id": sid}


@app.get("/session/{sid}")
def session_get(sid: str, authorization: str | None = Header(default=None)):
    _auth(authorization)
    return _get_session(sid).status()


@app.get("/session/{sid}/log")
def session_log(sid: str, since: int = 0, authorization: str | None = Header(default=None)):
    _auth(authorization)
    return _get_session(sid).log_since(since)


@app.post("/session/{sid}/beamon")
def session_beamon(sid: str, body: BeamOn, authorization: str | None = Header(default=None)):
    _auth(authorization)
    s = _get_session(sid)
    n = int(body.n)
    if n < 1 or n > 100_000_000:                 # a validated integer — never user text
        raise HTTPException(400, "n out of range")
    try:
        s.beamon(n)
    except ValueError as exc:
        raise HTTPException(409, str(exc))        # not idle yet
    return s.status()


@app.post("/session/{sid}/verbose")
def session_verbose(sid: str, body: Verbose, authorization: str | None = Header(default=None)):
    _auth(authorization)
    _get_session(sid).set_verbose(bool(body.on))
    return {"ok": True, "verbose": bool(body.on)}


@app.post("/session/{sid}/stop")
def session_stop(sid: str, body: StopSpec | None = None, authorization: str | None = Header(default=None)):
    _auth(authorization)
    with _sessions_lock:
        s = _sessions.pop(sid, None)
    if s:
        s.stop(force=bool(body.force) if body else False)
    return {"stopped": bool(s)}
