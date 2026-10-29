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
import shutil
import subprocess
import sys
import threading
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from fastapi import Body, Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import identity, is_manager, manager, signed_in


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
    """The project's document — one FILE PER RECORD on disk, one document over the wire.

    `keys` are the collections the server owns; a key named "settings" is a
    dict. Anything else a client sends is ignored — per-user state stays in the
    browser and must not be clobbered by someone else's save.

    On disk, next to where data.json used to be:

        data/
          _local.json            version, who saved last, per-record versions
                                 — this server's bookkeeping, never synced
          settings.json
          <key>/<id>.json        one record (pretty, keys sorted: same content,
                                 same bytes — so a sync sees no false change)
          <key>/_order.json      the collection's order, by id

    Why: the unit of storage is now the unit of editing. A save writes only the
    records it changed, so two people editing different records — on this
    server, or later on two servers being synced — do not collide; only two
    edits of the SAME record are a conflict, and only those are refused.

    Over the wire nothing changed: GET /api/data still answers one document,
    PUT /api/data still takes one (with baseVersion). A data.json from before is
    split on first read, the split is checked by re-assembling it, and the old
    file is kept as data.json.pre-split.
    """

    def __init__(self, path: Path, keys: tuple, what: str = "데이터", keep_days: int = 0,
                 links: tuple = (), trash_days: int = 30):
        self.path = Path(path)                   # where the single file lived
        self.dir = self.path.with_suffix("")     # data.json → data/
        self.keys = tuple(keys)
        self.what = what
        # (items, "field" or "rows.field", class): where items point at a class
        # record. They used to point by NAME; read() turns those into ids once,
        # so renaming a journal changes one record, not every paper in it.
        self.links = tuple(links)
        self._upgrading = False
        self._ids_done = False
        # With keep_days, what a save replaces is kept: each changed or deleted
        # record under .history/, and the whole document once a day under
        # backups/ (the copy for the mistake nobody noticed for a week).
        self.keep_days = keep_days
        # A deleted record waits in .trash/ this many days, to be brought back
        # (GET /api/trash, POST /api/trash/restore) — whatever keep_days says.
        self.trash_days = trash_days
        self.lock = threading.Lock()
        self._cache = None
        self._stamp = None

    # ── layout ────────────────────────────────────────────────────────────
    @staticmethod
    def _dump(obj) -> str:
        return json.dumps(obj, ensure_ascii=False, sort_keys=True, indent=1) + "\n"

    @classmethod
    def _hash(cls, obj) -> str:
        import hashlib
        return hashlib.sha1(cls._dump(obj).encode()).hexdigest()

    @staticmethod
    def _at(trail: list, version: int):
        """The hash a record had at `version`: the last entry at or before it."""
        h = None
        for v, hh in trail or []:
            if int(v) <= version:
                h = hh
        return h

    @staticmethod
    def _fname(rid: str) -> str:
        """A record id as a file name: kept when it is already safe (uuids
        are), hashed otherwise — the id itself always lives inside the file."""
        import hashlib
        import re
        rid = str(rid)
        return rid if re.fullmatch(r"[A-Za-z0-9_.-]{1,120}", rid) and not rid.startswith(("_", ".")) \
            else hashlib.sha1(rid.encode()).hexdigest()

    def _rec(self, k: str, rid: str) -> Path:
        return self.dir / k / f"{self._fname(rid)}.json"

    def _empty(self, k: str):
        return {} if k == "settings" else []

    def blank(self) -> dict:
        return {"version": 1, **{k: self._empty(k) for k in self.keys},
                "updatedAt": _now(), "updatedBy": ""}

    def _stamp_now(self):
        """Names, sizes and mtimes — a stat walk, never a read. Changes when
        anything does, including a file a sync brought in from elsewhere."""
        import hashlib
        h = hashlib.sha1()
        for root, dirs, files in os.walk(self.dir):
            dirs[:] = sorted(d for d in dirs if not d.startswith("."))
            for n in sorted(files):
                st = os.stat(os.path.join(root, n))
                h.update(f"{root}/{n}\0{st.st_size}\0{st.st_mtime_ns}\n".encode())
        return h.hexdigest()

    def _load(self, p: Path, default):
        if not p.exists():
            return default
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            # Never hand back a broken file as "empty" — that would invite a PUT
            # that wipes it. Fail loudly instead.
            raise HTTPException(500, f"{self.what} 파일을 읽을 수 없습니다: {p.name}")

    # ── one document from many files ──────────────────────────────────────
    def _assemble(self) -> dict:
        local = self._load(self.dir / "_local.json", {})
        doc = {"version": int(local.get("version") or 1),
               "updatedAt": local.get("updatedAt") or _now(),
               "updatedBy": local.get("updatedBy") or ""}
        doc.update(self._load(self.dir / "_extra.json", {}))
        for k in self.keys:
            if k == "settings":
                doc[k] = self._load(self.dir / "settings.json", {})
                continue
            col = self.dir / k
            recs = {}
            if col.is_dir():
                for f in col.glob("*.json"):
                    if f.name == "_order.json":
                        continue
                    r = self._load(f, None)
                    if isinstance(r, dict) and r.get("id") is not None:
                        recs[str(r["id"])] = r
            order = [str(x) for x in self._load(col / "_order.json", [])]
            seen = set()
            out = []
            for rid in order:
                if rid in recs and rid not in seen:
                    out.append(recs[rid]); seen.add(rid)
            # A record that arrived without a place in the order (a sync, a
            # hand-copied file) goes at the end, in a stable order.
            rest = sorted((r for rid, r in recs.items() if rid not in seen),
                          key=lambda r: (str(r.get("createdAt") or ""), str(r["id"])))
            doc[k] = out + rest
        return doc

    def read(self) -> dict:
        """Current document, creating (or splitting) it on first use. Call under
        `lock`. Cached until anything in the folder changes."""
        if not (self.dir / "_local.json").exists():
            if self.path.exists():
                self._split()
            else:
                self.dir.mkdir(parents=True, exist_ok=True)
                atomic_write(self.dir / "_local.json", self._dump({"version": 1, "rv": {}}))
        if self.links and not self._upgrading:
            self._names_to_ids()
        stamp = self._stamp_now()
        if self._cache is None or stamp != self._stamp:
            doc = self._assemble()
            if not self._upgrading and self._adopt(doc):
                stamp = self._stamp_now()
            self._cache, self._stamp = doc, stamp
        return json.loads(json.dumps(self._cache))   # a copy the caller may change

    def _adopt(self, doc: dict) -> bool:
        """Records that changed on disk without a save here — a sync brought
        them from another server — get this server's bookkeeping: a new
        version, so a client holding the old copy is behind, and a trail entry,
        so a later save can tell an edit from a stale copy. True if any did.

        ponytail: hashes every record whenever the folder changes; cache
        hashes by file mtime if a project grows past ~10k records."""
        local = self._load(self.dir / "_local.json", {})
        rv, rh, gone = local.get("rv") or {}, local.get("rh") or {}, local.get("gone") or {}
        version = int(local.get("version") or doc.get("version") or 1)
        moved = []
        for k in self.keys:
            if k == "settings":
                h = self._hash(doc.get(k) or {})
                t = (rh.get("settings") or {}).get("settings")
                if t and t[-1][1] != h:
                    moved.append(("settings", "settings", h))
                continue
            seen = set()
            for r in doc.get(k) or []:
                rid = str(r["id"]); seen.add(rid)
                h = self._hash(r)
                t = (rh.get(k) or {}).get(rid)
                if not t or t[-1][1] != h:
                    moved.append((k, rid, h))
            for rid in list((rh.get(k) or {})):
                if rid not in seen:
                    moved.append((k, rid, None))
        if not moved:
            return False
        version += 1
        for k, rid, h in moved:
            if h is None:
                gone.setdefault(k, {})[rid] = [version, rh[k][rid][-1][1]]
                rh[k].pop(rid, None)
                (rv.get(k) or {}).pop(rid, None)
            else:
                rv.setdefault(k, {})[rid] = version
                t = rh.setdefault(k, {}).setdefault(rid, [])
                t.append([version, h]); del t[:-32]
                (gone.get(k) or {}).pop(rid, None)
        atomic_write(self.dir / "_local.json", self._dump(
            {**local, "version": version, "updatedAt": _now(), "updatedBy": "sync",
             "rv": rv, "rh": rh, "gone": gone}))
        doc.update(version=version, updatedBy="sync")
        return True

    # ── names → ids, once ─────────────────────────────────────────────────
    def to_ids(self, doc: dict) -> bool:
        """Point by id wherever a value names a class record. A name nobody's
        record has stays text (a journal not in the list yet). True if any
        value changed."""
        hit = False
        for item_k, path, cls_k in self.links:
            recs = [r for r in doc.get(cls_k) or [] if isinstance(r, dict) and r.get("id")]
            ids = {str(r["id"]) for r in recs}
            by_name = {}
            for r in recs:
                by_name.setdefault(str(r.get("name") or "").strip(), str(r["id"]))
            by_name.pop("", None)

            def conv(v):
                nonlocal hit
                if isinstance(v, str) and v not in ids and v.strip() in by_name:
                    hit = True
                    return by_name[v.strip()]
                return v
            field, _, sub = path.partition(".")

            def item(it):
                if not isinstance(it, dict) or field not in it:
                    return it
                v = it[field]
                if sub:
                    v = [{**x, sub: conv(x.get(sub))} if isinstance(x, dict) and sub in x else x
                         for x in v] if isinstance(v, list) else v
                else:
                    v = [conv(x) for x in v] if isinstance(v, list) else conv(v)
                # A new dict, never the one passed in: `doc` may share records
                # with the copy a save is compared against.
                return {**it, field: v} if v != it[field] else it
            if isinstance(doc.get(item_k), list):
                doc[item_k] = [item(it) for it in doc[item_k]]
        return hit

    def _names_to_ids(self) -> None:
        if self._ids_done:
            return
        local = self._load(self.dir / "_local.json", {})
        if "ids" in (local.get("upgrades") or []):
            self._ids_done = True
            return
        self._upgrading = True
        try:
            doc = self._assemble()
            if self.to_ids(doc):
                self.write(doc, "id-upgrade")
            local = self._load(self.dir / "_local.json", {})
            local["upgrades"] = sorted(set(local.get("upgrades") or []) | {"ids"})
            atomic_write(self.dir / "_local.json", self._dump(local))
            self._cache = None
        finally:
            self._upgrading = False

    # ── data.json → files, once ───────────────────────────────────────────
    def _split(self) -> None:
        import uuid
        try:
            old = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            raise HTTPException(500, f"{self.what} 파일을 읽을 수 없습니다.")
        want = json.loads(json.dumps(old))
        # Every record needs a name of its own on disk. Most have an id; a class
        # keyed by its name (a journal, an affiliation) or a list that never had
        # one (assets) gets one now — an extra field nothing reads yet.
        for k in self.keys:
            if k != "settings":
                for r in want.get(k) or []:
                    if isinstance(r, dict) and not r.get("id"):
                        r["id"] = uuid.uuid4().hex
        tmp = self.dir.with_name(self.dir.name + ".splitting")
        if tmp.exists():
            shutil.rmtree(tmp)
        tmp.mkdir(parents=True)
        version = int(want.get("version") or 1)
        rv, rh = {}, {}
        extra = {key: v for key, v in want.items()
                 if key not in self.keys and key not in ("version", "updatedAt", "updatedBy")}
        if extra:
            (tmp / "_extra.json").write_text(self._dump(extra), encoding="utf-8")
        for k in self.keys:
            if k == "settings":
                (tmp / "settings.json").write_text(self._dump(want.get(k) or {}), encoding="utf-8")
                rh["settings"] = {"settings": [[version, self._hash(want.get(k) or {})]]}
                continue
            col = tmp / k
            col.mkdir()
            ids = []
            for r in want.get(k) or []:
                if not isinstance(r, dict):
                    continue
                rid = str(r["id"])
                if rid in rv.setdefault(k, {}):
                    # Two records with one id: keep both, the second renamed.
                    r = {**r, "id": uuid.uuid4().hex}
                    rid = r["id"]
                (col / f"{self._fname(rid)}.json").write_text(self._dump(r), encoding="utf-8")
                rv[k][rid] = version
                rh.setdefault(k, {})[rid] = [[version, self._hash(r)]]
                ids.append(rid)
            (col / "_order.json").write_text(self._dump(ids), encoding="utf-8")
        (tmp / "_local.json").write_text(self._dump({
            "version": version, "updatedAt": want.get("updatedAt") or _now(),
            "updatedBy": want.get("updatedBy") or "", "rv": rv, "rh": rh, "gone": {}}), encoding="utf-8")
        # The check: put it back together and compare with what we meant to
        # store. Any difference and data.json stays the truth, untouched.
        self.dir, real = tmp, self.dir
        try:
            back = self._assemble()
        finally:
            self.dir = real
        norm = lambda d: json.dumps({key: d.get(key) for key in self.keys}, sort_keys=True, ensure_ascii=False)
        if norm(back) != norm(want):
            shutil.rmtree(tmp, ignore_errors=True)
            raise HTTPException(500, f"{self.what}: 파일로 나누는 중 검사 실패 — data.json 을 그대로 둡니다.")
        os.replace(tmp, self.dir)
        os.replace(self.path, self.path.with_name(self.path.name + ".pre-split"))

    # ── writing only what changed ─────────────────────────────────────────
    def _keep_record(self, k: str, rid: str, version: int) -> None:
        if not self.keep_days:
            return
        src = self._rec(k, rid)
        if not src.exists():
            return
        try:
            dst = self.dir / ".history" / k / self._fname(rid) / f"{version}.json"
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
        except Exception:
            pass    # a full disk must not cost the user the save they just made

    # ── the bin ───────────────────────────────────────────────────────────
    def _trash_file(self, k: str, rid: str) -> Path:
        return self.dir / ".trash" / k / f"{self._fname(rid)}.json"

    def _trash(self, k: str, rec: dict, version: int, who: str) -> None:
        """A deleted record, as it was, with when and by whom."""
        if not self.trash_days:
            return
        try:
            atomic_write(self._trash_file(k, str(rec["id"])), self._dump(
                {"record": rec, "deletedAt": _now(), "by": who, "version": version}))
        except Exception:
            pass    # a full disk must not cost the user the save they just made
        self.prune_trash()

    def prune_trash(self) -> None:
        """Out of the bin for good, trash_days after going in."""
        cut = datetime.now(timezone.utc).timestamp() - self.trash_days * 86400
        for f in (self.dir / ".trash").glob("*/*.json"):
            try:
                if f.stat().st_mtime < cut:
                    f.unlink(missing_ok=True)
            except OSError:
                pass

    def _daily(self, doc: dict) -> None:
        if not self.keep_days:
            return
        try:
            stem = self.path.stem
            day = self.path.parent / "backups" / f"{stem}-{datetime.now().date().isoformat()}.json"
            if not day.exists():
                atomic_write(day, json.dumps(doc, ensure_ascii=False))
                for gone in sorted(day.parent.glob(f"{stem}-*.json"))[:-self.keep_days]:
                    gone.unlink(missing_ok=True)
            cut = datetime.now().timestamp() - self.keep_days * 86400
            for f in (self.dir / ".history").rglob("*.json") if (self.dir / ".history").exists() else []:
                if f.stat().st_mtime < cut:
                    f.unlink(missing_ok=True)
        except Exception:
            pass

    def write(self, doc: dict, who: str = "", replaces: dict = None) -> dict:
        """Store `doc`, touching only the records that differ from what is on
        disk. Call under `lock`, after `read`."""
        import uuid
        cur = replaces if replaces is not None else self.read()
        local = self._load(self.dir / "_local.json", {})
        rv = local.get("rv") or {}
        rh = local.get("rh") or {}
        gone = local.get("gone") or {}
        version = int(cur.get("version", local.get("version") or 0)) + 1

        def trail(k, rid, obj):
            # What each record looked like at each version, as hashes: how a
            # later save from a client that was behind can tell a record it
            # CHANGED from one it merely still holds an old copy of.
            t = rh.setdefault(k, {}).setdefault(rid, [])
            t.append([version, self._hash(obj)])
            del t[:-32]
        if replaces is not None:
            self._daily(replaces)
        for k in self.keys:
            if k not in doc:
                continue
            if k == "settings":
                if doc[k] != cur.get(k):
                    atomic_write(self.dir / "settings.json", self._dump(doc[k] or {}))
                    rv.setdefault("settings", {})["settings"] = version
                    trail("settings", "settings", doc[k] or {})
                continue
            old = {str(r["id"]): r for r in cur.get(k) or [] if isinstance(r, dict) and r.get("id") is not None}
            ids = []
            for r in doc[k]:
                if not isinstance(r, dict):
                    continue
                if not r.get("id"):
                    r["id"] = uuid.uuid4().hex          # a record made since the last read
                rid = str(r["id"])
                if rid in ids:
                    continue
                ids.append(rid)
                if old.get(rid) != r:
                    self._keep_record(k, rid, version)
                    atomic_write(self._rec(k, rid), self._dump(r))
                    rv.setdefault(k, {})[rid] = version
                    trail(k, rid, r)
                    (gone.get(k) or {}).pop(rid, None)
                    if rid not in old:
                        self._trash_file(k, rid).unlink(missing_ok=True)   # back: out of the bin
            for rid in old:
                if rid not in ids:
                    self._keep_record(k, rid, version)
                    self._trash(k, old[rid], version, who)
                    self._rec(k, rid).unlink(missing_ok=True)
                    rv.setdefault(k, {}).pop(rid, None)
                    # A tombstone: when it went, and what it was — so a client
                    # still holding the old copy does not bring it back.
                    gone.setdefault(k, {})[rid] = [version, self._hash(old[rid])]
                    (rh.get(k) or {}).pop(rid, None)
            if len(gone.get(k) or {}) > 5000:          # bounded: oldest first
                g = gone[k]
                for rid in sorted(g, key=lambda x: g[x][0])[:len(g) - 5000]:
                    g.pop(rid)
            if ids != [str(r["id"]) for r in cur.get(k) or [] if isinstance(r, dict) and r.get("id") is not None]:
                atomic_write(self.dir / k / "_order.json", self._dump(ids))
        # Last: the version. A crash before this leaves the records written and
        # the version unbumped, which the next save simply moves past.
        atomic_write(self.dir / "_local.json", self._dump(
            {**local, "version": version, "updatedAt": _now(), "updatedBy": who,
             "rv": rv, "rh": rh, "gone": gone}))
        self._cache = None
        return self.read()

    # ── a save from a client that may be behind ───────────────────────────
    def merge(self, body: dict, cur: dict) -> tuple:
        """What a PUT should store, given the version the client edited from.

        A record the client changed is taken if nobody else changed it since
        that version; a record the client did not touch keeps whatever it is
        now; a record someone else made or changed meanwhile is never deleted
        by a client that had not seen it. Only the same record changed on both
        sides is a conflict. Returns (document to store, [conflicts])."""
        base = int(body.get("baseVersion") or 0)
        local = self._load(self.dir / "_local.json", {})
        rv, rh, gone = local.get("rv") or {}, local.get("rh") or {}, local.get("gone") or {}
        out = dict(cur)
        clash = []

        def untouched(k, rid, r):
            # The client's copy is what this record was when the client
            # loaded it: it was not edited there, only left behind.
            return self._hash(r) == self._at((rh.get(k) or {}).get(rid), base)
        for k in self.keys:
            val = body.get(k)
            if val is None:
                continue
            if not isinstance(val, dict if k == "settings" else list):
                raise HTTPException(422, f"'{k}' 형식이 맞지 않습니다.")
            if k == "settings":
                if val != cur.get(k):
                    if int((rv.get("settings") or {}).get("settings") or 0) <= base:
                        out[k] = val
                    elif not untouched("settings", "settings", val):
                        clash.append({"key": k})
                continue
            now = {str(r["id"]): r for r in cur.get(k) or [] if isinstance(r, dict) and r.get("id") is not None}
            krv = rv.get(k) or {}
            merged, sent = [], set()
            for r in val:
                if not isinstance(r, dict):
                    continue
                rid = str(r.get("id") or "")
                if not rid or rid not in now:
                    tomb = (gone.get(k) or {}).get(rid)
                    if tomb and int(tomb[0]) > base and self._hash(r) == tomb[1]:
                        continue                          # deleted meanwhile; this is the old copy
                    merged.append(r)                      # new on the client (or edited back to life)
                    continue
                sent.add(rid)
                if r == now[rid]:
                    merged.append(now[rid])               # the same
                elif int(krv.get(rid) or 0) <= base:
                    merged.append(r)                      # changed by this client only
                elif untouched(k, rid, r):
                    merged.append(now[rid])               # changed meanwhile; client just behind
                else:
                    clash.append({"key": k, "id": rid})   # changed on both sides
                    merged.append(now[rid])
            for rid, r in now.items():
                if rid not in sent and int(krv.get(rid) or 0) > base:
                    merged.append(r)                      # made/changed meanwhile: keep
            out[k] = merged
        return out, clash

    def mount(self, app: FastAPI, project: str = "") -> None:
        """GET/PUT /api/data, GET /api/data/version, GET /api/whoami."""
        doc_ = self

        @app.get("/api/data")
        def get_data(_: dict = Depends(signed_in)) -> dict:
            with doc_.lock:
                return doc_.read()

        @app.put("/api/data")
        def put_data(body: dict = Body(...), me: dict = Depends(signed_in)):
            with doc_.lock:
                cur = doc_.read()
                _guard_roots(body, cur, me)
                new, clash = doc_.merge(body, cur)
                # A name typed that is a record's (or a client from before
                # ids) is stored as that record's id.
                doc_.to_ids(new)
                if clash:
                    # The same record changed here since this client loaded it.
                    # Hand back the current document so it reloads rather than
                    # overwrites — but only for a real clash now, not for any
                    # save that happened to land in between.
                    return JSONResponse(status_code=409, content={
                        "detail": "다른 사용자가 같은 항목을 먼저 고쳤습니다. 최신 데이터를 불러옵니다.",
                        "current": cur, "conflicts": clash,
                    })
                return doc_.write(new, me.get("email") or me.get("username") or "", replaces=cur)

        @app.get("/api/trash")
        def get_trash(_: dict = Depends(signed_in)) -> list:
            """What was deleted in the last trash_days, newest first."""
            doc_.prune_trash()
            out = []
            for f in (doc_.dir / ".trash").glob("*/*.json"):
                try:
                    out.append({"key": f.parent.name, **json.loads(f.read_text(encoding="utf-8"))})
                except Exception:
                    continue
            return sorted(out, key=lambda t: t.get("deletedAt") or "", reverse=True)

        @app.post("/api/trash/restore")
        def restore(body: dict = Body(...), me: dict = Depends(signed_in)):
            """A record back from the bin, at the top of its list; the
            document after."""
            k, rid = str(body.get("key") or ""), str(body.get("id") or "")
            if k not in doc_.keys or k == "settings":
                raise HTTPException(400, "되살릴 수 없는 종류입니다.")
            f = doc_._trash_file(k, rid)
            if not f.exists():
                raise HTTPException(404, "휴지통에 없습니다.")
            rec = json.loads(f.read_text(encoding="utf-8"))["record"]
            with doc_.lock:
                cur = doc_.read()
                if any(str(r.get("id")) == rid for r in cur.get(k) or []):
                    f.unlink(missing_ok=True)        # already back (restored, or synced)
                    return cur
                return doc_.write({**cur, k: [rec] + list(cur.get(k) or [])},
                                  me.get("email") or me.get("username") or "", replaces=cur)

        @app.get("/api/data/version")
        def get_version(_: dict = Depends(signed_in)) -> dict:
            # Cheap poll target: ask for the version, fetch the document only
            # when it moved.
            with doc_.lock:
                return {"version": doc_.read()["version"]}

        @app.get("/api/whoami")
        def whoami(me: dict = Depends(identity)) -> dict:
            return {**me, "project": project}


def _desktop(path: str, how: str) -> list:
    """The desktop's own way to open a folder or file ('open'), or to show a
    file where it lives ('reveal'). Linux has no portable 'select this file',
    so revealing there opens the folder it is in."""
    if sys.platform == "darwin":
        return ["open", "-R", path] if how == "reveal" else ["open", path]
    if os.name == "nt":
        return ["explorer", f"/select,{path}"] if how == "reveal" else ["explorer", path]
    if how == "reveal" and shutil.which("dbus-send"):
        # The file manager's own 'select this file', where the desktop answers it.
        return ["dbus-send", "--session", "--print-reply",
                "--dest=org.freedesktop.FileManager1", "--type=method_call",
                "/org/freedesktop/FileManager1", "org.freedesktop.FileManager1.ShowItems",
                f"array:string:file://{quote(path)}", 'string:""']
    target = str(Path(path).parent) if how == "reveal" else path
    return ["xdg-open", target]


# Settings that name folders on the host the service will serve files from.
# They are part of the document, so a save could point one at "/" — only a
# manager may change them, and none may reach the portal's own data (its
# signing key lives there).
_ROOT_SETTINGS: set = set()


def _guard_roots(body: dict, cur: dict, me: dict) -> None:
    new_s = body.get("settings") if isinstance(body.get("settings"), dict) else {}
    cur_s = cur.get("settings") or {}
    if is_manager(me):
        return
    for k in _ROOT_SETTINGS:
        if k in new_s and new_s.get(k) != cur_s.get(k):
            raise HTTPException(403, "폴더 위치는 관리자만 바꿀 수 있습니다.")


def _portal_private() -> Path:
    return (Path(os.environ.get("PORTAL_DATA_ROOT", "/app/data")) / "_portal").resolve()


def _safe_roots(got: list) -> list:
    """Resolved roots, minus any that would expose the portal's private folder."""
    private = _portal_private()
    out = []
    for r in got or []:
        try:
            p = Path(str(r)).expanduser().resolve()
        except Exception:
            continue
        if p == private or p in private.parents or private in p.parents:
            continue
        out.append(p)
    return out


def mount_folders(app: FastAPI, doc: Document, setting: str = "folderRoots") -> None:
    """A folder per record, found by its name, and the files in it.

        GET  /api/folders                     the folders directly under the roots
        GET  /api/folders/list?name=          the files in one (recursive)
        GET  /api/folders/file?name=&path=    one file, inline (download=1: as a file)
        POST /api/folders/open {name, path?, how}  open it / show it on the desktop
        POST /api/folders/make {name}         make the folder where its kind lives
        POST /api/folders/adopt {source, name}  rename a folder under a root to be the record's

    The naming convention IS the link — a record named Academic_20131207_HIM2013
    has the folder of that name under a root in settings[setting] — so nothing
    is stored per record. Names are NFC: macOS hands Korean names back
    decomposed. A folder is addressed by a NAME from the listing, never a path,
    and a file by a path checked (symlinks resolved) to stay inside its folder,
    so nothing outside the roots is reachable. Opening on the desktop happens on
    the machine the backend runs on — useful only when that is the one you are
    looking at."""

    _ROOT_SETTINGS.add(setting)

    def roots() -> list:
        with doc.lock:
            return _safe_roots((doc.read().get("settings") or {}).get(setting))

    def found() -> dict:
        out = {}
        for r in roots():
            try:
                for e in os.scandir(r):
                    if e.is_dir() and not e.name.startswith("."):
                        out.setdefault(unicodedata.normalize("NFC", e.name), e.path)
            except OSError:
                pass
        return out

    def folder(name: str) -> Path:
        p = found().get(unicodedata.normalize("NFC", str(name or "")))
        if not p:
            raise HTTPException(404, "그 이름의 폴더가 없습니다.")
        return Path(p).resolve()

    def inside(name: str, rel: str) -> Path:
        base = folder(name)
        real = (base / str(rel or "")).resolve()
        if real != base and base not in real.parents:
            raise HTTPException(404, "폴더 밖의 경로입니다.")
        if not real.exists():
            raise HTTPException(404, "그 파일이 없습니다.")
        return real

    @app.get("/api/folders")
    def folders(_: dict = Depends(signed_in)) -> dict:
        return {"roots": [str(r) for r in roots()], "dirs": found()}

    @app.get("/api/folders/list")
    def list_files(name: str, _: dict = Depends(signed_in)) -> dict:
        base = folder(name)
        files = []
        for dirpath, dirs, names in os.walk(base):
            dirs[:] = sorted(d for d in dirs if not d.startswith("."))
            for n in sorted(names):
                if n.startswith("."):
                    continue
                full = Path(dirpath) / n
                try:
                    st = full.stat()
                except OSError:
                    continue
                files.append({"path": unicodedata.normalize("NFC", str(full.relative_to(base))),
                              "size": st.st_size, "mtime": int(st.st_mtime)})
                if len(files) >= 2000:     # ponytail: a cap, not paging; page if a folder ever holds more
                    return {"path": str(base), "files": files, "more": True}
        return {"path": str(base), "files": files}

    @app.get("/api/folders/file")
    def get_file(name: str, path: str, download: int = 0, _: dict = Depends(signed_in)):
        real = inside(name, path)
        if not real.is_file():
            raise HTTPException(404, "파일이 아닙니다.")
        return FileResponse(real, filename=real.name,
                            content_disposition_type="attachment" if download else "inline")

    @app.post("/api/folders/open")
    def open_on_desktop(body: dict = Body(...), _: dict = Depends(manager)):
        real = inside(body.get("name"), body.get("path") or "")
        how = "reveal" if body.get("how") == "reveal" else "open"
        try:
            subprocess.Popen(_desktop(str(real), how), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception as exc:
            raise HTTPException(501, f"열 수 없습니다: {exc}")
        return {"ok": True, "path": str(real)}

    def clean(raw) -> str:
        name = unicodedata.normalize("NFC", str(raw or "").strip())
        if not name or name.startswith(".") or "/" in name or "\\" in name or len(name) > 200:
            raise HTTPException(422, "폴더 이름으로 쓸 수 없습니다.")
        return name

    @app.post("/api/folders/make")
    def make(body: dict = Body(...), _: dict = Depends(signed_in)):
        name = clean(body.get("name"))
        rs = roots()
        if not rs:
            raise HTTPException(409, "폴더 루트가 정해지지 않았습니다.")
        dirs = found()
        if name in dirs:
            raise HTTPException(409, "이미 있습니다.")
        p = Path(home_for(name, rs, dirs)) / name
        p.mkdir()
        return {"ok": True, "path": str(p)}

    def home_for(name: str, rs: list, dirs: dict) -> str:
        """Where a new folder goes: the root that already holds the most folders
        of its kind — the part of the name before the first '_' (Proposal_…
        beside the other proposals) — or the first root."""
        kind = name.split("_", 1)[0] + "_"
        count: dict = {}
        for n, path in dirs.items():
            if n.startswith(kind):
                parent = str(Path(path).parent)
                count[parent] = count.get(parent, 0) + 1
        return max(count, key=count.get) if count else str(Path(rs[0]).expanduser())

    @app.post("/api/folders/adopt")
    def adopt(body: dict = Body(...), _: dict = Depends(signed_in)):
        """Make an existing folder this record's: rename it to the record's name
        (and lift it to the top of its root when it was deeper). `source` is a
        folder name from the listing or a path dropped from Finder; either way
        it must already be under a root — nothing is pulled in from outside."""
        name = clean(body.get("name"))
        src = str(body.get("source") or "").strip()
        listed = found().get(unicodedata.normalize("NFC", src))
        if not listed and "/" not in src:
            # A browser hands a page the NAME of a folder dropped from Finder,
            # never its path: look for it under the roots.
            hits = search(src)
            if len(hits) > 1:
                raise HTTPException(409, f"'{src}' 폴더가 루트 안에 {len(hits)}개 있습니다 — 목록에서 고르세요.")
            listed = hits[0] if hits else None
            if not listed:
                raise HTTPException(404, f"루트 안에서 '{src}' 폴더를 찾지 못했습니다 — 루트 밖의 폴더는 먼저 루트 안으로 옮기세요.")
        real = Path(listed or src).expanduser().resolve()
        root = next((r for r in (Path(x).expanduser().resolve() for x in roots())
                     if root_has(r, real)), None)
        if not root or not real.is_dir():
            raise HTTPException(404, "루트 안의 폴더가 아닙니다 — 루트 안으로 옮기거나 settings에서 루트를 바꾸세요.")
        if name in found():
            raise HTTPException(409, "그 이름의 폴더가 이미 있습니다.")
        dest = root / name
        real.rename(dest)
        return {"ok": True, "from": str(real), "path": str(dest)}

    def search(name: str, depth: int = 4) -> list:
        """Folders called `name` anywhere under the roots, a few levels down."""
        want = unicodedata.normalize("NFC", name)
        out = []
        for r in roots():
            base = Path(r).expanduser()
            for dirpath, dirs, _ in os.walk(base):
                level = len(Path(dirpath).relative_to(base).parts)
                dirs[:] = [d for d in dirs if not d.startswith(".")] if level < depth else []
                out += [os.path.join(dirpath, d) for d in dirs if unicodedata.normalize("NFC", d) == want]
        return out

    def root_has(root: Path, p: Path) -> bool:
        return p != root and root in p.parents


def mount_files(app: FastAPI, doc: Document, setting: str = "fileRoots", exts: tuple = (".pdf",)) -> None:
    """One file per record, under the roots in settings[setting].

        GET  /api/file?path=[&download=1]   the file, inline (or as a download)
        GET  /api/realpath?path=            where it actually is
        POST /api/reveal {path}             show it in the desktop's file manager
        GET  /api/scan                      every file with one of `exts`, by name

    A record stores a path relative to a root (or absolute and under one). Only
    files under the roots are served, and only after the path is resolved — a
    symlink out of a root is out of the root. The scan is what lets a naming
    convention be the link: a file named after a record's key is that record's.
    (These were reference_manager's own routes; the paths are unchanged.)"""

    _ROOT_SETTINGS.add(setting)

    def roots() -> list:
        with doc.lock:
            return _safe_roots((doc.read().get("settings") or {}).get(setting))

    def inside(path: Path, rs: list):
        try:
            for root in rs:
                cand = (path if path.is_absolute() else root / path).resolve()
                if cand.is_file() and (cand == root or root in cand.parents):
                    return cand
        except Exception:
            return None
        return None

    def found(path: str) -> Path:
        rs = roots()
        if not rs:
            raise HTTPException(409, "허용 루트가 설정되지 않았습니다.")
        real = inside(Path(path), rs)
        if not real or not real.name.lower().endswith(tuple(e.lower() for e in exts)):
            raise HTTPException(404, "그 경로의 파일이 없거나 허용 루트 밖입니다.")
        return real

    @app.get("/api/file")
    def get_file(path: str, download: int = 0, _: dict = Depends(signed_in)):
        real = found(path)
        return FileResponse(real, filename=real.name,
                            content_disposition_type="attachment" if download else "inline")

    @app.get("/api/realpath")
    def realpath(path: str, _: dict = Depends(signed_in)) -> dict:
        real = found(path)
        return {"path": str(real), "name": real.name}

    @app.post("/api/reveal")
    def reveal(body: dict = Body(...), _: dict = Depends(manager)):
        real = found(str(body.get("path") or ""))
        where = "Finder" if sys.platform == "darwin" else "탐색기" if os.name == "nt" else "파일 관리자"
        try:
            subprocess.Popen(_desktop(str(real), "reveal"), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception as exc:
            raise HTTPException(500, f"열 수 없습니다: {exc}")
        return {"ok": True, "where": where, "path": str(real)}

    @app.get("/api/scan")
    def scan(_: dict = Depends(signed_in)) -> dict:
        out: dict = {}
        for root in roots():
            for dirpath, _dirs, names in os.walk(root):
                for n in names:
                    if n.lower().endswith(tuple(e.lower() for e in exts)):
                        rel = os.path.relpath(os.path.join(dirpath, n), root)
                        out.setdefault(unicodedata.normalize("NFC", os.path.splitext(n)[0]), []).append(rel)
        return {"roots": [str(r) for r in roots()], "files": out}


def mount_spa(app: FastAPI, dist: Path, name: str = "service") -> None:
    """Serve the built app. Must be mounted LAST: its catch-all would shadow
    every /api route registered after it."""
    dist = Path(dist)
    assets = dist / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=str(assets)), name="assets")

    @app.get("/{path:path}")
    def spa(path: str):
        candidate = (dist / path).resolve()
        if path and candidate.is_file() and candidate.is_relative_to(dist.resolve()):
            return FileResponse(candidate)
        index = dist / "index.html"
        if index.is_file():
            return FileResponse(index)
        raise HTTPException(404, f"{name} dist not built")
