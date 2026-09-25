"""profiles.py — named planner setups, stored per portal user.

A profile is one whole planner setup (beam / collimator / target slots, detector
rings, single detectors, reaction). Drop-in like layout.py:

    from profiles import build_profiles_router
    app.include_router(build_profiles_router(
        path=DATA / "profiles", identity=identity))

One JSON file per profile under <path>/<owner>/<id>.json, so a profile survives
the browser it was made in and follows the portal account across machines.
Listing is metadata only — the panel loads a body when you open it.

Everyone reads and writes their OWN profiles. `shared: true` publishes one
read-only to everybody else, which is how a group converges on one geometry
without an extra permission model.

`profile_seed/` ships built-in profiles with the service (owner `_seed`). They
show up for every account, can be loaded and copied, and cannot be edited or
deleted — so the stock STARK layout is always one click away no matter what
anyone does to their own list.
"""

import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Callable, Optional

from fastapi import APIRouter, Depends, HTTPException

MAX_BYTES = 2_000_000          # a setup is a few kB; this is a sanity bound
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
SEED_OWNER = "_seed"
SEED_DIR = Path(__file__).resolve().parent / "profile_seed"


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _owner_key(user: dict) -> str:
    """Stable per-account folder name. Email is the portal's link_by key; fall
    back to the numeric id so a tokenless dev session still works."""
    raw = str((user or {}).get("email") or (user or {}).get("id") or "anon")
    return re.sub(r"[^A-Za-z0-9._-]", "_", raw)[:80] or "anon"


def _meta(rec: dict, pid: str, owner: str, mine: bool) -> dict:
    return {
        "id": pid, "name": rec.get("name") or pid, "owner": owner, "mine": mine,
        "builtin": owner == SEED_OWNER,
        "shared": bool(rec.get("shared")), "note": rec.get("note") or "",
        "updated": rec.get("updated") or 0, "created": rec.get("created") or 0,
    }


def build_profiles_router(*, path, identity: Callable) -> APIRouter:
    router = APIRouter(prefix="/api/profiles", tags=["profiles"])
    root = Path(path)

    def _file(owner: str, pid: str) -> Path:
        if not SAFE_ID.match(pid):
            raise HTTPException(400, "invalid profile id")
        if owner == SEED_OWNER:
            return SEED_DIR / f"{pid}.json"
        return root / owner / f"{pid}.json"

    def _read(p: Path) -> Optional[dict]:
        try:
            return json.loads(p.read_text())
        except Exception:
            return None

    @router.get("")
    def list_profiles(user: dict = Depends(identity)) -> dict:
        me = _owner_key(user)
        out = []
        if root.is_dir():
            for odir in sorted(root.iterdir()):
                if not odir.is_dir():
                    continue
                mine = odir.name == me
                for fp in sorted(odir.glob("*.json")):
                    rec = _read(fp)
                    if rec is None:
                        continue
                    if not mine and not rec.get("shared"):
                        continue
                    out.append(_meta(rec, fp.stem, odir.name, mine))
        seeds = []
        if SEED_DIR.is_dir():
            for fp in sorted(SEED_DIR.glob("*.json")):
                rec = _read(fp)
                if rec is not None:
                    seeds.append(_meta(rec, fp.stem, SEED_OWNER, False))
        out.sort(key=lambda r: (not r["mine"], -(r["updated"] or 0)))
        return {"profiles": out + seeds, "me": me}

    @router.get("/{owner}/{pid}")
    def get_profile(owner: str, pid: str, user: dict = Depends(identity)) -> dict:
        rec = _read(_file(owner, pid))
        if rec is None:
            raise HTTPException(404, "프로필을 찾을 수 없습니다.")
        if owner == SEED_OWNER:
            return rec
        if owner != _owner_key(user) and not rec.get("shared"):
            raise HTTPException(403, "공유되지 않은 프로필입니다.")
        return rec

    @router.post("")
    def save_profile(payload: dict, user: dict = Depends(identity)) -> dict:
        """Create or overwrite one of MY profiles. Pass `id` to overwrite,
        omit it to create (which is what New and Copy both do)."""
        me = _owner_key(user)
        setup = payload.get("setup")
        if not isinstance(setup, dict) or "rings" not in setup:
            raise HTTPException(400, "invalid setup")
        name = (payload.get("name") or setup.get("name") or "untitled").strip()[:80]
        pid = payload.get("id") or uuid.uuid4().hex[:12]
        if not SAFE_ID.match(pid):
            raise HTTPException(400, "invalid profile id")
        fp = _file(me, pid)
        prev = _read(fp) if fp.is_file() else None
        now = int(time.time())
        rec = {
            "id": pid, "name": name, "owner": me,
            "shared": bool(payload.get("shared", prev.get("shared") if prev else False)),
            "note": (payload.get("note") or (prev or {}).get("note") or "")[:400],
            "created": (prev or {}).get("created") or now, "updated": now,
            "setup": setup,
        }
        blob = json.dumps(rec, ensure_ascii=False, indent=2)
        if len(blob.encode()) > MAX_BYTES:
            raise HTTPException(413, "프로필이 너무 큽니다.")
        _atomic_write(fp, blob)
        return _meta(rec, pid, me, True)

    @router.delete("/{pid}")
    def delete_profile(pid: str, user: dict = Depends(identity)) -> dict:
        fp = _file(_owner_key(user), pid)
        if not fp.is_file():
            raise HTTPException(404, "프로필을 찾을 수 없습니다.")
        fp.unlink()
        return {"ok": True}

    return router
