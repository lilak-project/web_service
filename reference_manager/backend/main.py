"""reference_manager backend — one shared document per portal project.

The same shape as author_manager's: a single JSON document holding the records
and the classes they point at, stored whole and guarded by a version, so two
people editing at once cannot silently overwrite each other.

  references  the papers: citeKey, title, author, journal, year, tags[], cites[], pdf
  journals    the one class with fields of its own (shortName, abbrev)
  settings    service-wide, e.g. the roots a linked PDF may live under

A topic set and a collaboration are tags, not classes: same many-to-many, no
fields of their own. The tag list is gathered from the papers.

Concurrency: a PUT sends the `baseVersion` it edited; if the stored version moved
on it is rejected with 409 + the current document, and the client reloads.
"""
import json
import os
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
SHARED_KEYS = ("references", "journals", "settings")

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
    return {"version": 1, "references": [], "journals": [], "settings": {},
            "updatedAt": _now(), "updatedBy": ""}


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
