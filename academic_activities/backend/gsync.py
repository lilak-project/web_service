"""Google Calendar, step 2 — the two-way sync (one calendar at a time).

An activity and a Google event are linked in <data>/gcal/links.json:
    { activity id: { side, eid, last } }
`last` is how the pair read when they last agreed, in one shape for both
sides (canon_act / canon_ev). So on the next run:
    the activity no longer reads `last`  → it changed here  → Google is told
    the event no longer reads `last`     → it changed there → the activity is
    both                                 → the newer one wins, and it is logged
    a linked activity is gone            → its event is deleted (Google keeps
                                           its own bin 30 days)
    a linked event is gone (cancelled)   → the activity goes to the bin here
    an event with no link                → it comes in as an activity
    an activity with no link             → it goes out as an event
Every run can be a dry run first: plan() says what would happen; apply()
does it. Repeating series go as the RRULE they are, the days taken out as
EXDATE; one changed occurrence is Google's instance of the series and an
activity tied to its series here (series, seriesDate). Nothing but the
fields named in canon_* crosses.
"""
import json
import re
import time
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

KST = ZoneInfo("Asia/Seoul")
LINK = "🔗 "
SUB = "#submit"                     # a 제출 date: its own event on the 행사 side
SUBMIT = "📤 "


def _d(s):
    return date.fromisoformat(s)


def _plus_hour(t: str) -> str:
    h, m = map(int, t.split(":"))
    return f"{min(h + 1, 23):02d}:{m:02d}"


def _now() -> str:
    return datetime.now(KST).astimezone().isoformat()


# ── one shape for both sides ─────────────────────────────────────────────
def canon_act(r: dict, places: dict) -> dict:
    rep = r.get("repeat") or {}
    st = r.get("startTime") or ""
    start = (r.get("start") or "")[:10]
    p = r.get("place")
    return {
        "name": (r.get("name") or "").strip(),
        "start": start,
        "end": ((r.get("end") or "")[:10]) or start,
        "st": st,
        "et": (r.get("endTime") or (_plus_hour(st) if st else "")),
        "loc": (places.get(p, p) if isinstance(p, str) else "") or "",
        "comment": (r.get("comment") or "").strip(),
        "link": (r.get("link") or "").strip(),
        "rule": (rep.get("rule") or "") if rep else "",
        "ex": sorted(rep.get("ex") or []) if rep else [],
    }


def canon_submit(r: dict) -> dict:
    d = (r.get("submitDate") or "")[:10]
    return {"name": SUBMIT + (r.get("name") or "").strip(), "start": d, "end": d, "st": "", "et": "",
            "loc": "", "comment": "", "link": (r.get("link") or "").strip(), "rule": "", "ex": []}


def _exdates(lines: list) -> list:
    out = []
    for ln in lines or []:
        if not ln.upper().startswith("EXDATE"):
            continue
        head, _, vals = ln.partition(":")
        for v in vals.split(","):
            v = v.strip()
            m = re.match(r"^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$", v)
            if not m:
                continue
            if m.group(7):          # UTC: a day in Korea
                t = datetime(int(m[1]), int(m[2]), int(m[3]), int(m[4]), int(m[5]), int(m[6]),
                             tzinfo=ZoneInfo("UTC")).astimezone(KST)
                out.append(t.date().isoformat())
            else:
                out.append(f"{m[1]}-{m[2]}-{m[3]}")
    return sorted(set(out))


def canon_ev(e: dict, extra_ex=()) -> dict:
    s, en = e.get("start") or {}, e.get("end") or {}
    if "date" in s:
        start = s["date"]
        end = (_d(en.get("date") or start) - timedelta(days=1)).isoformat()
        st = et = ""
    else:
        a = datetime.fromisoformat(s["dateTime"]).astimezone(KST)
        b = datetime.fromisoformat(en.get("dateTime") or s["dateTime"]).astimezone(KST)
        start, st = a.date().isoformat(), a.strftime("%H:%M")
        end, et = b.date().isoformat(), b.strftime("%H:%M")
        if et == "00:00" and end > start:          # to midnight: the day before, at its end
            end = (_d(end) - timedelta(days=1)).isoformat()
            et = "23:59"
    desc = (e.get("description") or "").strip()
    link = ""
    lines = desc.split("\n")
    if lines and lines[-1].startswith(LINK):
        link = lines[-1][len(LINK):].strip()
        desc = "\n".join(lines[:-1]).strip()
    rec = e.get("recurrence") or []
    rule = next((ln[6:] for ln in rec if ln.upper().startswith("RRULE:")), "")
    return {
        "name": (e.get("summary") or "").strip(), "start": start, "end": max(start, end),
        "st": st, "et": et, "loc": (e.get("location") or "").strip(),
        "comment": desc, "link": link, "rule": rule,
        "ex": sorted(set(_exdates(rec)) | set(extra_ex)) if rule else [],
    }


def ev_body(c: dict, aid: str) -> dict:
    b = {"summary": c["name"], "location": c["loc"],
         "description": (c["comment"] + (f"\n\n{LINK}{c['link']}" if c["link"] else "")).strip(),
         "extendedProperties": {"private": {"lilak": aid}}}
    # A PATCH merges into what Google holds, so the kind of day not meant is
    # cleared (null): an all-day event given a time would otherwise keep its
    # `date` beside the new `dateTime`, and Google refuses it ("Invalid start time").
    if c["st"]:
        b["start"] = {"dateTime": f"{c['start']}T{c['st']}:00", "timeZone": "Asia/Seoul", "date": None}
        b["end"] = {"dateTime": f"{c['end']}T{c['et'] or _plus_hour(c['st'])}:00", "timeZone": "Asia/Seoul", "date": None}
    else:
        b["start"] = {"date": c["start"], "dateTime": None, "timeZone": None}
        b["end"] = {"date": (_d(c["end"]) + timedelta(days=1)).isoformat(), "dateTime": None, "timeZone": None}
    if c["rule"]:
        rec = [f"RRULE:{c['rule']}"]
        if c["ex"]:
            if c["st"]:
                rec.append("EXDATE;TZID=Asia/Seoul:" + ",".join(d.replace("-", "") + "T" + c["st"].replace(":", "") + "00" for d in c["ex"]))
            else:
                rec.append("EXDATE;VALUE=DATE:" + ",".join(d.replace("-", "") for d in c["ex"]))
        b["recurrence"] = rec
    else:
        b["recurrence"] = []
    return b


def act_from(c: dict, kind: str, now: str) -> dict:
    return {"id": str(uuid.uuid4()), "kind": kind, "name": c["name"], "start": c["start"],
            "end": c["end"] if c["end"] != c["start"] else "", "startTime": c["st"], "endTime": c["et"],
            "place": c["loc"], "comment": c["comment"], "link": c["link"],
            "repeat": {"rule": c["rule"], "ex": c["ex"]} if c["rule"] else None,
            "createdAt": now, "updatedAt": now}


def act_patch(r: dict, c: dict, now: str) -> dict:
    return {**r, "name": c["name"], "start": c["start"], "end": c["end"] if c["end"] != c["start"] else "",
            "startTime": c["st"], "endTime": c["et"], "place": c["loc"] or r.get("place") or "",
            "comment": c["comment"], "link": c["link"],
            "repeat": ({"rule": c["rule"], "ex": c["ex"]} if c["rule"] else (None if not r.get("series") else r.get("repeat"))),
            "updatedAt": now}


class Sync:
    """One side (etc / main) of the activities against its Google calendar."""

    def __init__(self, doc, root: Path, items: str, api, side: str, cal: str, kinds):
        self.doc, self.items, self.api, self.side, self.cal = doc, items, api, side, cal
        self.kinds = kinds                    # rec → True if it belongs on this side
        self.links_p = root / "links.json"
        self.state_p = root / f"state-{side}.json"

    def _load(self, p, d):
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return d

    def _save(self, p, v):
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_text(json.dumps(v, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(p)

    def _events(self):
        """Every event of the calendar, deleted ones too (so a deleted repeat is seen)."""
        out, page = [], None
        while True:
            d = self.api("GET", f"/calendars/{_q(self.cal)}/events",
                         params={"maxResults": 2500, "showDeleted": "true", "singleEvents": "false",
                                 **({"pageToken": page} if page else {})})
            out += d.get("items", [])
            page = d.get("nextPageToken")
            if not page:
                return out

    # ── which events this side has: an activity's 행사, and on the 행사 side its 제출 ──
    def _key(self, aid: str, part: str = "main") -> str:
        """The link key: the activity id on the 기타 side (as first linked),
        'main:<id>' and 'main:<id>#submit' on the 행사 side — so moving an
        activity from one side to the other never mixes up the two links."""
        if self.side == "etc":
            return aid
        return f"main:{aid}" + (SUB if part == "submit" else "")

    @staticmethod
    def _split(key: str) -> tuple:
        k = key.split(":", 1)[1] if key.startswith("main:") else key
        return (k[:-len(SUB)], "submit") if k.endswith(SUB) else (k, "main")

    def _parts(self, cur: dict, places: dict) -> dict:
        out = {}
        for r in cur.get(self.items) or []:
            if not r.get("id") or not self.kinds(r):
                continue
            if r.get("start"):
                out[self._key(r["id"])] = (r, "main", canon_act(r, places))
            if self.side == "main" and r.get("submitDate"):
                out[self._key(r["id"], "submit")] = (r, "submit", canon_submit(r))
        return out

    # ── what would happen ──
    def plan(self) -> dict:
        cur = self.doc.read()
        places = {p.get("id"): p.get("name", "") for p in cur.get("places") or []}
        parts = self._parts(cur, places)
        links = self._load(self.links_p, {})
        mine = {k: l for k, l in links.items() if l.get("side") == self.side}
        evs = self._events()
        by_id = {e["id"]: e for e in evs}
        # Days a series lost on Google as cancelled instances (not in its EXDATE).
        lost = {}
        for e in evs:
            if e.get("status") == "cancelled" and e.get("recurringEventId") and e.get("originalStartTime"):
                lost.setdefault(e["recurringEventId"], []).append(_orig(e))
        linked_eids = {l["eid"] for l in mine.values()}
        ops = []
        for k, l in mine.items():
            p, e = parts.get(k), by_id.get(l["eid"])
            gone_here, gone_there = p is None, (e is None or e.get("status") == "cancelled")
            if gone_here and gone_there:
                ops.append({"op": "unlink", "key": k}); continue
            if gone_here:            # deleted here, its 제출 date cleared, or moved to the other side
                ops.append({"op": "delete_google", "key": k, "eid": l["eid"], "name": l["last"].get("name", "")}); continue
            if gone_there:
                ops.append({"op": "delete_here", "key": k, "name": p[2]["name"]}); continue
            here, there = p[2], canon_ev(e, lost.get(e["id"], []))
            ch_here, ch_there = here != l["last"], there != l["last"]
            if ch_here and ch_there and here != there:
                newer_here = (p[0].get("updatedAt") or "") > (e.get("updated") or "")
                ops.append({"op": "update_google" if newer_here else "update_here", "key": k, "eid": l["eid"],
                            "name": here["name"], "conflict": True, "here": here, "there": there})
            elif ch_here and here != there:
                ops.append({"op": "update_google", "key": k, "eid": l["eid"], "name": here["name"], "here": here, "there": there})
            elif ch_there and here != there:
                ops.append({"op": "update_here", "key": k, "eid": l["eid"], "name": there["name"], "here": here, "there": there})
            elif here == there and here != l["last"]:
                ops.append({"op": "relink", "key": k, "eid": l["eid"]})
        # New on Google: series first, then single events, then changed occurrences.
        news = [e for e in evs if e.get("status") != "cancelled" and e["id"] not in linked_eids]
        news.sort(key=lambda e: (0 if e.get("recurrence") else 2 if e.get("recurringEventId") else 1))
        for e in news:
            c = canon_ev(e, lost.get(e["id"], []))
            ops.append({"op": "import", "eid": e["id"], "series_eid": e.get("recurringEventId", ""),
                        "orig": _orig(e), "name": c["name"], "c": c})
        # New here.
        for k, (r, part, c) in parts.items():
            if k in mine:
                continue
            ser = (r.get("series") or {}).get("id") if isinstance(r.get("series"), dict) else r.get("series")
            ops.append({"op": "create_google", "key": k, "name": c["name"], "c": c,
                        "series_aid": (ser or "") if part == "main" else "", "orig": (r.get("seriesDate") or "")[:10]})
        counts = {}
        for o in ops:
            counts[o["op"]] = counts.get(o["op"], 0) + 1
        return {"side": self.side, "counts": counts, "ops": ops}

    # ── doing it ──
    def apply(self, plan: dict, kind_new: str, who: str = "gcal") -> dict:
        now = _now()
        links = self._load(self.links_p, {})
        log = []
        # Here first: one document write for everything coming in.
        with self.doc.lock:
            cur = self.doc.read()
            acts = list(cur.get(self.items) or [])
            idx = {r.get("id"): i for i, r in enumerate(acts)}
            gone, wrote = set(), False
            eid_to_key = {l["eid"]: k for k, l in links.items() if l.get("side") == self.side}
            for o in plan["ops"]:
                if o["op"] == "import":
                    r = act_from(o["c"], kind_new, now)
                    if o["series_eid"]:
                        sk = eid_to_key.get(o["series_eid"])
                        if sk:
                            r["series"], r["seriesDate"], r["repeat"] = {"id": self._split(sk)[0]}, o["orig"], None
                    acts.insert(0, r)
                    idx = {x.get("id"): i for i, x in enumerate(acts)}
                    k = self._key(r["id"])
                    links[k] = {"side": self.side, "eid": o["eid"], "last": canon_act(r, {})}
                    eid_to_key[o["eid"]] = k
                    wrote = True
                    log.append(f"가져옴: {o['name']}")
                elif o["op"] in ("update_here", "delete_here"):
                    aid, part = self._split(o["key"])
                    if aid not in idx:
                        continue
                    i = idx[aid]
                    if o["op"] == "update_here":
                        acts[i] = act_patch(acts[i], o["there"], now) if part == "main" \
                            else {**acts[i], "submitDate": o["there"]["start"], "updatedAt": now}
                        links[o["key"]]["last"] = o["there"]
                        log.append(f"여기 고침: {o['name']}")
                    else:
                        if part == "main":
                            gone.add(aid)
                            log.append(f"여기서 지움(휴지통): {o['name']}")
                        else:
                            acts[i] = {**acts[i], "submitDate": "", "updatedAt": now}
                            log.append(f"제출 날짜 지움: {o['name']}")
                        links.pop(o["key"], None)
                    wrote = True
                elif o["op"] == "unlink":
                    links.pop(o["key"], None)
            if wrote:
                self.doc.write({**cur, self.items: [r for r in acts if r.get("id") not in gone]}, who, replaces=cur)
        self._save(self.links_p, links)
        # Then Google: one call each.
        cur = self.doc.read()
        places = {p.get("id"): p.get("name", "") for p in cur.get("places") or []}
        parts = self._parts(cur, places)
        base = f"/calendars/{_q(self.cal)}/events"
        for o in plan["ops"]:
            k = o.get("key")
            try:
                if o["op"] == "create_google" and k in parts:
                    c = parts[k][2]
                    sk = self._key(o["series_aid"]) if o.get("series_aid") else ""
                    if sk and sk in links:
                        # One changed occurrence: Google's instance of the series.
                        inst = self._instance(links[sk]["eid"], o["orig"])
                        if not inst:
                            log.append(f"건너뜀 (회차를 못 찾음): {o['name']}"); continue
                        body = ev_body({**c, "rule": "", "ex": []}, k)
                        body.pop("recurrence", None)              # an instance has none of its own
                        e = self.api("PATCH", f"{base}/{_q(inst)}", json=body)
                    else:
                        e = self.api("POST", base, json=ev_body(c, k))
                    links[k] = {"side": self.side, "eid": e["id"], "last": c}
                    log.append(f"구글에 만듦: {o['name']}")
                elif o["op"] == "update_google" and k in parts:
                    r, _, c = parts[k]
                    body = ev_body(c, k)
                    if r.get("series"):
                        body.pop("recurrence", None)
                    self.api("PATCH", f"{base}/{_q(o['eid'])}", json=body)
                    links[k]["last"] = c
                    log.append(f"구글 고침: {o['name']}" + (" (양쪽 다 바뀜 — 여기 것이 더 최근)" if o.get("conflict") else ""))
                elif o["op"] == "delete_google":
                    self.api("DELETE", f"{base}/{_q(o['eid'])}", ok=(204, 200, 404, 410))
                    links.pop(k, None)
                    log.append(f"구글에서 지움: {o['name']}")
                elif o["op"] == "relink" and k in parts:
                    links[k]["last"] = parts[k][2]
            except Exception as err:     # one failure does not stop the rest; the next run retries it
                log.append(f"실패: {o.get('op')} {o.get('name', '')} — {err}")
            self._save(self.links_p, links)
        st = self._load(self.state_p, {})
        st.update(lastRun=now, lastLog=log[-200:])
        self._save(self.state_p, st)
        return {"log": log}

    def _instance(self, master_eid: str, orig: str):
        d = self.api("GET", f"/calendars/{_q(self.cal)}/events/{_q(master_eid)}/instances",
                     params={"timeMin": f"{orig}T00:00:00+09:00",
                             "timeMax": f"{(_d(orig) + timedelta(days=1)).isoformat()}T00:00:00+09:00"})
        for e in d.get("items", []):
            return e["id"]
        return None


def _orig(e: dict) -> str:
    o = e.get("originalStartTime") or {}
    if o.get("date"):
        return o["date"]
    if o.get("dateTime"):
        return datetime.fromisoformat(o["dateTime"]).astimezone(KST).date().isoformat()
    return ""


def _q(s: str) -> str:
    from urllib.parse import quote
    return quote(s, safe="")
