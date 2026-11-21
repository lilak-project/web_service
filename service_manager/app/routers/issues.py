"""
The portal's issues (routers/reports.py) kept in step with upstream, both ways.

main portal (GITHUB_ISSUES_TOKEN + GITHUB_ISSUES_REPO set): each report whose kind goes up becomes a GitHub
  issue, each comment a GitHub comment, resolved/open a close/reopen. GitHub answers through the webhook
  (POST /api/github/webhook, signed with GITHUB_WEBHOOK_SECRET): a comment there becomes a comment here (shown
  by GitHub login), a close/reopen there resolves/reopens here.
sub portal (no GitHub token): paired with a main portal the HANDSHAKE.md way (address in, main's admin
  approves after matching the pin, the sub collects its token once) and relays its reports, comments and
  states there (/api/issues/relay/*); it pulls main's side back (comments, states) every minute. Main never
  has to reach a sub.

Nothing goes twice: a report remembers its number upstream (ext_id) and the state both last agreed on
(ext_state); a comment its id upstream (ext_id), set when sent or when it arrived from there. What we post
to GitHub carries MARK, so its webhook echo is dropped. Public repository: a post names only the writer's
portal name and the server, never an e-mail or account detail; attachments go as portal links.

Only reports filed after the link was first made go up (after_id): the older ones were written for this
portal's admins, not for a public repository. Kinds: bug, recommendation, inquiry go up by default, local never; an admin changes that (data/_portal/
issues.json, which also holds the pairing). Nothing configured: every sweep returns at once.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import secrets
import socket
import threading
import time
import uuid
from typing import Optional
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import func

from .. import config, models, registry, security, sync
from ..db import SessionLocal
from ..deps import require_portal_admin

router = APIRouter(tags=["issues"])
log = logging.getLogger("issues")
FILE = config.DATA_ROOT / "_portal" / "issues.json"
MARK = "<!-- lilak-portal -->"
KINDS = ("bug", "recommendation", "inquiry", "local")
DEFAULT_KINDS = {"bug": True, "recommendation": True, "inquiry": True, "local": False}
UA = {"User-Agent": "lilak-portal-issues/1"}      # Cloudflare refuses Python's default (see sync.py)
_flock = threading.Lock()


# ── settings ──────────────────────────────────────────────────────────────────
def _read() -> dict:
    try:
        d = json.loads(FILE.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _edit(fn) -> dict:
    with _flock:
        d = _read()
        fn(d)
        FILE.parent.mkdir(parents=True, exist_ok=True)
        registry._atomic_write_text(FILE, json.dumps(d, ensure_ascii=False, indent=2))
        return d


def _gh() -> Optional[tuple]:
    tok, repo = os.environ.get("GITHUB_ISSUES_TOKEN", "").strip(), os.environ.get("GITHUB_ISSUES_REPO", "").strip()
    return (tok, repo) if tok and repo else None


def _main() -> Optional[dict]:
    m = _read().get("main") or {}
    return m if m.get("url") and m.get("token") else None


def mode() -> str:
    """'github' (this is the main portal), 'sub' (relays to one), or 'off'."""
    return "github" if _gh() else "sub" if _main() else "off"


def kinds() -> dict:
    k = _read().get("kinds") or {}
    return {x: bool(k.get(x, DEFAULT_KINDS[x])) for x in KINDS}


def _host(url: str) -> str:
    return urlsplit(url).hostname or url


def _server() -> str:
    return _host(config.BASE_URL) if "localhost" not in config.BASE_URL else socket.gethostname()


def link_of(r: models.Report) -> Optional[dict]:
    """Where a report lives upstream, for the screen."""
    if not r.ext_id:
        return None
    m = mode()
    if m == "github":
        return {"where": "github", "id": r.ext_id, "url": f"https://github.com/{_gh()[1]}/issues/{r.ext_id}"}
    if m == "sub":
        return {"where": _host(_main()["url"]), "id": r.ext_id, "url": _main()["url"]}
    return None


# ── the sweep: send what is new, then (a sub) take main's side back ──────────
_wake = threading.Event()
_sweeping = threading.Lock()


def kick() -> None:
    """Something changed: sweep now rather than at the next minute."""
    _wake.set()


def _files(r: models.Report) -> str:
    atts = json.loads(r.attachments_json or "[]")
    return "".join(f"\n- [{a.get('name')}]({config.BASE_URL}/api/reports/{r.id}/files/{a.get('id')})" for a in atts)


def _who(db, r: models.Report) -> str:
    if r.origin:
        return r.author or "?"
    u = db.get(models.User, r.user_id) if r.user_id else None
    return u.username if u else (r.author or "?")


def _post_text(who: str, where: str, body: str) -> str:
    return f"**{who}** ({where}):\n\n{body}\n\n{MARK}"


class _GitHub:
    def __init__(self, token: str, repo: str):
        self.c = httpx.Client(base_url=f"https://api.github.com/repos/{repo}", timeout=20, headers={
            "Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28", **UA})

    def _send(self, method, path, body) -> dict:
        r = self.c.request(method, path, json=body)
        r.raise_for_status()
        return r.json()

    def open(self, db, r):
        files = _files(r) if not r.origin else ""
        body = _post_text(_who(db, r), r.origin or _server(), (r.body or "—") + (f"\n\n첨부:{files}" if files else ""))
        title = f"[{r.kind}] " + (r.subject or (r.body or "")[:60] or f"#{r.id}")
        return self._send("POST", "/issues", {"title": title[:250], "body": body})["number"]

    def comment(self, db, r, c):
        where = c.origin if c.origin not in ("", "github") else _server()
        return self._send("POST", f"/issues/{r.ext_id}/comments", {"body": _post_text(c.author, where, c.body)})["id"]

    def state(self, r):
        self._send("PATCH", f"/issues/{r.ext_id}", {"state": "closed" if r.status == "resolved" else "open"})


class _Main:
    def __init__(self, m: dict):
        self.name = _host(m["url"])
        self.c = httpx.Client(base_url=m["url"].rstrip("/") + "/api/issues/relay", timeout=20,
                              headers={"Authorization": f"Bearer {m['token']}", **UA})

    def _send(self, method, path, body=None, **kw) -> dict:
        r = self.c.request(method, path, json=body, **kw)
        r.raise_for_status()
        return r.json()

    def open(self, db, r):
        atts = [{"name": a.get("name"), "url": f"{config.BASE_URL}/api/reports/{r.id}/files/{a.get('id')}"}
                for a in json.loads(r.attachments_json or "[]")]
        return self._send("POST", "/reports", {"id": r.id, "kind": r.kind, "subject": r.subject, "body": r.body,
                                               "author": _who(db, r), "attachments": atts})["id"]

    def comment(self, db, r, c):
        return self._send("POST", f"/reports/{r.ext_id}/comments", {"id": c.id, "author": c.author, "body": c.body})["id"]

    def state(self, r):
        self._send("POST", f"/reports/{r.ext_id}/state", {"resolved": r.status == "resolved"})

    def updates(self, after: int) -> dict:
        return self._send("GET", "/updates", params={"after": after})


def _push(db, up, goes: dict, after_id: int = 0) -> None:
    # ponytail: looks at every report each sweep; filter by updated_at once there are thousands.
    # A request that reached upstream but whose answer was lost is sent again next sweep (a duplicate there).
    for r in db.query(models.Report).order_by(models.Report.id).all():
        try:
            if not r.ext_id:
                if r.id <= after_id or not goes.get(r.kind, r.kind != "local"):
                    continue
                r.ext_id, r.ext_state = str(up.open(db, r)), "open"
                db.commit()
            for c in (db.query(models.ReportComment).filter(models.ReportComment.report_id == r.id,
                                                             models.ReportComment.ext_id.is_(None))
                      .order_by(models.ReportComment.id).all()):
                c.ext_id = str(up.comment(db, r, c))
                db.commit()
            if r.status != (r.ext_state or "open"):
                up.state(r)
                r.ext_state = r.status
                db.commit()
        except Exception as e:                     # noqa: BLE001 — the next sweep tries again
            db.rollback()
            log.warning("issues: report %s not sent: %s", r.id, e)


def _pull(db, up: _Main) -> None:
    after = int(_read().get("cursor") or 0)
    u = up.updates(after)
    mine = {r.ext_id: r for r in db.query(models.Report).filter(models.Report.ext_id.isnot(None))}
    for x in u.get("reports") or []:
        r = mine.get(str(x.get("id")))
        if r and x.get("status") in ("open", "resolved") and x["status"] != (r.ext_state or "open"):
            r.status = r.ext_state = x["status"]
    for c in u.get("comments") or []:
        r = mine.get(str(c.get("report_id")))
        if r and not db.query(models.ReportComment).filter(models.ReportComment.report_id == r.id,
                                                           models.ReportComment.ext_id == str(c["id"])).first():
            db.add(models.ReportComment(report_id=r.id, author=str(c.get("author") or "")[:80],
                                        origin=str(c.get("origin") or up.name)[:80], body=str(c.get("body") or ""),
                                        ext_id=str(c["id"])))
    db.commit()
    if int(u.get("cursor") or 0) > after:
        _edit(lambda d: d.update(cursor=int(u["cursor"])))


def sweep() -> str:
    """One round; returns the mode it ran in ('busy' when another round is running)."""
    if not _sweeping.acquire(blocking=False):
        return "busy"
    try:
        if (_read().get("pending") or {}).get("status") == "pending":
            _check_pending()
        m = mode()
        if m == "off":
            return m
        up = _GitHub(*_gh()) if m == "github" else _Main(_main())
        with SessionLocal() as db:
            if "after_id" not in _read():          # what was filed before the link stays here (public repo)
                n = db.query(func.max(models.Report.id)).scalar() or 0
                _edit(lambda d: d.setdefault("after_id", n))
            _push(db, up, kinds(), int(_read()["after_id"]))
            if m == "sub":
                _pull(db, up)
        return m
    finally:
        _sweeping.release()


_started = False


def start_scheduler() -> None:
    global _started
    if _started:
        return
    _started = True

    def loop():
        while True:
            _wake.wait(60)
            _wake.clear()
            try:
                sweep()
            except Exception:                      # noqa: BLE001 — a bad round must not stop the next
                log.exception("issues: sweep failed")
    threading.Thread(target=loop, name="issues-sync", daemon=True).start()


# ── GitHub → here ─────────────────────────────────────────────────────────────
@router.post("/api/github/webhook")
async def github_webhook(request: Request, x_hub_signature_256: str = Header(default=""),
                         x_github_event: str = Header(default="")):
    secret, gh = os.environ.get("GITHUB_WEBHOOK_SECRET", ""), _gh()
    if not secret or not gh:
        raise HTTPException(404, "GitHub 이슈 연동이 꺼져 있습니다.")
    raw = await request.body()
    want = "sha256=" + hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(want, x_hub_signature_256 or ""):
        raise HTTPException(401, "서명이 맞지 않습니다.")
    ev = json.loads(raw or b"{}")
    if ((ev.get("repository") or {}).get("full_name") or "").lower() != gh[1].lower():
        return {"ok": True, "skipped": "repository"}
    num, action = str((ev.get("issue") or {}).get("number") or ""), ev.get("action")
    with SessionLocal() as db:
        r = db.query(models.Report).filter(models.Report.ext_id == num).first() if num else None
        if not r:
            return {"ok": True, "skipped": "not ours"}
        if x_github_event == "issue_comment" and action == "created":
            c = ev.get("comment") or {}
            if MARK in (c.get("body") or "") or db.query(models.ReportComment).filter(
                    models.ReportComment.report_id == r.id, models.ReportComment.ext_id == str(c.get("id"))).first():
                return {"ok": True, "skipped": "ours"}
            db.add(models.ReportComment(report_id=r.id, author=str((c.get("user") or {}).get("login") or "?")[:80],
                                        origin="github", body=c.get("body") or "", ext_id=str(c.get("id"))))
        elif x_github_event == "issues" and action in ("closed", "reopened"):
            r.status = r.ext_state = "resolved" if action == "closed" else "open"
        else:
            return {"ok": True, "skipped": f"{x_github_event} {action}"}
        r.updated_at = models._now()
        db.commit()
    return {"ok": True}


# ── a paired sub → here (this is its main) ────────────────────────────────────
def _sha(tok: str) -> str:
    return hashlib.sha256(tok.encode()).hexdigest()


def _sub(authorization: Optional[str]) -> str:
    h = _sha(security.bearer(authorization) or "-")
    for s in _read().get("subs") or []:
        if secrets.compare_digest(s.get("hash", ""), h):
            return s["name"]
    raise HTTPException(401, "이슈 연결 토큰이 올바르지 않습니다.")


class RelayReport(BaseModel):
    id: int
    kind: str = "inquiry"
    subject: str = ""
    body: str = ""
    author: str = ""
    attachments: list[dict] = []


class RelayComment(BaseModel):
    id: int
    author: str = ""
    body: str = ""


class RelayState(BaseModel):
    resolved: bool = True


def _theirs(db, sub: str, rid: int) -> models.Report:
    r = db.get(models.Report, rid)
    if not r or r.origin != sub:
        raise HTTPException(404, "없음")
    return r


@router.post("/api/issues/relay/reports")
def relay_report(b: RelayReport, authorization: Optional[str] = Header(default=None)):
    sub = _sub(authorization)
    with SessionLocal() as db:
        r = db.query(models.Report).filter(models.Report.origin == sub, models.Report.origin_id == b.id).first()
        if not r:
            files = "".join(f"\n- [{str(a.get('name'))[:200]}]({str(a.get('url'))[:500]})"
                            for a in b.attachments[:10] if isinstance(a, dict))
            r = models.Report(user_id=0, kind=b.kind if b.kind in KINDS[:3] else "inquiry", subject=b.subject[:200],
                              body=b.body[:20000] + (f"\n\n첨부:{files}" if files else ""), author=b.author[:80],
                              origin=sub, origin_id=b.id)
            db.add(r)
            db.commit()
            kick()
        return {"id": r.id}


@router.post("/api/issues/relay/reports/{rid}/comments")
def relay_comment(rid: int, b: RelayComment, authorization: Optional[str] = Header(default=None)):
    sub = _sub(authorization)
    with SessionLocal() as db:
        r = _theirs(db, sub, rid)
        c = db.query(models.ReportComment).filter(models.ReportComment.report_id == r.id,
                                                  models.ReportComment.origin == sub,
                                                  models.ReportComment.origin_id == b.id).first()
        if not c:
            c = models.ReportComment(report_id=r.id, author=b.author[:80], origin=sub, origin_id=b.id, body=b.body[:20000])
            db.add(c)
            r.updated_at = models._now()
            db.commit()
            kick()
        return {"id": c.id}


@router.post("/api/issues/relay/reports/{rid}/state")
def relay_state(rid: int, b: RelayState, authorization: Optional[str] = Header(default=None)):
    sub = _sub(authorization)
    with SessionLocal() as db:
        r = _theirs(db, sub, rid)
        r.status = "resolved" if b.resolved else "open"
        db.commit()
        kick()
        return {"id": r.id, "status": r.status}


@router.get("/api/issues/relay/updates")
def relay_updates(after: int = 0, authorization: Optional[str] = Header(default=None)):
    """What the sub should take back: its reports' states and the comments on them it did not write."""
    sub = _sub(authorization)
    with SessionLocal() as db:
        rows = db.query(models.Report).filter(models.Report.origin == sub).all()
        ids = [r.id for r in rows]
        cs = (db.query(models.ReportComment).filter(models.ReportComment.report_id.in_(ids),
                                                    models.ReportComment.id > after)
              .order_by(models.ReportComment.id).all()) if ids else []
        return {"reports": [{"id": r.id, "status": r.status} for r in rows],
                "comments": [{"id": c.id, "report_id": c.report_id, "author": c.author,
                              "origin": c.origin or _server(), "body": c.body} for c in cs if c.origin != sub],
                "cursor": max([after] + [c.id for c in cs])}


# ── pairing (HANDSHAKE.md §4.1, portal-wide): sub asks with an address, main approves ──
class LinkAsk(BaseModel):
    from_url: str = ""
    from_name: str = ""
    by: str = ""


@router.post("/api/issues/link/requests", status_code=201)
def link_ask(b: LinkAsk):
    """Another portal asks to send its issues here. Open to anyone; grants nothing until an admin approves."""
    now, claim = time.time(), secrets.token_urlsafe(24)
    row = {"id": uuid.uuid4().hex[:12], "claim": claim, "status": "pending", "at": now,
           "from_url": b.from_url[:200], "from_name": b.from_name[:80], "by": b.by[:80]}

    def add(d):
        rows = [r for r in d.get("requests") or [] if now - r.get("at", 0) < sync.REQ_KEEP_S]
        if sum(r.get("status") == "pending" for r in rows) >= sync.REQ_MAX:
            raise HTTPException(429, "대기 중인 연결 요청이 너무 많습니다.")
        d["requests"] = rows + [row]
    _edit(add)
    return {"id": row["id"], "claim": claim, "pin": sync.pin(claim)}


@router.get("/api/issues/link/requests/{rid}")
def link_status(rid: str, claim: str = ""):
    out = {}

    def look(d):
        r = next((x for x in d.get("requests") or [] if x.get("id") == rid), None)
        if not r or not secrets.compare_digest(r.get("claim", ""), claim or ""):
            raise HTTPException(404, "요청을 찾을 수 없습니다 (만료되었을 수 있습니다).")
        out["status"] = r["status"]
        if r["status"] == "approved" and r.get("token"):
            out["token"] = r.pop("token")
            r["status"] = "delivered"
    _edit(look)
    return out


def _check_pending() -> None:
    p = _read().get("pending") or {}
    if p.get("status") != "pending":
        return
    try:
        r = httpx.get(f"{p['url']}/api/issues/link/requests/{p['id']}", params={"claim": p["claim"]}, headers=UA, timeout=5)
    except Exception:                              # noqa: BLE001 — main away: next time
        return
    if r.status_code == 404:
        st = {"status": "expired"}
    elif r.status_code == 200 and r.json().get("token"):
        st = {"status": "joined", "main": {"url": p["url"], "token": r.json()["token"]}}
    elif r.status_code == 200 and r.json().get("status") == "rejected":
        st = {"status": "rejected"}
    else:
        return

    def put(d):
        d["pending"] = {k: v for k, v in (d.get("pending") or {}).items() if k != "claim"} | {"status": st["status"]}
        if "main" in st:
            d["main"], d["cursor"] = st["main"], 0
    _edit(put)


# ── the admin's side ──────────────────────────────────────────────────────────
@router.get("/api/admin/issues")
def admin_state(_: models.User = Depends(require_portal_admin)):
    _check_pending()
    d, gh = _read(), _gh()
    return {"mode": mode(), "repo": gh[1] if gh else None, "webhook": bool(os.environ.get("GITHUB_WEBHOOK_SECRET")),
            "webhook_url": f"{config.BASE_URL}/api/github/webhook", "kinds": kinds(),
            "main": {"url": d["main"]["url"]} if _main() else None,
            "pending": {k: (d.get("pending") or {}).get(k) for k in ("url", "pin", "status")} if d.get("pending") else None,
            "requests": [{k: r.get(k) for k in ("id", "at", "from_url", "from_name", "by")} | {"pin": sync.pin(r["claim"])}
                         for r in d.get("requests") or [] if r.get("status") == "pending"],
            "subs": [{k: s.get(k) for k in ("name", "url", "at")} for s in d.get("subs") or []]}


class KindsBody(BaseModel):
    kinds: dict


@router.put("/api/admin/issues/kinds")
def admin_kinds(b: KindsBody, _: models.User = Depends(require_portal_admin)):
    _edit(lambda d: d.update(kinds={**kinds(), **{k: bool(v) for k, v in b.kinds.items() if k in KINDS}}))
    kick()
    return kinds()


class LinkDecide(BaseModel):
    action: str                     # approve | reject


@router.post("/api/admin/issues/requests/{rid}")
def admin_decide(rid: str, b: LinkDecide, _: models.User = Depends(require_portal_admin)):
    if b.action not in ("approve", "reject"):
        raise HTTPException(400, "action 은 approve 또는 reject 입니다.")

    def decide(d):
        r = next((x for x in d.get("requests") or [] if x.get("id") == rid and x.get("status") == "pending"), None)
        if not r:
            raise HTTPException(404, "대기 중인 요청이 아닙니다.")
        if b.action == "reject":
            r["status"] = "rejected"
            return
        names = {s["name"] for s in d.get("subs") or []}
        base = name = (r.get("from_name") or _host(r.get("from_url") or "") or "sub")[:70]
        n = 2
        while name in names:
            name, n = f"{base}-{n}", n + 1
        tok = sync.new_token()
        d["subs"] = (d.get("subs") or []) + [{"name": name, "url": r.get("from_url"), "hash": _sha(tok), "at": time.time()}]
        r.update(status="approved", token=tok)
    _edit(decide)
    return {"ok": True}


@router.delete("/api/admin/issues/subs/{name}")
def admin_drop_sub(name: str, _: models.User = Depends(require_portal_admin)):
    """That sub's token stops working; what it sent stays."""
    _edit(lambda d: d.update(subs=[s for s in d.get("subs") or [] if s.get("name") != name]))
    return {"ok": True}


class LinkRequest(BaseModel):
    url: str


@router.post("/api/admin/issues/link")
def admin_link(b: LinkRequest, user: models.User = Depends(require_portal_admin)):
    """This portal asks a main portal (an address) to take its issues. The pin shows on both screens."""
    url = b.url.strip().rstrip("/")
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "main 주소는 http(s):// 로 시작해야 합니다.")
    try:
        r = httpx.post(f"{url}/api/issues/link/requests", headers=UA, timeout=10,
                       json={"from_url": config.BASE_URL, "from_name": socket.gethostname(), "by": user.username})
        r.raise_for_status()
        got = r.json()
    except Exception as e:                         # noqa: BLE001
        raise HTTPException(502, f"main 에 닿지 않거나 요청을 받지 않습니다: {e}")
    _edit(lambda d: d.update(pending={"url": url, "id": got["id"], "claim": got["claim"], "pin": got["pin"],
                                      "status": "pending"}))
    return {"url": url, "pin": got["pin"], "status": "pending"}


@router.delete("/api/admin/issues/link")
def admin_unlink(_: models.User = Depends(require_portal_admin)):
    _edit(lambda d: [d.pop(k, None) for k in ("main", "pending", "cursor", "after_id")])
    return {"ok": True}


@router.post("/api/admin/issues/sync")
def admin_sync(_: models.User = Depends(require_portal_admin)):
    """One round now (what the minute timer does)."""
    return {"mode": sweep()}
