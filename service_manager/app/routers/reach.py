"""Paths outside the portal's data folder that a service may use — `/api/reach/*`.

A service the portal started asks before it reads or writes a host path that is
not under PORTAL_DATA_ROOT (`lilak_portal_auth.reach(path)` → POST /api/reach/check,
shown its PORTAL_SERVICE_KEY). The answer comes from `data/_portal/reach.json`:

    {"all": "list" | "allow" | "block",                 # every service at once
     "services": {svc: {"mode": "list" | "allow" | "block",
                        "paths": [{path, status: approved|waiting|blocked, by, at, why}]}}}

`list` (the default) is the list: an approved folder covers everything below it,
a blocked one refuses everything below it, the longest entry that covers a path
decides. A path nothing covers is refused and left `waiting`, for a manager to
answer on the account menu's Outside paths page (or the cover's inbox) — if it is the
home folder or inside it; a wider one is refused (`outside`) without a request, and
only a manager adding it by hand allows it. `allow` / `block` skip the list.
Approval is this portal's alone: the file is not part of any sync.
"""
import hmac
import json
import os
import threading
import time
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel

from .. import config, held, models, registry, security
from ..deps import require_portal_admin

router = APIRouter(tags=["portal-reach"])
MODES = ("list", "allow", "block")
_lock = threading.Lock()


def _file() -> Path:
    return config.DATA_ROOT / "_portal" / "reach.json"


def _norm(path: str) -> str:
    """Absolute, without `..` or a trailing slash. Not resolved here: the service sends the real path."""
    p = os.path.abspath(os.path.expanduser(str(path or "").strip()))
    if not str(path or "").strip() or "\x00" in p:
        raise ValueError("경로가 비어 있거나 올바르지 않습니다.")
    return p


def _seed() -> dict:
    """What was already in use when approval began starts approved, so nothing stops working:
    lilak flow's LILAK tree and the folders its projects were set to browse (the home folder
    where none was set, as it was)."""
    out = {"all": "list", "services": {}}
    if registry.manifest_path("lilak_flow").exists():
        now = time.time()
        paths = [os.environ.get("LILAK_PATH") or str(Path.home() / "Research" / "lilak")]
        for f in (config.DATA_ROOT / "lilak_flow" / "projects").glob("*/data/settings.json"):
            try:
                paths += [str(r) for r in json.loads(f.read_text("utf-8")).get("roots") or []]
            except (OSError, ValueError, AttributeError):
                pass
        if len(paths) == 1:
            paths.append(str(Path.home()))
        out["services"]["lilak_flow"] = {"mode": "list", "paths": [
            {"path": _norm(p), "status": "approved", "by": "", "at": now, "why": "쓰고 있던 경로"}
            for p in dict.fromkeys(paths) if os.path.isdir(os.path.expanduser(p))]}
    return out


def _read() -> dict:
    try:
        d = json.loads(_file().read_text("utf-8"))
        if isinstance(d, dict) and isinstance(d.get("services"), dict):
            return d
    except (OSError, ValueError):
        pass
    d = _seed()
    _write(d)
    return d


def _write(d: dict) -> None:
    registry._atomic_write_text(_file(), json.dumps(d, ensure_ascii=False, indent=2))


def _svc(d: dict, svc: str) -> dict:
    return d["services"].setdefault(svc, {"mode": "list", "paths": []})


def _covers(entry: str, path: str) -> bool:
    return path == entry or path.startswith(entry.rstrip("/") + "/")


def decide(svc: str, path: str, why: str = "", again: bool = False) -> dict:
    """{allowed, status} for one path a service asks about; a path nothing answers is left waiting.
    One a manager put on hold answers `held` with the opinions said (`comments`); `again` — the
    service asking anew, changed — puts it back to waiting."""
    path = _norm(path)
    with _lock:
        d = _read()
        s = _svc(d, svc)
        if "block" in (d.get("all"), s.get("mode")):
            return {"allowed": False, "status": "blocked"}
        if "allow" in (d.get("all"), s.get("mode")):
            return {"allowed": True, "status": "approved"}
        hit = max((e for e in s["paths"] if e["status"] != "waiting" and _covers(e["path"], path)),
                  key=lambda e: len(e["path"]), default=None)
        if hit:
            return {"allowed": hit["status"] == "approved", "status": hit["status"]}
        # A service may ASK only for the home folder or something inside it: a request for /Volumes
        # or / is too wide to be answered with a yes. Nothing is left waiting; a manager who does want
        # a path outside it (a data disk) adds it by hand on the Outside paths page.
        if not _covers(str(Path.home()), path):
            return {"allowed": False, "status": "outside"}
        mine = next((e for e in s["paths"] if e["path"] == path), None)
        if not mine and len(s["paths"]) < 500:
            s["paths"].append({"path": path, "status": "waiting", "by": "", "at": time.time(), "why": str(why or "")[:200]})
            _write(d)
        p = held.pid("path", svc, path)
        if mine and again:
            mine.update(why=str(why or mine.get("why") or "")[:200], at=time.time())
            _write(d)
            held.release(p)
        h = held.get(p)
        return {"allowed": False, "status": "held" if h["held"] else "waiting", "comments": h["comments"]}


def waiting() -> int:
    """How many paths wait for a manager's answer (the account card counts them)."""
    with _lock:
        return sum(1 for s in _read()["services"].values() for e in s["paths"] if e["status"] == "waiting")


class CheckBody(BaseModel):
    path: str
    why: str = ""
    again: bool = False        # asked anew after an opinion: a held one waits again


@router.post("/api/reach/check")
def check(b: CheckBody, x_portal_service: str = Header(default=""), x_portal_service_key: str = Header(default="")):
    """A service the portal started asks about one path. Loopback callers that show their service key only."""
    if not (x_portal_service and registry.valid_name(x_portal_service)
            and hmac.compare_digest(x_portal_service_key, security.service_key(x_portal_service))):
        raise HTTPException(403, "포털이 띄운 서비스만 물을 수 있습니다.")
    try:
        return decide(x_portal_service, b.path, b.why, b.again)
    except ValueError as e:
        raise HTTPException(400, str(e))


def _view() -> dict:
    d = _read()
    names = registry.list_service_names()
    return {"all": d.get("all") or "list",
            "services": [{"name": n, "label": registry.read_manifest(n).get("label") or n,
                          "mode": s.get("mode") or "list",
                          "paths": sorted(s["paths"], key=lambda e: (e["status"] != "waiting", e["path"]))}
                         for n, s in sorted(d["services"].items())],
            "installed": names}


@router.get("/api/admin/reach")
def state(_: models.User = Depends(require_portal_admin)):
    with _lock:
        return _view()


class ModeBody(BaseModel):
    service: str = ""          # "" = every service
    mode: str


@router.put("/api/admin/reach/mode")
def set_mode(b: ModeBody, _: models.User = Depends(require_portal_admin)):
    if b.mode not in MODES:
        raise HTTPException(400, "mode 는 list, allow, block 중 하나입니다.")
    with _lock:
        d = _read()
        if b.service:
            if not registry.valid_name(b.service):
                raise HTTPException(400, "서비스 이름이 올바르지 않습니다.")
            _svc(d, b.service)["mode"] = b.mode
        else:
            d["all"] = b.mode
        _write(d)
        return _view()


class PathBody(BaseModel):
    service: str
    path: str
    status: str = "approved"   # approved | blocked


@router.post("/api/admin/reach/paths")
def put_path(b: PathBody, user: models.User = Depends(require_portal_admin)):
    """Add a path, or answer one that waits (approve or block it)."""
    if b.status not in ("approved", "blocked") or not registry.valid_name(b.service):
        raise HTTPException(400, "status 는 approved 나 blocked 입니다.")
    try:
        path = _norm(b.path)
    except ValueError as e:
        raise HTTPException(400, str(e))
    with _lock:
        d = _read()
        s = _svc(d, b.service)
        e = next((x for x in s["paths"] if x["path"] == path), None)
        if not e:
            e = {"path": path, "why": ""}
            s["paths"].append(e)
        e.update(status=b.status, by=user.username, at=time.time())
        _write(d)
        held.drop(held.pid("path", b.service, path))
        return _view()


@router.delete("/api/admin/reach/paths")
def drop_path(b: PathBody, _: models.User = Depends(require_portal_admin)):
    """Take a path off the list: the service is refused it and may ask again."""
    with _lock:
        d = _read()
        s = _svc(d, b.service)
        s["paths"] = [x for x in s["paths"] if x["path"] != os.path.abspath(os.path.expanduser(b.path))]
        _write(d)
        held.drop(held.pid("path", b.service, os.path.abspath(os.path.expanduser(b.path))))
        return _view()
