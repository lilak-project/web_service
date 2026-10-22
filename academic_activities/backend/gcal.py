"""Google Calendar — step 1, read only.

Connect a Google account (OAuth, calendar.readonly), say which of its
calendars stand for what, and before anything is ever synced, see how the
activities and those calendars line up (the preview). Other calendars can be
shown on the calendar tab, read only (the overlay). Nothing is written to
Google, and nothing here is changed, by this module.

  GET  /api/gcal/status      what is set, and whether an account is connected
  PUT  /api/gcal/config      the OAuth client, the calendars (etc / main), the overlays
  GET  /api/gcal/auth        the URL to send the browser to, to connect
  GET  /api/gcal/callback    where Google sends it back (the redirect URI)
  GET  /api/gcal/calendars   the account's calendars
  GET  /api/gcal/overlay     the overlay calendars' events, for the calendar tab
  GET  /api/gcal/preview     the activities and the two calendars, matched up

Everything but the overlay is a manager's. The client secret and the tokens
live in <data>/gcal/, outside the repo, readable by the owner only.
"""
import json
import os
import re
import secrets
import threading
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import quote, urlencode
from zoneinfo import ZoneInfo

import httpx
from fastapi import Body, Depends, FastAPI, HTTPException
from fastapi.responses import HTMLResponse

from lilak_portal_auth import identity

from gsync import Sync

# Reading the calendars, and (step 2) writing their events.
SCOPE = "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events"
WRITE = "https://www.googleapis.com/auth/calendar.events"
AUTH = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN = "https://oauth2.googleapis.com/token"
API = "https://www.googleapis.com/calendar/v3"
KST = ZoneInfo("Asia/Seoul")
# The timer applies a plan by itself only below these; above, it waits for a person.
AUTO_MAX_DELETE, AUTO_MAX_NEW = 3, 20
TICK, EDIT_QUIET = 5, 5            # seconds: how often the timer looks; how still an edit must be


def _load(p: Path, default):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return default


def _save(p: Path, v) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(json.dumps(v, ensure_ascii=False, indent=1), encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, p)


def _manager(me: dict = Depends(identity)) -> dict:
    if not me.get("authenticated") or (me.get("role") or "").lower() not in ("manager", "admin"):
        raise HTTPException(403, "관리자만 할 수 있습니다.")
    return me


def _signed_in(me: dict = Depends(identity)) -> dict:
    if not me.get("authenticated"):
        raise HTTPException(401, "로그인이 필요합니다.")
    return me


# ── dates ─────────────────────────────────────────────────────────────────
def span(ev: dict) -> tuple:
    """(first day, last day, 'HH:MM' or '') of a Google event, in Korea.
    An all-day event's end is the day AFTER it, as Google writes it."""
    s, e = ev.get("start") or {}, ev.get("end") or {}
    if "date" in s:
        a = s["date"]
        b = (date.fromisoformat(e.get("date") or a) - timedelta(days=1)).isoformat()
        return a, max(a, b), ""
    a = datetime.fromisoformat(s["dateTime"]).astimezone(KST)
    b = datetime.fromisoformat(e.get("dateTime") or s["dateTime"]).astimezone(KST)
    last = b.date()
    if b.time() == datetime.min.time() and last > a.date():
        last -= timedelta(days=1)                 # ends at midnight: the day before
    return a.date().isoformat(), last.isoformat(), a.strftime("%H:%M")


# ── names ─────────────────────────────────────────────────────────────────
def _words(s: str) -> set:
    return set(re.findall(r"[0-9a-z가-힣]+", (s or "").lower()))


def likeness(a: str, b: str) -> float:
    """0 to 1: how alike two titles read — shared words, or one inside the other."""
    wa, wb = _words(a), _words(b)
    if not wa or not wb:
        return 0.0
    j = len(wa & wb) / len(wa | wb)
    na, nb = "".join(sorted(wa)), "".join(sorted(wb))
    flat_a, flat_b = re.sub(r"\W", "", (a or "").lower()), re.sub(r"\W", "", (b or "").lower())
    if min(len(flat_a), len(flat_b)) >= 3 and (flat_a in flat_b or flat_b in flat_a):
        j = max(j, 0.8)
    return 1.0 if na == nb else j


def mount_gcal(app: FastAPI, doc, data: Path, items: str = "activities") -> None:
    root = data / "gcal"
    cfg_p, tok_p = root / "config.json", root / "token.json"
    states: dict = {}                              # state → when issued (the callback's CSRF check)
    cache: dict = {}                               # overlay events, briefly

    def cfg() -> dict:
        return _load(cfg_p, {})

    # ── tokens ──
    def _exchange(form: dict) -> dict:
        c = cfg()
        r = httpx.post(TOKEN, data={**form, "client_id": c.get("client_id", ""),
                                    "client_secret": c.get("client_secret", "")}, timeout=20)
        if r.status_code != 200:
            raise HTTPException(502, f"구글 토큰 요청 실패: {r.text[:200]}")
        return r.json()

    def access() -> str:
        t = _load(tok_p, None)
        if not t:
            raise HTTPException(409, "구글 계정이 연결되지 않았습니다.")
        if t.get("expires_at", 0) < time.time() + 60:
            n = _exchange({"grant_type": "refresh_token", "refresh_token": t.get("refresh_token", "")})
            t.update(access_token=n["access_token"], expires_at=time.time() + int(n.get("expires_in", 3600)))
            _save(tok_p, t)
        return t["access_token"]

    def gget(path: str, **params) -> dict:
        r = httpx.get(API + path, params=params, headers={"Authorization": f"Bearer {access()}"}, timeout=30)
        if r.status_code != 200:
            raise HTTPException(502, f"구글 캘린더 요청 실패 ({r.status_code}): {r.text[:200]}")
        return r.json()

    def events(cal: str, **params) -> list:
        out, page = [], None
        while True:
            d = gget(f"/calendars/{quote(cal, safe='')}/events",
                     maxResults=2500, **params, **({"pageToken": page} if page else {}))
            out += [e for e in d.get("items", []) if e.get("status") != "cancelled"]
            page = d.get("nextPageToken")
            if not page:
                return out

    # ── settings ──
    @app.get("/api/gcal/status")
    def status(_: dict = Depends(_manager)) -> dict:
        c = cfg()
        return {"configured": bool(c.get("client_id") and c.get("client_secret")),
                "connected": tok_p.exists(), "client_id": c.get("client_id", ""),
                "redirect_uri": c.get("redirect_uri", ""), "calendars": c.get("calendars", {}),
                "overlays": c.get("overlays", []), "scope": SCOPE,
                "can_write": WRITE in (_load(tok_p, {}) or {}).get("scope", ""),
                "auto": int(c.get("auto") or 0), "onEdit": bool(c.get("onEdit")),
                "sync": {side: {k: v for k, v in _load(root / f"state-{side}.json", {}).items()
                                if k in ("lastRun", "autoAt", "pushAt", "held", "error")} for side in SIDES}}

    @app.put("/api/gcal/config")
    def set_config(body: dict = Body(...), _: dict = Depends(_manager)) -> dict:
        c = cfg()
        for k in ("client_id", "client_secret", "redirect_uri"):
            if isinstance(body.get(k), str) and body[k].strip():
                c[k] = body[k].strip()
        if isinstance(body.get("calendars"), dict):
            c["calendars"] = {k: str(v) for k, v in body["calendars"].items() if k in ("etc", "main") and v}
        if "onEdit" in body:
            c["onEdit"] = bool(body.get("onEdit"))
        if "auto" in body:
            c["auto"] = max(0, min(1440, int(body.get("auto") or 0)))
        if isinstance(body.get("overlays"), list):
            c["overlays"] = [{"id": str(o.get("id")), "name": str(o.get("name") or ""), "color": str(o.get("color") or "")}
                             for o in body["overlays"] if isinstance(o, dict) and o.get("id")]
            cache.clear()
        _save(cfg_p, c)
        return status()

    @app.get("/api/gcal/auth")
    def auth(_: dict = Depends(_manager)) -> dict:
        c = cfg()
        if not (c.get("client_id") and c.get("redirect_uri")):
            raise HTTPException(409, "OAuth 클라이언트 ID와 리디렉션 URI를 먼저 넣어주세요.")
        st = secrets.token_urlsafe(24)
        states[st] = time.time()
        return {"url": AUTH + "?" + urlencode({
            "client_id": c["client_id"], "redirect_uri": c["redirect_uri"], "response_type": "code",
            "scope": SCOPE, "access_type": "offline", "prompt": "consent", "state": st})}

    @app.get("/api/gcal/callback")
    def callback(code: str = "", state: str = "", error: str = "") -> HTMLResponse:
        page = lambda msg: HTMLResponse(  # noqa: E731
            f"<meta charset=utf-8><body style='font:14px system-ui;padding:24px'>{msg}"
            "<script>try{window.opener&&window.opener.postMessage('gcal:done','*')}catch(e){}</script>")
        if error:
            return page(f"연결하지 않았습니다: {error}")
        if not state or time.time() - states.pop(state, 0) > 600:
            return page("연결 요청이 오래됐거나 맞지 않습니다. 다시 눌러주세요.")
        t = _exchange({"grant_type": "authorization_code", "code": code,
                       "redirect_uri": cfg().get("redirect_uri", "")})
        if not t.get("refresh_token"):
            return page("구글이 갱신 토큰을 주지 않았습니다. 구글 계정의 '타사 액세스'에서 이 앱을 지운 뒤 다시 연결해주세요.")
        _save(tok_p, {"access_token": t["access_token"], "refresh_token": t["refresh_token"],
                      "expires_at": time.time() + int(t.get("expires_in", 3600)), "scope": t.get("scope", "")})
        return page("구글 캘린더에 연결했습니다 (보기 전용). 이 창은 닫아도 됩니다.")

    @app.get("/api/gcal/calendars")
    def calendars(_: dict = Depends(_manager)) -> list:
        d = gget("/users/me/calendarList", maxResults=250)
        return [{"id": x["id"], "name": x.get("summaryOverride") or x.get("summary", ""),
                 "color": x.get("backgroundColor", ""), "access": x.get("accessRole", ""),
                 "primary": bool(x.get("primary"))} for x in d.get("items", [])]

    # ── read-only calendars, shown on the calendar tab ──
    @app.get("/api/gcal/overlay")
    def overlay(_: dict = Depends(_signed_in)) -> list:
        c = cfg()
        if not c.get("overlays") or not tok_p.exists():
            return []
        if cache.get("at", 0) > time.time() - 300:
            return cache["events"]
        now = datetime.now(KST)
        lo, hi = (now - timedelta(days=730)).isoformat(), (now + timedelta(days=730)).isoformat()
        out = []
        for o in c["overlays"]:
            for e in events(o["id"], singleEvents="true", timeMin=lo, timeMax=hi):
                a, b, t = span(e)
                out.append({"id": f'{o["id"]}:{e["id"]}', "feed": o.get("name") or o["id"],
                            "color": o.get("color") or "#9aa1ad", "title": e.get("summary", ""),
                            "start": a, "end": b, "time": t, "location": e.get("location", "")})
        cache.update(at=time.time(), events=out)
        return out

    # ── the sync (gsync.py), one side at a time; a plan first, always ──
    def call(method: str, path: str, params=None, json=None, ok=(200,)):
        r = httpx.request(method, API + path, params=params, json=json,
                          headers={"Authorization": f"Bearer {access()}"}, timeout=30)
        if r.status_code not in ok:
            raise HTTPException(502, f"구글 {method} {r.status_code}: {r.text[:200]}")
        return r.json() if r.content else {}

    # Which activities belong to which calendar: 기타 to its own, the rest to 행사.
    SIDES = {"etc": lambda r: r.get("kind") == "기타", "main": lambda r: r.get("kind") != "기타"}
    def syncer(side: str) -> Sync:
        cals = cfg().get("calendars") or {}
        if side not in SIDES or not cals.get(side):
            raise HTTPException(409, "이 캘린더는 아직 동기화하지 않습니다.")
        if WRITE not in (_load(tok_p, {}) or {}).get("scope", ""):
            raise HTTPException(409, "쓰기 권한이 없습니다. '쓰기 권한으로 다시 연결'을 눌러주세요.")
        return Sync(doc, root, items, call, side, cals[side], SIDES[side])

    def brief(p: dict) -> dict:
        keep = ("op", "name", "key", "eid", "conflict", "orig")
        ops = []
        for o in p["ops"]:
            x = {k: o[k] for k in keep if k in o}
            c = o.get("c") or o.get("here") or {}
            x["when"] = f'{c.get("start", "")}{("~" + c["end"]) if c.get("end") and c.get("end") != c.get("start") else ""} {c.get("st", "")}'.strip()
            if c.get("rule"):
                x["rule"] = c["rule"]
            ops.append(x)
        return {"side": p["side"], "counts": p["counts"], "ops": ops}

    @app.post("/api/gcal/plan")
    def plan(body: dict = Body(...), _: dict = Depends(_manager)) -> dict:
        """What a sync would do now — nothing done."""
        return brief(syncer(str(body.get("side") or "")).plan())

    busy = threading.Lock()                   # one sync at a time, by hand or on the timer

    @app.post("/api/gcal/apply")
    def apply(body: dict = Body(...), me: dict = Depends(_manager)) -> dict:
        """Do it: the plan is worked out again here, not taken from the client."""
        with busy:
            s = syncer(str(body.get("side") or ""))
            p = s.plan()
            out = s.apply(p, kind_new="기타" if s.side == "etc" else "행사",
                          who=f'gcal:{me.get("username") or me.get("email") or ""}')
            _note(s.side, held=None, error=None)
            return {**brief(p), **out}

    # ── on its own: every `auto` minutes (config; 0 = off) ──
    def _note(side: str, **kw) -> None:
        p = root / f"state-{side}.json"
        _save(p, {**_load(p, {}), **kw})

    def risky(counts: dict) -> str:
        """Why a plan should wait for a person: many deletions, or a flood
        coming in or going out (a calendar switched, a bad import)."""
        gone = counts.get("delete_google", 0) + counts.get("delete_here", 0)
        new = counts.get("import", 0) + counts.get("create_google", 0)
        if gone > AUTO_MAX_DELETE:
            return f"지울 것이 {gone}건 — 직접 확인하고 적용하세요"
        if new > AUTO_MAX_NEW:
            return f"새로 오가는 것이 {new}건 — 직접 확인하고 적용하세요"
        return ""

    UP = ("create_google", "update_google", "delete_google", "relink", "unlink")

    def auto_once(side: str, upload: bool = False) -> None:
        """One round on its own. `upload`: only what changed here goes out
        (right after an edit); what changed on Google waits for the timer."""
        note = {("pushAt" if upload else "autoAt"): time.time(), "held": None, "error": None}
        try:
            with busy:
                s = syncer(side)
                p = s.plan()
                if upload:
                    ops = [o for o in p["ops"] if o["op"] in UP]
                    counts = {}
                    for o in ops:
                        counts[o["op"]] = counts.get(o["op"], 0) + 1
                    p = {**p, "ops": ops, "counts": counts}
                why = risky(p["counts"])
                if why:
                    note["held"] = {"why": why, "counts": p["counts"]}
                elif p["ops"]:
                    s.apply(p, kind_new="기타" if side == "etc" else "행사", who="gcal:auto")
        except Exception as e:      # an expired token, Google down: say so, try again next round
            note["error"] = str(getattr(e, "detail", "") or e)
        _note(side, **note)

    def ticker() -> None:
        """Every few seconds: an edit here (the store's files changed, then
        stayed still for EDIT_QUIET s) sends it out, if `onEdit`; and every
        `auto` minutes, a whole round both ways."""
        seen, edited = doc._stamp_now(), 0.0
        while True:
            time.sleep(TICK)
            try:
                c = cfg()
                now = doc._stamp_now()
                if now != seen:
                    seen, edited = now, time.time()
                ran = False
                if edited and time.time() - edited >= EDIT_QUIET:
                    edited = 0.0
                    if c.get("onEdit"):
                        for side in SIDES:
                            auto_once(side, upload=True)
                        ran = True
                mins = int(c.get("auto") or 0)
                for side in SIDES if mins > 0 else ():
                    if time.time() - _load(root / f"state-{side}.json", {}).get("autoAt", 0) >= mins * 60 - TICK:
                        auto_once(side)
                        ran = True
                # What a round wrote here itself is not an edit to send back.
                # ponytail: an edit made during a round is taken as seen; the next timed round still carries it
                if ran and not edited:
                    seen = doc._stamp_now()
            except Exception:
                pass                   # the timer itself never stops

    if os.environ.get("GCAL_TIMER", "1") != "0":       # 0: a script or test importing the app, no timer
        threading.Thread(target=ticker, name="gcal-auto", daemon=True).start()

    # ── before any sync: how the two sides line up ──
    @app.get("/api/gcal/preview")
    def preview(_: dict = Depends(_manager)) -> dict:
        c = cfg()
        cals = c.get("calendars") or {}
        if not (cals.get("etc") and cals.get("main")):
            raise HTTPException(409, "기타용과 행사용 캘린더를 먼저 고르세요.")
        cur = doc.read()
        places = {p.get("id"): p.get("name", "") for p in cur.get("places") or []}

        # Our side: each activity's 행사 (start~end) and, when set, its 제출.
        parts = []
        for r in cur.get(items) or []:
            side = "etc" if r.get("kind") == "기타" else "main"
            if r.get("start"):
                parts.append({"part": "main", "side": side, "r": r, "from": r["start"][:10],
                              "to": (r.get("end") or r["start"])[:10]})
            if r.get("submitDate"):
                d = r["submitDate"][:10]
                parts.append({"part": "submit", "side": side, "r": r, "from": d, "to": d})

        # Their side: every event of the two calendars; repeating ones aside (step 2).
        gev, repeating = [], []
        for side in ("etc", "main"):
            for e in events(cals[side], singleEvents="false"):
                if e.get("recurrence") or e.get("recurringEventId"):
                    repeating.append({"side": side, "id": e["id"], "title": e.get("summary", ""),
                                      "start": span(e)[0], "rule": (e.get("recurrence") or [""])[0]})
                    continue
                a, b, t = span(e)
                gev.append({"side": side, "e": e, "from": a, "to": b, "time": t})

        def pair_score(g, p):
            if g["to"] < p["from"] or g["from"] > p["to"]:
                return 0.0
            title = re.sub(r"📤|제출|submission", " ", g["e"].get("summary", ""), flags=re.I) if p["part"] == "submit" \
                else g["e"].get("summary", "")
            s = likeness(title, p["r"].get("name", ""))
            return s + (0.2 if g["from"] == p["from"] else 0.0)

        cands = []
        for gi, g in enumerate(gev):
            for pi, p in enumerate(parts):
                sc = pair_score(g, p)
                if sc >= 0.34:
                    cands.append((sc, gi, pi))
        cands.sort(key=lambda x: -x[0])
        used_g, used_p, linked, unsure = set(), set(), [], []
        for sc, gi, pi in cands:
            if gi in used_g or pi in used_p:
                continue
            used_g.add(gi); used_p.add(pi)
            g, p = gev[gi], parts[pi]
            r, e = p["r"], g["e"]
            others = sorted({round(s2, 2) for s2, g2, p2 in cands if g2 == gi and p2 != pi})
            row = {"score": round(sc, 2), "part": p["part"], "id": r.get("id"), "name": r.get("name", ""),
                   "kind": r.get("kind", ""), "from": p["from"], "to": p["to"],
                   "event": {"side": g["side"], "id": e["id"], "title": e.get("summary", ""),
                             "from": g["from"], "to": g["to"], "time": g["time"]}}
            diffs = []
            if g["side"] != p["side"]:
                diffs.append("캘린더")
            if (g["from"], g["to"]) != (p["from"], p["to"]):
                diffs.append("날짜")
            if p["part"] == "main":
                if e.get("summary", "").strip() != (r.get("name") or "").strip():
                    diffs.append("이름")
                if g["time"] and g["time"] != (r.get("startTime") or ""):
                    diffs.append("시간")
                where = places.get(r.get("place"), r.get("place") or "")
                if (e.get("location") or "").strip() and (e.get("location") or "").strip() != (where or "").strip():
                    diffs.append("위치")
            row["diffs"] = diffs
            # Sure: the names read alike and nothing else came close.
            (linked if sc >= 0.7 and not any(s2 >= sc - 0.15 for s2 in others) else unsure).append(row)

        here_only = [{"part": p["part"], "id": p["r"].get("id"), "name": p["r"].get("name", ""),
                      "kind": p["r"].get("kind", ""), "side": p["side"], "from": p["from"], "to": p["to"]}
                     for pi, p in enumerate(parts) if pi not in used_p]
        google_only = [{"side": g["side"], "id": g["e"]["id"], "title": g["e"].get("summary", ""),
                        "from": g["from"], "to": g["to"], "time": g["time"],
                        "location": g["e"].get("location", "")}
                       for gi, g in enumerate(gev) if gi not in used_g]
        by = lambda k: (lambda x: x.get(k) or "")  # noqa: E731
        return {"linked": sorted(linked, key=by("from")), "unsure": sorted(unsure, key=by("from")),
                "here_only": sorted(here_only, key=by("from")), "google_only": sorted(google_only, key=by("from")),
                "repeating": sorted(repeating, key=by("start")),
                "counts": {"activities": len(cur.get(items) or []), "parts": len(parts), "events": len(gev),
                           "repeating": len(repeating)}}

