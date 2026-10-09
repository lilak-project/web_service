"""reference_manager backend — one shared document per portal project.

The same shape as author_manager's: a single JSON document holding the records
and the classes they point at, stored whole and guarded by a version, so two
people editing at once cannot silently overwrite each other.

  references  the papers: citeKey, title, authors[], journal, year, tags[], cites[], pdf
  journals    a class with fields of its own (shortName, abbrev)
  authors     a class: one person, a #handle, and the spellings they appear under
  settings    service-wide, e.g. the roots a linked PDF may live under

A topic set and a collaboration are tags, not classes: same many-to-many, no
fields of their own. The tag list is gathered from the papers.

Concurrency: a PUT sends the `baseVersion` it edited; if the stored version moved
on it is rejected with 409 + the current document, and the client reloads.
"""
import json
import os
import subprocess
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from lilak_portal_auth import identity

# The portal hands each project process its own data dir via {project_data}.
DATA = Path(os.environ.get("REFERENCE_DATA_DIR", "./data"))
PROJECT = os.environ.get("PORTAL_PROJECT", "")
DIST = Path(os.environ.get("REFERENCE_DIST_DIR", "/app/reference_manager/dist"))
DATA_FILE = DATA / "data.json"

# Keys the server owns. Anything else the client sends is ignored (per-user state
# stays in the browser).
SHARED_KEYS = ("references", "journals", "authors", "settings")

_lock = threading.Lock()          # serialize read-modify-write within this process

app = FastAPI(title="reference_manager")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _blank() -> dict:
    return {"version": 1, "references": [], "journals": [], "authors": [],
            "settings": {}, "updatedAt": _now(), "updatedBy": ""}


def _read() -> dict:
    """Current document, creating it on first use."""
    if not DATA_FILE.exists():
        doc = _blank()
        _atomic_write(DATA_FILE, json.dumps(doc, ensure_ascii=False))
        return doc
    try:
        doc = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    except Exception:
        # Never hand back a broken file as "empty" — that would invite a PUT that
        # wipes the list. Fail loudly instead.
        raise HTTPException(500, "레퍼런스 데이터 파일을 읽을 수 없습니다.")
    for k in SHARED_KEYS:
        doc.setdefault(k, {} if k == "settings" else [])
    doc.setdefault("version", 1)
    return doc


class SaveBody(BaseModel):
    baseVersion: int
    references: Optional[list] = None
    journals: Optional[list] = None
    authors: Optional[list] = None
    settings: Optional[dict] = None


@app.get("/api/data")
def get_data(_: dict = Depends(identity)) -> dict:
    with _lock:
        return _read()


@app.put("/api/data")
def put_data(body: SaveBody, me: dict = Depends(identity)):
    with _lock:
        cur = _read()
        if body.baseVersion != cur["version"]:
            return JSONResponse(status_code=409, content={
                "detail": "다른 사용자가 먼저 저장했습니다. 최신 데이터를 불러옵니다.",
                "current": cur,
            })
        doc = dict(cur)
        for k in SHARED_KEYS:
            val = getattr(body, k)
            if val is not None:
                doc[k] = val
        doc["version"] = cur["version"] + 1
        doc["updatedAt"] = _now()
        doc["updatedBy"] = me.get("email") or me.get("username") or ""
        _atomic_write(DATA_FILE, json.dumps(doc, ensure_ascii=False))
        return doc


@app.get("/api/data/version")
def get_version(_: dict = Depends(identity)) -> dict:
    with _lock:
        return {"version": _read()["version"]}


@app.get("/api/whoami")
def whoami(me: dict = Depends(identity)) -> dict:
    return {**me, "project": PROJECT}


# ── The PDFs ─────────────────────────────────────────────────────────────────
# A browser cannot open file:///… from an http page, so the service reads the
# file for it. Only from the roots the project has listed, and only after the
# path has been resolved — a symlink out of a root is out of the root.

def _roots() -> list[Path]:
    with _lock:
        got = (_read().get("settings") or {}).get("pdfRoots") or []
    out = []
    for r in got:
        try:
            out.append(Path(r).expanduser().resolve())
        except Exception:
            pass
    return out


def _inside(path: Path, roots: list[Path]) -> Optional[Path]:
    """The real file this path names, if it is under one of the roots."""
    try:
        real = (path if path.is_absolute() else None)
        for root in roots:
            cand = (real or (root / path)).resolve()
            if cand.is_file() and (cand == root or root in cand.parents):
                return cand
    except Exception:
        return None
    return None


@app.get("/api/file")
def get_file(path: str, _: dict = Depends(identity)):
    """Serve one PDF out of an allowed root. `path` is relative to a root, or
    absolute and under one."""
    roots = _roots()
    if not roots:
        raise HTTPException(409, "허용 루트가 설정되지 않았습니다.")
    real = _inside(Path(path), roots)
    if not real:
        raise HTTPException(404, "그 경로의 파일이 없거나 허용 루트 밖입니다.")
    return FileResponse(real, media_type="application/pdf", filename=real.name)


class RevealBody(BaseModel):
    path: str


@app.post("/api/reveal")
def reveal(body: RevealBody, _: dict = Depends(identity)):
    """Show the file in the host's file manager. Only works when the backend is
    on the machine the files are — which is the same condition as the link."""
    real = _inside(Path(body.path), _roots())
    if not real:
        raise HTTPException(404, "그 경로의 파일이 없거나 허용 루트 밖입니다.")
    try:
        subprocess.Popen(["open", "-R", str(real)])
    except Exception as exc:
        raise HTTPException(500, f"열 수 없습니다: {exc}")
    return {"ok": True, "path": str(real)}


@app.get("/api/scan")
def scan(_: dict = Depends(identity)) -> dict:
    """Every PDF under the roots, by its file name. The client matches those
    names against its cite keys — the naming convention IS the link."""
    found: dict[str, list[str]] = {}
    for root in _roots():
        for dirpath, _dirs, names in os.walk(root):
            for n in names:
                if n.lower().endswith(".pdf"):
                    rel = os.path.relpath(os.path.join(dirpath, n), root)
                    found.setdefault(os.path.splitext(n)[0], []).append(rel)
    return {"roots": [str(r) for r in _roots()], "files": found}


# ── Static SPA (must stay last: the catch-all would shadow /api/*) ────────────
_assets = DIST / "assets"
if _assets.is_dir():
    app.mount("/assets", StaticFiles(directory=str(_assets)), name="assets")


@app.get("/{path:path}")
def spa(path: str):
    candidate = DIST / path
    if path and candidate.is_file():
        return FileResponse(candidate)
    index = DIST / "index.html"
    if index.is_file():
        return FileResponse(index)
    raise HTTPException(404, "reference_manager dist not built")
