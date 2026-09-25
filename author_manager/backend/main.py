"""author_manager backend — server-side storage so a portal project's asset list is
SHARED by everyone who can enter it (previously each browser kept its own copy in
localStorage, so nothing was shared across users or devices).

Runs one process per portal project (model A): the portal passes the project's own
data dir as AUTHOR_DATA_DIR ({project_data}), so each project's list is isolated.

What lives here (shared) vs. in the browser (per-user):
  server : assets, records (saved lists), locations, types
  browser: myList, myPhotos, myListName, currentListId, myLocation — a user's own
           working set, which must NOT be clobbered by someone else's save.

Concurrency: the document is stored whole and carries a `version`. A PUT must send
the `baseVersion` it edited; if the stored version moved on (someone else saved
first) it is rejected with 409 + the current document, and the client reloads
instead of silently overwriting the other person's work.
"""
from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from lilak_portal_auth import identity

# The portal hands each project process its own data dir via {project_data}.
DATA = Path(os.environ.get("AUTHOR_DATA_DIR", "./data"))
PROJECT = os.environ.get("PORTAL_PROJECT", "")
DIST = Path(os.environ.get("AUTHOR_DIST_DIR", "/app/author_manager/dist"))
DATA_FILE = DATA / "data.json"

# One-time seed of the ~993-row CENS inventory (public/seed-assets.js, which vite
# copies into dist/). Only for the listed projects, and only when the project has
# no data yet — an existing list is never touched.
SEED_PROJECTS = {p.strip() for p in
                 os.environ.get("AUTHOR_SEED_PROJECTS", "").split(",") if p.strip()}
SEED_FILE = Path(os.environ.get("AUTHOR_SEED_FILE", str(DIST / "seed-assets.js")))

# Keys the server owns. Anything else the client sends is ignored (per-user state
# stays in the browser).
SHARED_KEYS = ("authors", "affiliations", "groups", "settings")

_lock = threading.Lock()          # serialize read-modify-write within this process

app = FastAPI(title="author_manager")


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


def _parse_seed(path: Path) -> list:
    """seed-assets.js is `window.CENS_SEED_ASSETS = [ … ];` — a JSON array with a JS
    wrapper. Slice to the outer brackets and parse; a malformed file just seeds empty."""
    try:
        txt = path.read_text(encoding="utf-8")
        i, j = txt.find("["), txt.rfind("]")
        if i < 0 or j <= i:
            return []
        val = json.loads(txt[i:j + 1])
        return val if isinstance(val, list) else []
    except Exception:
        return []


def _blank() -> dict:
    return {"version": 1, "authors": [], "affiliations": [], "groups": [],
            "settings": {}, "updatedAt": _now(), "updatedBy": ""}


def _read() -> dict:
    """Current document, creating (and seeding) it on first use."""
    if not DATA_FILE.exists():
        doc = _blank()
        if PROJECT in SEED_PROJECTS:
            doc["authors"] = _parse_seed(SEED_FILE)
        _atomic_write(DATA_FILE, json.dumps(doc, ensure_ascii=False))
        return doc
    try:
        doc = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    except Exception:
        # Never hand back a broken file as "empty" — that would invite a PUT that
        # wipes the list. Fail loudly instead.
        raise HTTPException(500, "자산 데이터 파일을 읽을 수 없습니다.")
    for k in SHARED_KEYS:
        doc.setdefault(k, {} if k == "settings" else [])
    doc.setdefault("version", 1)
    return doc


class SaveBody(BaseModel):
    baseVersion: int
    authors: Optional[list] = None
    affiliations: Optional[list] = None
    groups: Optional[list] = None
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
            # Someone else saved since this client loaded. Hand back the current
            # document so it can reload rather than overwrite them.
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
    """Cheap poll target: clients ask for just the version every few seconds and
    fetch the full document only when it moved (the doc carries inline photos, so
    polling GET /api/data itself would be megabytes per tick)."""
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
    raise HTTPException(404, "author_manager dist not built")
