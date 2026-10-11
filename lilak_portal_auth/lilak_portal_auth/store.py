"""One shared document per portal project — the backend every rack-list
service was copying.

author_manager, reference_manager and the services after them each kept the
same hundred lines: read the JSON document (creating it on first use), refuse
to hand back a broken file as empty, take a whole-document PUT guarded by the
version it was edited from, answer the version cheaply, say who you are, and
serve the built SPA with a catch-all that must come last. Only the KEYS
differed.

    from lilak_portal_auth.store import Document, mount_spa

    doc = Document(DATA / "data.json", keys=("references", "journals", "settings"))
    doc.mount(app, project=PROJECT)
    ...  # the service's own routes
    mount_spa(app, DIST, name="reference_manager")   # LAST

Deliberately no `from __future__ import annotations` and no pydantic model
built inside a function: on the shared Python 3.14 venv that combination makes
FastAPI reject every body with 422. The PUT body is a plain dict.
"""
import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Body, Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import identity


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def atomic_write(path: Path, text: str) -> None:
    """Write beside, fsync, then rename over: a crash leaves the old file whole."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


class Document:
    """The project's document: whole, versioned, one writer at a time.

    `keys` are the lists the server owns; a key named "settings" is a dict.
    Anything else a client sends is ignored — per-user state stays in the
    browser and must not be clobbered by someone else's save.
    """

    def __init__(self, path: Path, keys: tuple, what: str = "데이터", keep_days: int = 0):
        self.path = Path(path)
        self.keys = tuple(keys)
        self.what = what
        # Every save replaces the whole document, so one wrong press can be the
        # end of a list. With keep_days set, what a save replaces is kept:
        # <name>.prev.json every time (the step back) and backups/<name>-<date>.json
        # on the first save of each day (the copy for the mistake nobody noticed).
        self.keep_days = keep_days
        self.lock = threading.Lock()

    def _empty(self, k: str):
        return {} if k == "settings" else []

    def blank(self) -> dict:
        return {"version": 1, **{k: self._empty(k) for k in self.keys},
                "updatedAt": _now(), "updatedBy": ""}

    def read(self) -> dict:
        """Current document, creating it on first use. Call under `lock`."""
        if not self.path.exists():
            doc = self.blank()
            atomic_write(self.path, json.dumps(doc, ensure_ascii=False))
            return doc
        try:
            doc = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            # Never hand back a broken file as "empty" — that would invite a PUT
            # that wipes the list. Fail loudly instead.
            raise HTTPException(500, f"{self.what} 파일을 읽을 수 없습니다.")
        for k in self.keys:
            doc.setdefault(k, self._empty(k))
        doc.setdefault("version", 1)
        return doc

    def keep(self, old: dict) -> None:
        """Keep the document a save is about to replace. Plain documents: to
        restore one, stop the service and move it over the live file."""
        if not self.keep_days:
            return
        try:
            text = json.dumps(old, ensure_ascii=False)
            stem = self.path.stem
            atomic_write(self.path.with_name(f"{stem}.prev.json"), text)
            day = self.path.parent / "backups" / f"{stem}-{datetime.now().date().isoformat()}.json"
            if not day.exists():
                atomic_write(day, text)
                for gone in sorted(day.parent.glob(f"{stem}-*.json"))[:-self.keep_days]:
                    gone.unlink(missing_ok=True)
        except Exception:
            # A full disk must not cost the user the save they just made.
            pass

    def write(self, doc: dict, who: str = "", replaces: dict = None) -> dict:
        """Bump the version and store. Call under `lock`, after `read`."""
        if replaces is not None:
            self.keep(replaces)
        doc["version"] = int(doc.get("version", 0)) + 1
        doc["updatedAt"] = _now()
        doc["updatedBy"] = who
        atomic_write(self.path, json.dumps(doc, ensure_ascii=False))
        return doc

    def mount(self, app: FastAPI, project: str = "") -> None:
        """GET/PUT /api/data, GET /api/data/version, GET /api/whoami."""
        doc_ = self

        @app.get("/api/data")
        def get_data(_: dict = Depends(identity)) -> dict:
            with doc_.lock:
                return doc_.read()

        @app.put("/api/data")
        def put_data(body: dict = Body(...), me: dict = Depends(identity)):
            with doc_.lock:
                cur = doc_.read()
                if body.get("baseVersion") != cur["version"]:
                    # Someone else saved since this client loaded. Hand back the
                    # current document so it reloads rather than overwrites them.
                    return JSONResponse(status_code=409, content={
                        "detail": "다른 사용자가 먼저 저장했습니다. 최신 데이터를 불러옵니다.",
                        "current": cur,
                    })
                new = dict(cur)
                for k in doc_.keys:
                    val = body.get(k)
                    if val is not None:
                        if not isinstance(val, dict if k == "settings" else list):
                            raise HTTPException(422, f"'{k}' 형식이 맞지 않습니다.")
                        new[k] = val
                return doc_.write(new, me.get("email") or me.get("username") or "", replaces=cur)

        @app.get("/api/data/version")
        def get_version(_: dict = Depends(identity)) -> dict:
            # Cheap poll target: ask for the version, fetch the document only
            # when it moved.
            with doc_.lock:
                return {"version": doc_.read()["version"]}

        @app.get("/api/whoami")
        def whoami(me: dict = Depends(identity)) -> dict:
            return {**me, "project": project}


def mount_spa(app: FastAPI, dist: Path, name: str = "service") -> None:
    """Serve the built app. Must be mounted LAST: its catch-all would shadow
    every /api route registered after it."""
    dist = Path(dist)
    assets = dist / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=str(assets)), name="assets")

    @app.get("/{path:path}")
    def spa(path: str):
        candidate = dist / path
        if path and candidate.is_file():
            return FileResponse(candidate)
        index = dist / "index.html"
        if index.is_file():
            return FileResponse(index)
        raise HTTPException(404, f"{name} dist not built")
