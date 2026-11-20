"""Tidying the portal does on its own (Feedback #9): twice a day, notes with no title (or "Untitled")
or no body are put to the owner as inbox candidates (target note_delete). Nothing is deleted here:
approving one in the inbox moves the note to the rack bin (30 days). Judged by title and body, never
by id (an id keeps "Untitled" after the note is named).

PORTAL_TIDY_NOTES=0 turns the timer off; POST /api/admin/tidy/empty-notes runs it now (dry_run to look).
"""
import asyncio
import logging
import os
import re
import uuid
from datetime import date, datetime
from urllib.parse import quote

import httpx

from . import models, registry
from .db import SessionLocal
from .deps import portal_token

log = logging.getLogger("tidy")
HOURS = (9, 21)                       # local time, the two sweeps of a day
UNTITLED = re.compile(r"^(untitled|제목\s*없음)(\s*[-_ ]?\d+)?$", re.I)
TAG_LINE = re.compile(r"^(\s*[#+][^\s#+]+)+\s*$")   # `#report +STARK`: tags only, no words
FRESH = 3600                          # seconds: a note saved this recently may still be being written


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


def _admin_jwt() -> str:
    with SessionLocal() as db:
        u = db.query(models.User).filter(models.User.role == "manager", models.User.is_active.is_(True)) \
            .order_by(models.User.id).first()
        return portal_token(u) if u else ""


def _pairs() -> list:
    """(note project, inbox project) of each share set that has both."""
    out = []
    for st in registry.share_sets()[0]:
        m = st.get("members") or {}
        if m.get("note") and m.get("inbox") and (m["note"], m["inbox"]) not in out:
            out.append((m["note"], m["inbox"]))
    return out


async def sweep(app, dry_run: bool = False) -> list:
    """The candidates left (or, dry_run, that would be): [{note project, id, title, reason}]."""
    jwt = _admin_jwt()
    if not jwt:
        return []
    found = []
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://portal", timeout=60,
                                 headers={"Authorization": f"Bearer {jwt}", "Accept": "application/json"}) as c:
        for nproj, iproj in _pairs():
            r = await c.get(f"/pp/note/{nproj}/api/notes")
            i = await c.get(f"/pp/inbox/{iproj}/api/data")
            if r.status_code != 200 or i.status_code != 200:
                log.warning("tidy: %s/%s not readable (%s, %s)", nproj, iproj, r.status_code, i.status_code)
                continue
            asked = {(x.get("destProj"), x.get("noteId")) for x in i.json().get("inbox") or []
                     if x.get("target") == "note_delete"}          # asked once: a no is not asked again
            for s in r.json().get("notes") or []:
                if (nproj, s["id"]) in asked or (s.get("excerpt") and not UNTITLED.match((s.get("title") or "").strip())
                                                  and (s.get("title") or "").strip()):
                    continue                                       # titled and has words: not even read
                full = await c.get(f"/pp/note/{nproj}/api/notes/{quote(s['id'], safe='')}")
                if full.status_code != 200:
                    continue
                n = full.json()
                why = empty_reason(n.get("title"), n.get("body"))
                if not why or _fresh(n.get("version")):
                    continue
                found.append({"project": nproj, "id": n["id"], "title": n.get("title") or "", "reason": why})
                if dry_run:
                    continue
                rec = {"id": f"tidy-{uuid.uuid4().hex}", "target": "note_delete", "status": "waiting",
                       "from": "포털 정리", "date": date.today().isoformat(),
                       "remark": f"{why}. 승인하면 휴지통으로 갑니다(30일 안에 되살릴 수 있음).",
                       "title": n.get("title") or "", "noteId": n["id"], "destProj": nproj,
                       "excerpt": n.get("body") or ""}   # whole: inbox deletes only if the body is still this
                w = await c.post(f"/pp/inbox/{iproj}/api/records", json={"key": "inbox", "record": rec})
                if w.status_code >= 400:
                    log.warning("tidy: inbox %s refused (%s)", iproj, w.status_code)
    return found


def _fresh(version) -> bool:
    """A note's version is its file's mtime in ns."""
    try:
        return datetime.now().timestamp() - int(version) / 1e9 < FRESH
    except (TypeError, ValueError):
        return False


_started = False


def start_scheduler(app) -> None:
    """One task on the portal's own loop (the proxy's pooled client lives there), sweeping at HOURS local time."""
    global _started
    if _started or os.environ.get("PORTAL_TIDY_NOTES", "1") == "0":
        return
    _started = True

    async def loop():
        last = None
        while True:
            now = datetime.now()
            if now.hour in HOURS and (now.date(), now.hour) != last:
                last = (now.date(), now.hour)
                try:
                    log.info("tidy: %d empty-note candidates", len(await sweep(app)))
                except Exception:   # noqa: BLE001 — a bad sweep must not stop the next one
                    log.exception("tidy: sweep failed")
            await asyncio.sleep(60)
    asyncio.get_running_loop().create_task(loop())
