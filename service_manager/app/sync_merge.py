"""
Two-way sync, the deciding part: given what a file was when the two servers
last agreed (base), what it is here (mine) and there (theirs), what should both
sides hold now. No I/O — routers/sync.py moves the bytes.

It works because the services that sync both ways keep one record per file
(rack services: data/<key>/<id>.json; note: one .md per note). Two people
editing different records touch different files and never meet here. Only the
same file changed on both sides is merged:

  *.json          field by field against the base; a field changed on both
                  sides goes to the newer record (updatedAt), else to main
  _order.json     the two orders, each side's additions kept, deletions applied
  anything else   both kept: main's at the name, ours beside it as a copy
                  "name (충돌 2026-10-15).md" — a note is never half-merged
"""
from __future__ import annotations

import json
from datetime import date
from pathlib import PurePosixPath

# What never leaves a server: its own bookkeeping, history and backups.
_LOCAL_TOP = ("backups/",)


def local_only(rel: str) -> bool:
    parts = PurePosixPath(rel).parts
    if any(p.startswith(".") for p in parts):          # .history, .port, .sync-*
        return True
    if rel == "data/_local.json" or rel.startswith(_LOCAL_TOP):
        return True
    top = parts[0] if parts else ""
    # The single-file era: data.json and its side copies stay where they are.
    if len(parts) == 1 and (top.startswith("data.json") or top == "data.prev.json"):
        return True
    return rel.endswith((".sync-tmp", "service.log"))


def keeps_base(rel: str) -> bool:
    """Files a later merge needs the agreed copy of."""
    return rel.endswith(".json")


_GONE = object()


def _dumps(obj) -> bytes:
    # The bytes the rack store writes, so a merged record reads as unchanged there.
    return (json.dumps(obj, ensure_ascii=False, sort_keys=True, indent=1) + "\n").encode()


def _merge_order(b, m, t) -> list:
    b = set(b or [])
    keep = lambda x: not (x in b and (x not in m or x not in t))   # deleted on a side
    out = [x for x in m if keep(x)]
    out += [x for x in t if x not in out and x not in m and keep(x)]
    return out


def _merge_dict(b, m, t, mine_newer: bool) -> dict:
    out = {}
    for k in list(m) + [k for k in t if k not in m]:
        bv, mv, tv = b.get(k, _GONE), m.get(k, _GONE), t.get(k, _GONE)
        if mv == tv:
            v = mv
        elif mv == bv:
            v = tv
        elif tv == bv:
            v = mv
        else:
            v = mv if mine_newer else tv
        if v is not _GONE:
            out[k] = v
    return out


def merge_json(rel: str, base: bytes | None, mine: bytes, theirs: bytes) -> bytes | None:
    """The merged file, or None when either side is not JSON we understand."""
    try:
        m, t = json.loads(mine), json.loads(theirs)
        b = json.loads(base) if base else None
    except ValueError:
        return None
    if rel.endswith("_order.json") and isinstance(m, list) and isinstance(t, list):
        return _dumps(_merge_order(b if isinstance(b, list) else [], m, t))
    if isinstance(m, dict) and isinstance(t, dict):
        newer = str(m.get("updatedAt") or "") > str(t.get("updatedAt") or "")
        return _dumps(_merge_dict(b if isinstance(b, dict) else {}, m, t, newer))
    return None


def conflict_name(rel: str, taken) -> str:
    p = PurePosixPath(rel)
    stem = f"{p.stem} (충돌 {date.today().isoformat()})"
    name, n = f"{stem}{p.suffix}", 2
    while str(p.with_name(name)) in taken:
        name, n = f"{stem} {n}{p.suffix}", n + 1
    return str(p.with_name(name))


def plan(base: dict, mine: dict, theirs: dict) -> list:
    """[(rel, action)] for every file that is not already the same on both
    sides. Manifests are {rel: sha}; action is one of
      pull · push · del_mine · del_theirs · merge"""
    out = []
    for rel in sorted(set(mine) | set(theirs)):
        if local_only(rel):
            continue
        b, m, t = base.get(rel), mine.get(rel), theirs.get(rel)
        if m == t:
            continue
        if m == b:
            out.append((rel, "pull" if t else "del_mine"))
        elif t == b:
            out.append((rel, "push" if m else "del_theirs"))
        elif m is None:
            out.append((rel, "pull"))         # deleted here, changed there: keep it
        elif t is None:
            out.append((rel, "push"))         # …and the other way round
        else:
            out.append((rel, "merge"))
    return out


if __name__ == "__main__":
    # The decisions.
    B = {"a": "1", "b": "1", "c": "1", "d": "1", "e": "1", "f": "1"}
    M = {"a": "1", "b": "2", "c": "1", "e": "2", "f": "2", "n": "x"}
    T = {"a": "1", "b": "1", "c": "2", "d": "1", "f": "3", "data/_local.json": "z"}
    assert dict(plan(B, M, T)) == {"b": "push", "c": "pull", "d": "del_theirs", "e": "push",
                                   "f": "merge", "n": "push"}, plan(B, M, T)
    assert dict(plan({"x": "1"}, {}, {"x": "1"})) == {"x": "del_theirs"}
    assert dict(plan({"x": "1"}, {"x": "1"}, {})) == {"x": "del_mine"}
    # Two fields of one record, one per side → both; the same field → the newer.
    base = _dumps({"id": "r", "a": 1, "b": 1, "c": 1, "updatedAt": "1"})
    mine = _dumps({"id": "r", "a": 2, "b": 1, "c": 5, "updatedAt": "3"})
    theirs = _dumps({"id": "r", "a": 1, "b": 2, "c": 6, "updatedAt": "2"})
    got = json.loads(merge_json("data/x/r.json", base, mine, theirs))
    assert got == {"id": "r", "a": 2, "b": 2, "c": 5, "updatedAt": "3"}, got
    # A field deleted on one side, untouched on the other, goes.
    got = json.loads(merge_json("s.json", _dumps({"k": 1, "j": 1}), _dumps({"j": 1}), _dumps({"k": 1, "j": 2})))
    assert got == {"j": 2}, got
    # Orders: additions from both, a deletion from either.
    got = json.loads(merge_json("data/x/_order.json", _dumps(["a", "b", "c"]),
                                _dumps(["a", "c", "m"]), _dumps(["t", "a", "b", "c"])))
    assert got == ["a", "c", "m", "t"], got
    assert local_only("data/.history/x/1.json") and local_only("data.json.pre-split")
    assert local_only("backups/data-2026.json") and not local_only("notes/a.md")
    assert not local_only("data/authors/x.json") and not local_only("uploads/a.pdf")
    assert conflict_name("notes/a.md", set()).startswith("notes/a (충돌 ")
    print("sync_merge ok")
