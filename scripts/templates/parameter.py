"""parameter.py — reusable LILAK parameter-editor router (the 파라미터 tab).

Drop-in, like community.py: build a router and include it. It serves a web port of
`lilak par` — browse / open / edit / save LILAK's `.mac`/`.par`/`.conf` parameter
files under $LILAK_PATH, all confined to that tree.

    from parameter import build_parameter_router
    app.include_router(build_parameter_router(
        lilak_path=os.environ.get("LILAK_PATH") or str(Path.home() / "Research" / "lilak"),
        identity=identity,                 # portal SSO → gates every route
    ))

Pure Python (only needs parameter_parser.py alongside) — the ROOT-backed "expand"
route from the original tool is intentionally omitted so this drops in anywhere.
The matching frontend is pages/ParameterEditor.jsx (talks to /api/params/*).
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Callable

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from parameter_parser import (
    parse_parameter_text,
    serialize_rows,
    normalize_searchrun_mfm_rows,
)

PARAM_SUFFIXES = {".mac", ".par", ".conf"}
EXCLUDE_DIRS = {"build", "doc", ".git", "node_modules", "ui", "temp", "zzz", ".venv"}
MAX_FILES = 800
FIND_LIMIT = 50


def build_parameter_router(*, lilak_path, identity: Callable) -> APIRouter:
    LILAK_PATH = Path(lilak_path).expanduser().resolve()
    PARAM_TEMPLATE = LILAK_PATH / "meta" / "parameters" / "configure_LKRun.mac"

    def safe_resolve(rel_path: str) -> Path:
        """Resolve a path relative to LILAK_PATH, refusing to escape it."""
        p = (LILAK_PATH / rel_path).resolve()
        if not str(p).startswith(str(LILAK_PATH)):
            raise ValueError(f"path escapes LILAK directory: {rel_path}")
        return p

    # Every route requires a logged-in portal user (the tree is edited in place).
    router = APIRouter(prefix="/api/params", tags=["params"], dependencies=[Depends(identity)])

    @router.get("/files")
    def list_files():
        found = []
        for root, dirs, files in os.walk(LILAK_PATH):
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS and not d.startswith(".")]
            for f in files:
                if os.path.splitext(f)[1] in PARAM_SUFFIXES:
                    full = os.path.join(root, f)
                    rel = os.path.relpath(full, LILAK_PATH)
                    found.append({"path": rel, "name": f, "dir": os.path.dirname(rel),
                                  "mtime": os.path.getmtime(full)})
                    if len(found) >= MAX_FILES:
                        break
            if len(found) >= MAX_FILES:
                break
        found.sort(key=lambda x: x["path"])
        return {"files": found, "root": str(LILAK_PATH)}

    @router.get("/find")
    def find_files(q: str):
        """Search parameter files by name fragment (port of lilak par 'find')."""
        query = q.strip().lower()
        if not query:
            return {"matches": []}
        results, seen = [], set()
        for base in [LILAK_PATH, LILAK_PATH / "common"]:
            if not base.exists():
                continue
            for suffix in PARAM_SUFFIXES:
                for path in base.rglob(f"*{query}*{suffix}"):
                    if any(part in EXCLUDE_DIRS or part.startswith(".") for part in path.parts):
                        continue
                    resolved = path.resolve()
                    if resolved in seen:
                        continue
                    seen.add(resolved)
                    results.append(os.path.relpath(resolved, LILAK_PATH))
                    if len(results) >= FIND_LIMIT:
                        return {"matches": sorted(results)}
        return {"matches": sorted(results)}

    @router.get("/projects")
    def list_projects():
        """LILAK sub-projects — top-level dirs carrying a CMakeLists.txt."""
        projects = []
        try:
            entries = sorted(LILAK_PATH.iterdir(), key=lambda p: p.name.lower())
        except OSError:
            entries = []
        for entry in entries:
            if not entry.is_dir() or entry.name in EXCLUDE_DIRS or entry.name.startswith("."):
                continue
            if (entry / "CMakeLists.txt").is_file():
                projects.append({"name": entry.name, "path": entry.name})
        return {"projects": projects, "root": str(LILAK_PATH)}

    @router.get("/browse")
    def browse(dir: str = ""):
        """Directory listing for the open-file browser: sub-dirs + parameter files."""
        rel = (dir or "").strip().strip("/")
        try:
            base = safe_resolve(rel) if rel else LILAK_PATH
        except ValueError as e:
            raise HTTPException(400, str(e))
        if not base.is_dir():
            raise HTTPException(404, f"not a directory: {dir}")
        dirs, files = [], []
        for entry in sorted(base.iterdir(), key=lambda p: p.name.lower()):
            if entry.name.startswith("."):
                continue
            if entry.is_dir():
                if entry.name in EXCLUDE_DIRS:
                    continue
                dirs.append({"name": entry.name, "path": os.path.relpath(entry, LILAK_PATH), "is_dir": True})
            elif entry.suffix in PARAM_SUFFIXES:
                files.append({"name": entry.name, "path": os.path.relpath(entry, LILAK_PATH), "is_dir": False})
        parent = "" if not rel else os.path.dirname(rel)
        return {"cwd": rel, "parent": parent, "entries": dirs + files}

    @router.get("/file")
    def read_file(path: str):
        try:
            p = safe_resolve(path)
        except ValueError as e:
            raise HTTPException(400, str(e))
        if not p.is_file():
            raise HTTPException(404, f"file not found: {path}")
        text = p.read_text(encoding="utf-8", errors="replace")
        return {"path": path, "content": text, "rows": parse_parameter_text(text)}

    @router.get("/template")
    def template():
        if not PARAM_TEMPLATE.is_file():
            return {"path": "", "rows": [
                {"kind": "comment", "enabled": False, "group": "", "name": "", "value": "", "unit": "", "comment": "new lilak run configuration"},
                {"kind": "parameter", "enabled": True, "group": "LKRun", "name": "Name", "value": "run", "unit": "", "comment": ""},
                {"kind": "parameter", "enabled": True, "group": "LKRun", "name": "RunID", "value": "0", "unit": "", "comment": ""},
                {"kind": "parameter", "enabled": True, "group": "LKRun", "name": "InputFile", "value": "", "unit": "", "comment": ""},
                {"kind": "parameter", "enabled": True, "group": "lilak", "name": "run", "value": "0", "unit": "", "comment": "run all events"},
                {"kind": "parameter", "enabled": True, "group": "lilak", "name": "auto_exit", "value": "1", "unit": "", "comment": ""},
            ]}
        text = PARAM_TEMPLATE.read_text(encoding="utf-8", errors="replace")
        return {"path": "", "content": text, "rows": parse_parameter_text(text)}

    class SaveRequest(BaseModel):
        path: str
        rows: list[dict]

    @router.post("/file")
    def save_file(req: SaveRequest):
        try:
            p = safe_resolve(req.path)
        except ValueError as e:
            raise HTTPException(400, str(e))
        rows = normalize_searchrun_mfm_rows(req.rows)
        content = serialize_rows(rows)
        rows = parse_parameter_text(content)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        return {"ok": True, "path": req.path, "content": content, "rows": rows}

    class ContentRequest(BaseModel):
        content: str

    class RowsRequest(BaseModel):
        rows: list[dict]

    @router.post("/parse")
    def parse_content(req: ContentRequest):
        """raw text -> rows (for the raw view)."""
        return {"rows": parse_parameter_text(req.content)}

    @router.post("/serialize")
    def serialize_content(req: RowsRequest):
        """rows -> raw text (for the raw view)."""
        return {"content": serialize_rows(req.rows)}

    return router
