"""An approval put on hold with an opinion — the third answer beside yes and no.

Any request the portal itself waits on (routers/inbox.py: a host path, an access request, an
address change, a sync or issue link) may be held: it stays in the inbox as `held`, with the
opinions said about it, the one who asked can read them, and asking again (changed) puts it
back to waiting with the thread kept. Kept apart from the requests themselves, by the id the
inbox gives each (`pid`), in data/_portal/held.json:

    {pid: {"held": bool, "comments": [{by, via, at, text}]}}
"""
import base64
import json
import threading
from datetime import datetime

from . import config, registry

_lock = threading.Lock()


def pid(*parts: str) -> str:
    """The id of one request in the portal's inbox: its kind and what names it."""
    return base64.urlsafe_b64encode("\n".join(parts).encode()).decode().rstrip("=")


def unpid(s: str) -> list:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4)).decode().split("\n")


def _file():
    return config.DATA_ROOT / "_portal" / "held.json"


def _read() -> dict:
    try:
        d = json.loads(_file().read_text("utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def get(p: str) -> dict:
    h = _read().get(p) or {}
    return {"held": bool(h.get("held")), "comments": list(h.get("comments") or [])}


def say(p: str, by: str, text: str, hold: bool = False, via: str = "") -> dict:
    """One more opinion on a request; `hold` also puts it on hold."""
    text = str(text or "").strip()[:4000]
    if not text:
        raise ValueError("의견을 적어 주세요.")
    with _lock:
        d = _read()
        h = d.setdefault(p, {"held": False, "comments": []})
        h["comments"] = (h.get("comments") or [])[-49:] + [
            {"by": str(by or "")[:120], "via": str(via or "")[:80],
             "at": datetime.now().astimezone().isoformat(timespec="seconds"), "text": text}]
        h["held"] = bool(hold or h.get("held"))
        registry._atomic_write_text(_file(), json.dumps(d, ensure_ascii=False, indent=2))
        return {"held": h["held"], "comments": h["comments"]}


def release(p: str) -> None:
    """Asked again: back to waiting, the thread kept."""
    _set(p, False)


def drop(p: str) -> None:
    """Decided (or gone): nothing to keep."""
    _set(p, None)


def _set(p: str, held) -> None:
    with _lock:
        d = _read()
        if p not in d:
            return
        if held is None:
            d.pop(p)
        else:
            d[p]["held"] = held
        registry._atomic_write_text(_file(), json.dumps(d, ensure_ascii=False, indent=2))
