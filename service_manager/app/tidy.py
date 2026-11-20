"""Tidying the portal does on its own (Feedback #9, then "both portals, every service"): twice a day,
empty things are put to the owner as inbox candidates. Nothing is deleted here: approving one in the
inbox deletes it (a note to the rack bin, 30 days; a record the way the service deletes, its bin too).

- notes: no title (or "Untitled") or no body (tag lines only) — judged by title and body, never by id
  (an id keeps "Untitled" after the note is named). target note_delete.
- rack records (every rack service of each share set): a record none of whose name fields holds a value,
  in a list where other records do use them. A manifest may say otherwise with capabilities.tidy:
  false (leave the service alone) or {list: [field, ...]}. target record_delete.

Both the Mac and the server portal run it. A candidate's id comes from what it is about (tidy-<hash>),
so the two portals write the same record and the inbox sync holds one; asked once, a no is not asked
again. Each portal sweeps at its own minute past HOURS (from its host name), so they seldom meet.
PORTAL_TIDY_NOTES=0 turns the timer off; POST /api/admin/tidy/empty-notes runs it now (dry_run to look).
"""
import asyncio
import hashlib
import json
import logging
import os
import re
import socket
from datetime import date, datetime, timezone
from urllib.parse import quote

import httpx

from . import config, models, registry
from .db import SessionLocal
from .deps import portal_token

log = logging.getLogger("tidy")
HOURS = (9, 21)                       # local time, the two sweeps of a day
MINUTE = int(hashlib.sha1(socket.gethostname().encode()).hexdigest(), 16) % 50   # this portal's own minute
UNTITLED = re.compile(r"^(untitled|제목\s*없음)(\s*[-_ ]?\d+)?$", re.I)
TAG_LINE = re.compile(r"^(\s*[#+][^\s#+]+)+\s*$")   # `#report +STARK`: tags only, no words
FRESH = 3600                          # seconds: what was saved this recently may still be being written
NAME_FIELDS = ("name", "title", "fullName", "shortName", "bibName", "citeKey",
               "korFamily", "korGiven", "engFirst", "engLast", "nick", "abvName")
SKIP_LISTS = ("settings", "inbox", "prefs", "pins", "approval", "proposals")
SKIP_SERVICES = ("jobboard",)         # its jobs are jobrun's, rewritten every 30 s


def empty_reason(title: str, body: str) -> str:
    """Why a note looks empty, or "" when it does not."""
    words = [ln for ln in (body or "").splitlines() if ln.strip() and not TAG_LINE.match(ln)]
    t = (title or "").strip()
    no_title = not t or bool(UNTITLED.match(t))
    if no_title and not words:
        return "제목도 본문도 없음"
    if not words:
        return "본문 없음"
    return "제목 없음(Untitled)" if no_title else ""


def empty_records(doc: dict, rule=None) -> list:
    """(list key, record) of the records with no name. rule: {list: [fields]} from the manifest, else
    NAME_FIELDS where the list's other records use them."""
    out = []
    for k, rows in doc.items():
        if k in SKIP_LISTS or not isinstance(rows, list):
            continue
        rows = [r for r in rows if isinstance(r, dict) and r.get("id") is not None]
        fields = (rule or {}).get(k) if rule else [f for f in NAME_FIELDS if any(str(r.get(f) or "").strip() for r in rows)]
        if not fields:
            continue
        out += [(k, r) for r in rows if not any(str(r.get(f) or "").strip() for f in fields)]
    return out


def cand_id(*about) -> str:
    return "tidy-" + hashlib.sha1("/".join(map(str, about)).encode()).hexdigest()[:16]


# Every candidate id this portal has seen, kept past the inbox's own memory (it drops a discarded one
# after 10 days), so a no stays a no. ponytail: grows by one line per empty thing ever found; prune if huge.
ASKED = config.DATA_ROOT / "_portal" / "tidy_asked.json"


def _asked() -> set:
    try:
        return set(json.loads(ASKED.read_text()))
    except (OSError, ValueError):
        return set()


def _remember(ids: set) -> None:
    ASKED.parent.mkdir(parents=True, exist_ok=True)
    tmp = ASKED.with_suffix(".tmp")
    tmp.write_text(json.dumps(sorted(i for i in ids if str(i).startswith("tidy-"))))
    tmp.replace(ASKED)


def _admin_jwt() -> str:
    with SessionLocal() as db:
        u = db.query(models.User).filter(models.User.role == "manager", models.User.is_active.is_(True)) \
            .order_by(models.User.id).first()
        return portal_token(u) if u else ""


def _targets() -> list:
    """(service, project, inbox project, tidy rule) for each service of each share set with an inbox."""
    from .routers.mcp import _rack
    rack, out = set(_rack()), []
    for st in registry.share_sets()[0]:
        m = st.get("members") or {}
        if not m.get("inbox"):
            continue
        for svc, proj in m.items():
            if svc in SKIP_SERVICES or (svc != "note" and svc not in rack):
                continue
            rule = (registry.read_manifest(svc).get("capabilities") or {}).get("tidy")
            if rule is False or (svc, proj) in [(s, p) for s, p, _, _ in out]:
                continue
            out.append((svc, proj, m["inbox"], rule if isinstance(rule, dict) else None))
    return out


async def sweep(app, dry_run: bool = False) -> list:
    """The candidates left (or, dry_run, that would be): [{service, project, id, title, reason}]."""
    jwt = _admin_jwt()
    if not jwt:
        return []
    found = []
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://portal", timeout=60,
                                 headers={"Authorization": f"Bearer {jwt}", "Accept": "application/json"}) as c:
        asked_in: dict = {}
        seen = _asked()
        for svc, proj, iproj, rule in _targets():
            if iproj not in asked_in:
                i = await c.get(f"/pp/inbox/{iproj}/api/data")
                if i.status_code != 200:
                    log.warning("tidy: inbox %s not readable (%s)", iproj, i.status_code)
                    continue
                rows = i.json().get("inbox") or []
                asked_in[iproj] = {x.get("id") for x in rows} | \
                    {cand_id("note", x.get("destProj"), x.get("noteId")) for x in rows if x.get("target") == "note_delete"}
            asked_in[iproj] |= seen
            asked = asked_in[iproj]
            for rec in await (_notes(c, proj) if svc == "note" else _records(c, svc, proj, rule)):
                if rec["id"] in asked:
                    continue
                found.append({k: rec[k] for k in ("service", "project", "title", "reason")} | {"of": rec.get("noteId") or rec.get("recordId")})
                if dry_run:
                    continue
                w = await c.post(f"/pp/inbox/{iproj}/api/records", json={"key": "inbox", "record": {
                    **{k: v for k, v in rec.items() if k not in ("service", "project", "reason")},
                    "status": "waiting", "from": "포털 정리", "date": date.today().isoformat(),
                    "remark": f"{rec['reason']}. 승인하면 휴지통으로 갑니다(되살릴 수 있음)."}})
                if w.status_code >= 400:
                    log.warning("tidy: inbox %s refused (%s)", iproj, w.status_code)
                asked.add(rec["id"])
        if not dry_run:
            _remember(seen.union(*asked_in.values()) if asked_in else seen)
    return found


async def _notes(c, proj) -> list:
    r = await c.get(f"/pp/note/{proj}/api/notes")
    if r.status_code != 200:
        return []
    out = []
    for s in r.json().get("notes") or []:
        t = (s.get("title") or "").strip()
        if s.get("excerpt") and t and not UNTITLED.match(t):
            continue                                       # titled and has words: not even read
        full = await c.get(f"/pp/note/{proj}/api/notes/{quote(s['id'], safe='')}")
        if full.status_code != 200:
            continue
        n = full.json()
        why = empty_reason(n.get("title"), n.get("body"))
        if why and not _fresh(int(n.get("version") or 0) / 1e9):
            out.append({"id": cand_id("note", proj, n["id"]), "target": "note_delete", "service": "note",
                        "project": proj, "reason": why, "title": n.get("title") or "", "noteId": n["id"],
                        "destProj": proj, "excerpt": n.get("body") or ""})   # whole: deleted only if still this
    return out


async def _records(c, svc, proj, rule) -> list:
    r = await c.get(f"/pp/{svc}/{proj}/api/data")
    if r.status_code != 200:
        return []
    out = []
    for key, rec in empty_records(r.json(), rule):
        if _fresh(_stamp(rec.get("updatedAt") or rec.get("createdAt"))):
            continue
        out.append({"id": cand_id(svc, proj, key, rec["id"]), "target": "record_delete", "service": svc,
                    "project": proj, "reason": "이름 없는 항목", "title": f"{svc} {key} {rec['id']}",
                    "svc": svc, "destProj": proj, "key": key, "recordId": str(rec["id"]),
                    "snapshot": rec})                       # deleted only if the record is still this
    return out


def _stamp(v) -> float:
    """Seconds since the epoch from an ISO time or ms, 0 when there is none."""
    if isinstance(v, (int, float)):
        return v / 1000 if v > 1e11 else v
    try:
        t = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        return (t if t.tzinfo else t.replace(tzinfo=timezone.utc)).timestamp()
    except ValueError:
        return 0


def _fresh(stamp: float) -> bool:
    return bool(stamp) and datetime.now().timestamp() - stamp < FRESH


_started = False


def start_scheduler(app) -> None:
    """One task on the portal's own loop (the proxy's pooled client lives there), at HOURS:MINUTE local time."""
    global _started
    if _started or os.environ.get("PORTAL_TIDY_NOTES", "1") == "0":
        return
    _started = True

    async def loop():
        last = None
        while True:
            now = datetime.now()
            if now.hour in HOURS and now.minute >= MINUTE and (now.date(), now.hour) != last:
                last = (now.date(), now.hour)
                try:
                    log.info("tidy: %d candidates", len(await sweep(app)))
                except Exception:   # noqa: BLE001 — a bad sweep must not stop the next one
                    log.exception("tidy: sweep failed")
            await asyncio.sleep(60)
    asyncio.get_running_loop().create_task(loop())
