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
import sys
import shutil
import threading
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from lilak_portal_auth import identity
from lilak_portal_auth.store import Document, mount_spa

# The portal hands each project process its own data dir via {project_data}.
DATA = Path(os.environ.get("REFERENCE_DATA_DIR", "./data"))
PROJECT = os.environ.get("PORTAL_PROJECT", "")
DIST = Path(os.environ.get("REFERENCE_DIST_DIR", "/app/reference_manager/dist"))
DATA_FILE = DATA / "data.json"

# The lists the server owns; the shared store reads, guards and writes them.
DOC = Document(DATA_FILE, keys=("references", "journals", "authors", "settings"),
               what="레퍼런스 데이터")

app = FastAPI(title="reference_manager")
DOC.mount(app, project=PROJECT)


# ── The PDFs ─────────────────────────────────────────────────────────────────
# A browser cannot open file:///… from an http page, so the service reads the
# file for it. Only from the roots the project has listed, and only after the
# path has been resolved — a symlink out of a root is out of the root.

def _roots() -> list[Path]:
    with DOC.lock:
        got = (DOC.read().get("settings") or {}).get("pdfRoots") or []
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
def get_file(path: str, download: int = 0, _: dict = Depends(identity)):
    """Serve one PDF out of an allowed root. `path` is relative to a root, or
    absolute and under one.

    Inline by default, so it can be read in the page. `download=1` asks for it
    as a file instead — which is the only way to get at it when the service is
    on another machine than the person reading it."""
    roots = _roots()
    if not roots:
        raise HTTPException(409, "허용 루트가 설정되지 않았습니다.")
    real = _inside(Path(path), roots)
    if not real:
        raise HTTPException(404, "그 경로의 파일이 없거나 허용 루트 밖입니다.")
    if download:
        return FileResponse(real, media_type="application/pdf", filename=real.name)
    return FileResponse(real, media_type="application/pdf",
                        headers={"content-disposition": f'inline; filename="{real.name}"'})


@app.get("/api/realpath")
def realpath(path: str, _: dict = Depends(identity)) -> dict:
    """Where the file actually is. The document stores a path relative to a
    root, and only the service knows which root it was found under."""
    real = _inside(Path(path), _roots())
    if not real:
        raise HTTPException(404, "그 경로의 파일이 없거나 허용 루트 밖입니다.")
    return {"path": str(real), "name": real.name}


class RevealBody(BaseModel):
    path: str


def _reveal_cmd(real: Path) -> tuple[list[str], str]:
    """Show a file in the desktop's own file manager, whichever one that is.

    macOS and Windows both have a 'select this file' call. Linux has one only
    through the file manager's D-Bus interface, and not every desktop answers
    it, so the folder itself is the fallback — a folder that opens beats a file
    that does not."""
    p = str(real)
    if sys.platform == "darwin":
        return ["open", "-R", p], "Finder"
    if os.name == "nt":
        return ["explorer", f"/select,{p}"], "탐색기"
    if shutil.which("dbus-send"):
        return ([
            "dbus-send", "--session", "--print-reply",
            "--dest=org.freedesktop.FileManager1", "--type=method_call",
            "/org/freedesktop/FileManager1", "org.freedesktop.FileManager1.ShowItems",
            f'array:string:file://{quote(p)}', 'string:""',
        ], "파일 관리자")
    if shutil.which("xdg-open"):
        return ["xdg-open", str(real.parent)], "파일 관리자(폴더)"
    return [], ""


@app.post("/api/reveal")
def reveal(body: RevealBody, _: dict = Depends(identity)):
    """Show the file where it lives. Only works when the backend runs on the
    machine with the screen — the same condition as the link itself."""
    real = _inside(Path(body.path), _roots())
    if not real:
        raise HTTPException(404, "그 경로의 파일이 없거나 허용 루트 밖입니다.")
    cmd, what = _reveal_cmd(real)
    if not cmd:
        raise HTTPException(501, "이 환경에서는 파일 관리자를 열 수 없습니다.")
    try:
        subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as exc:
        raise HTTPException(500, f"열 수 없습니다: {exc}")
    return {"ok": True, "where": what, "path": str(real)}


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
mount_spa(app, DIST, name="reference_manager")
