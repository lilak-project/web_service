"""Who may send candidates to the inbox through an MCP token — registered first.

A token that proposes (notes, activities, tags, jobs…) says who it is before it may: a name,
what it sends, and when it reads an answer (a hold's opinion). The application waits in the
portal's inbox (routers/inbox.py, kind `sender`) for a manager's yes, no, or hold with an
opinion; a manager can also register, change or drop one directly. People, services, other
portals and the portal's own tidy are not registered: only tokens.

data/_portal/senders.json:  {"senders": {"<token id>": {token_id, token, name, kinds, reads,
                             reads_at, status: waiting|approved|rejected, by, at}}}
"""
import json
import threading
import time

from . import config, held, registry

KINDS = ("note", "activity", "tags", "job", "note_delete", "record_delete")
READS = ("schedule", "session", "never")      # at set times / only while its session runs / never
_lock = threading.Lock()


def _file():
    return config.DATA_ROOT / "_portal" / "senders.json"


def _read() -> dict:
    try:
        d = json.loads(_file().read_text("utf-8"))
        if isinstance(d, dict) and isinstance(d.get("senders"), dict):
            return d
    except (OSError, ValueError):
        pass
    return {"senders": {}}


def _write(d: dict) -> None:
    registry._atomic_write_text(_file(), json.dumps(d, ensure_ascii=False, indent=2))


def pid(token_id) -> str:
    return held.pid("sender", str(token_id))


def _clean(token_id, token_name, by, name, kinds, reads, reads_at) -> dict:
    name = " ".join(str(name or "").split())[:60]
    kinds = [k for k in dict.fromkeys(str(x).strip() for x in (kinds or [])) if k]
    if not name:
        raise ValueError("보내는 곳의 이름(name)을 적어 주세요.")
    if not kinds or any(k not in KINDS for k in kinds):
        raise ValueError(f"보내는 종류(kinds)는 다음 가운데서 고릅니다: {', '.join(KINDS)}")
    if reads not in READS:
        raise ValueError(f"답을 읽는 때(reads)는 다음 가운데 하나입니다: {', '.join(READS)}")
    return {"token_id": int(token_id), "token": str(token_name or "")[:64], "name": name, "kinds": kinds, "reads": reads,
            "reads_at": " ".join(str(reads_at or "").split())[:80] if reads == "schedule" else "",
            "by": str(by or "")[:120], "at": time.time()}


def rows() -> list:
    return sorted(_read()["senders"].values(), key=lambda r: (r.get("status") != "waiting", r.get("name") or ""))


def info(token_id) -> dict:
    """{status, comments, row} of one token's registration; status None when it never applied."""
    row = _read()["senders"].get(str(token_id))
    if not row:
        return {"status": None, "comments": [], "row": None}
    h = held.get(pid(token_id))
    return {"status": "held" if row["status"] == "waiting" and h["held"] else row["status"], "comments": h["comments"], "row": row}


def allowed(token_id) -> bool:
    return info(token_id)["status"] == "approved"


def apply(token_id, token_name, by, name, kinds, reads, reads_at="") -> dict:
    """The token asks to be a sender (or asks again, changed): it waits for a manager. One already
    approved that asks with the same words stays approved."""
    new = _clean(token_id, token_name, by, name, kinds, reads, reads_at)
    with _lock:
        d = _read()
        old = d["senders"].get(str(token_id)) or {}
        same = all(old.get(k) == new[k] for k in ("name", "kinds", "reads", "reads_at"))
        new["status"] = "approved" if old.get("status") == "approved" and same else "waiting"
        d["senders"][str(token_id)] = new
        _write(d)
    if new["status"] == "waiting":
        held.release(pid(token_id))             # asked again after an opinion: it waits again, the thread kept
    return info(token_id)


def register(token_id, token_name, by, name, kinds, reads, reads_at="") -> dict:
    """Registered outright (a manager's own word, or the tasks that were sending before this existed)."""
    new = {**_clean(token_id, token_name, by, name, kinds, reads, reads_at), "status": "approved"}
    with _lock:
        d = _read()
        d["senders"][str(token_id)] = new
        _write(d)
    held.drop(pid(token_id))
    return new


def decide(token_id, yes: bool) -> None:
    with _lock:
        d = _read()
        row = d["senders"].get(str(token_id))
        if not row:
            raise KeyError(token_id)
        row["status"] = "approved" if yes else "rejected"
        _write(d)
    held.drop(pid(token_id))


def drop(token_id) -> None:
    with _lock:
        d = _read()
        d["senders"].pop(str(token_id), None)
        _write(d)
    held.drop(pid(token_id))


def by_token_name() -> dict:
    """{token name: {name, reads, reads_at}} of the approved ones — what a candidate's card shows of its sender."""
    return {r["token"]: {k: r[k] for k in ("name", "reads", "reads_at")} for r in rows() if r["status"] == "approved"}
