"""
The portal's issues (routers/reports.py) kept 1:1 with upstream, both ways.

main portal (GITHUB_ISSUES_TOKEN + GITHUB_ISSUES_REPO set): each issue whose kind goes up becomes a GitHub
  issue with the same title, body, labels and state (closed with its reason); comments, comment edits and
  deletions follow. GitHub answers through the webhook (POST /api/github/webhook, signed with
  GITHUB_WEBHOOK_SECRET): issues opened, edited, closed, reopened, labeled, unlabeled and comments created,
  edited, deleted there land here (shown under the GitHub login).
sub portal (no GitHub token): paired with a main portal the HANDSHAKE.md way (address in, main's admin
  approves after matching the pin, the sub collects its token once) and relays to it (/api/issues/relay/*);
  every minute it pulls main's side back (state, labels, text, GitHub numbers, comments). Main never has to
  reach a sub.

Nothing goes twice: an issue remembers its id upstream (ext_id) and whether it changed here since
(ext_dirty: the next sweep sends its whole state, as one GitHub PATCH); a comment its id upstream, a
deletion stays as a tombstone until sent. Where both sides changed, this side's unsent change wins. What we
post to GitHub carries MARK, so its webhook echo is recognised and our prefix is taken off what comes back.
Public repository: a post names only the writer's portal name and the server, never an e-mail or account
detail; attachments go as portal links. Assignees are left out: portal accounts are not tied to GitHub ones.

Only issues filed after the link was first made go up (after_id): the older ones were written for this
portal's admins, not for a public repository. Kinds: bug, recommendation, inquiry go up by default, local
never; an admin changes that (data/_portal/issues.json, which also holds the pairing). Nothing configured:
every sweep returns at once.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import socket
import threading
import time
import uuid
from datetime import datetime
from typing import Optional
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import func

from .. import config, models, registry, security, sync
from ..db import SessionLocal
from ..deps import require_portal_admin
from . import reports as rp

router = APIRouter(tags=["issues"])
log = logging.getLogger("issues")
FILE = config.DATA_ROOT / "_portal" / "issues.json"
MARK = "<!-- lilak-portal -->"
FILES = "<!-- lilak-files -->"
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


def accepts_external() -> bool:
    """Issues opened on GitHub itself (by anyone: the repository is public) come in as reports with
    origin 'github'. An admin can turn that off; what came in before stays."""
    return bool(_read().get("accept_external", True))


def kinds() -> dict:
    k = _read().get("kinds") or {}
    return {x: bool(k.get(x, DEFAULT_KINDS[x])) for x in KINDS}


def _host(url: str) -> str:
    return urlsplit(url).hostname or url


def server_name() -> str:
    return _host(config.BASE_URL) if "localhost" not in config.BASE_URL else socket.gethostname()


def link_of(r: models.Report) -> Optional[dict]:
    """Where an issue lives upstream, for the screen."""
    m = mode()
    if m == "github" and r.ext_id:
        return {"where": "github", "id": r.ext_id, "url": f"https://github.com/{_gh()[1]}/issues/{r.ext_id}"}
    if m == "sub" and r.ext_id:
        return {"where": _host(_main()["url"]), "id": r.ext_id, "url": _main()["url"]}
    return None


# ── what GitHub shows, and taking it off again ───────────────────────────────
def _who(db, r: models.Report) -> str:
    if r.origin:
        return r.author or "?"
    u = db.get(models.User, r.user_id) if r.user_id else None
    return u.username if u else (r.author or "?")


def _files(r: models.Report) -> str:
    atts = json.loads(r.attachments_json or "[]")
    return "".join(f"\n- [{a.get('name')}]({config.BASE_URL}/api/reports/{r.id}/files/{a.get('id')})" for a in atts)


def _post_text(who: str, where: str, body: str, files: str = "") -> str:
    tail = f"\n\n{FILES}\n첨부 (포털 로그인 필요):{files}" if files else ""
    return f"**{who}** ({where}):\n\n{body}{tail}\n\n{MARK}"


_PREFIX = re.compile(r"^\*\*[^*\n]+\*\* \([^)\n]*\):\n\n")


def strip_post(text: str) -> str:
    """GitHub's text without what _post_text put around it."""
    text = (text or "").replace("\r\n", "\n")
    ours = MARK in text
    text = text.split(FILES)[0].replace(MARK, "").strip()
    text = _PREFIX.sub("", text, count=1).strip() if ours else text
    return "" if text == "—" else text                 # what an empty body is sent as


# ── the sweep: send what is new or changed, then (a sub) take main's side back ──
_wake = threading.Event()
_sweeping = threading.Lock()


def kick() -> None:
    """Something changed: sweep now rather than at the next minute."""
    _wake.set()


class _GitHub:
    def __init__(self, token: str, repo: str):
        self.c = httpx.Client(base_url=f"https://api.github.com/repos/{repo}", timeout=20, headers={
            "Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28", **UA})

    def _send(self, method, path, body=None) -> dict:
        r = self.c.request(method, path, json=body)
        r.raise_for_status()
        return r.json() if r.content else {}

    def _issue(self, db, r) -> dict:
        return {"title": r.subject or (r.body or "")[:60] or f"#{r.id}",
                "body": _post_text(_who(db, r), r.origin or server_name(), r.body or "—", "" if r.origin else _files(r)),
                "labels": rp.labels_of(r)}

    def open(self, db, r) -> tuple:
        n = self._send("POST", "/issues", self._issue(db, r))["number"]
        return n, n

    def update(self, db, r) -> None:
        body = self._issue(db, r)
        closed = r.status == "resolved"
        body |= {"state": "closed" if closed else "open"} | ({"state_reason": r.state_reason or "completed"} if closed else {})
        self._send("PATCH", f"/issues/{r.ext_id}", body)

    def _comment_text(self, c) -> str:
        return _post_text(c.author, c.origin if c.origin not in ("", "github") else server_name(), c.body)

    def comment(self, db, r, c):
        return self._send("POST", f"/issues/{r.ext_id}/comments", {"body": self._comment_text(c)})["id"]

    def edit_comment(self, r, c) -> None:
        self._send("PATCH", f"/issues/comments/{c.ext_id}", {"body": self._comment_text(c)})

    def delete_comment(self, r, c) -> None:
        try:
            self._send("DELETE", f"/issues/comments/{c.ext_id}")
        except httpx.HTTPStatusError as e:
            if e.response.status_code != 404:    # already gone there
                raise


class _Main:
    def __init__(self, m: dict):
        self.name = _host(m["url"])
        self.c = httpx.Client(base_url=m["url"].rstrip("/") + "/api/issues/relay", timeout=20,
                              headers={"Authorization": f"Bearer {m['token']}", **UA})

    def _send(self, method, path, body=None, **kw) -> dict:
        r = self.c.request(method, path, json=body, **kw)
        r.raise_for_status()
        return r.json()

    def _state(self, r) -> dict:
        return {"subject": r.subject, "body": r.body, "status": r.status, "state_reason": r.state_reason,
                "labels": rp.labels_of(r)}

    def open(self, db, r) -> tuple:
        atts = [{"name": a.get("name"), "url": f"{config.BASE_URL}/api/reports/{r.id}/files/{a.get('id')}"}
                for a in json.loads(r.attachments_json or "[]")]
        got = self._send("POST", "/reports", {"id": r.id, "kind": r.kind, "author": _who(db, r), "attachments": atts,
                                              **self._state(r)})
        return got["id"], got.get("number")

    def update(self, db, r) -> None:
        self._send("PUT", f"/reports/{r.ext_id}", {**self._state(r), "by": _who(db, r)})

    def comment(self, db, r, c):
        return self._send("POST", f"/reports/{r.ext_id}/comments", {"id": c.id, "author": c.author, "body": c.body})["id"]

    def edit_comment(self, r, c) -> None:
        self._send("PUT", f"/reports/{r.ext_id}/comments/{c.ext_id}", {"id": c.id, "author": c.author, "body": c.body})

    def delete_comment(self, r, c) -> None:
        self._send("DELETE", f"/reports/{r.ext_id}/comments/{c.ext_id}")

    def updates(self, since: str) -> dict:
        return self._send("GET", "/updates", params={"since": since})


def _push(db, up, goes: dict, after_id: int = 0) -> None:
    # ponytail: looks at every issue each sweep; filter by updated_at once there are thousands.
    # A request that reached upstream but whose answer was lost is sent again next sweep (a duplicate there).
    for r in db.query(models.Report).order_by(models.Report.id).all():
        try:
            if not r.ext_id:
                if r.id <= after_id or not goes.get(r.kind, r.kind != "local"):
                    continue
                ext, num = up.open(db, r)
                r.ext_id, r.number = str(ext), num
                r.ext_dirty = r.status != "open"         # opening cannot close; the update after it does
                db.commit()
            for c in (db.query(models.ReportComment).filter(models.ReportComment.report_id == r.id)
                      .filter((models.ReportComment.ext_id.is_(None)) | (models.ReportComment.ext_dirty.is_(True)))
                      .order_by(models.ReportComment.id).all()):
                if c.deleted:
                    if c.ext_id:
                        up.delete_comment(r, c)
                elif not c.ext_id:
                    c.ext_id = str(up.comment(db, r, c))
                else:
                    up.edit_comment(r, c)
                c.ext_dirty = False
                db.commit()
            if r.ext_dirty:
                up.update(db, r)
                r.ext_dirty = False
                db.commit()
        except Exception as e:                     # noqa: BLE001 — the next sweep tries again
            db.rollback()
            log.warning("issues: report %s not sent: %s", r.id, e)


def apply_state(db, r: models.Report, x: dict, actor: str) -> None:
    """Upstream's state of an issue, unless this side has a change of its own not yet sent."""
    if r.ext_dirty:
        return
    rp.set_text(db, r, x.get("subject"), x.get("body"), actor)
    if x.get("status") in ("open", "resolved"):
        rp.set_state(db, r, x["status"], x.get("state_reason"), x.get("closed_by") or actor)
    if isinstance(x.get("labels"), list):
        rp.set_labels(db, r, x["labels"], actor)


def apply_comment(db, r: models.Report, ext_id: str, author: str, origin: str, body: str, deleted: bool) -> None:
    """Create, edit or delete the comment upstream knows as ext_id."""
    c = db.query(models.ReportComment).filter(models.ReportComment.report_id == r.id,
                                              models.ReportComment.ext_id == ext_id).first()
    if c and c.ext_dirty:
        return
    if deleted:
        if c:
            c.deleted, c.body = True, ""
    elif not c:
        db.add(models.ReportComment(report_id=r.id, author=author[:80], origin=origin[:80], body=body, ext_id=ext_id))
    elif c.body != body:
        c.body, c.edited_at = body, models._now()


def _pull(db, up: _Main) -> None:
    since = _read().get("since") or ""
    u = up.updates(since)
    mine = {r.ext_id: r for r in db.query(models.Report).filter(models.Report.ext_id.isnot(None))}
    for x in u.get("reports") or []:
        r = mine.get(str(x.get("id")))
        if not r and x.get("external"):             # opened on GitHub: made here as it is there
            if not accepts_external():
                continue
            r = models.Report(user_id=0, kind=x.get("kind") if x.get("kind") in KINDS else "inquiry",
                              subject=str(x.get("subject") or "")[:200], body=str(x.get("body") or ""),
                              author=str(x.get("author") or "?")[:80], origin="github", ext_id=str(x["id"]),
                              labels_json=json.dumps(rp.clean_labels(x.get("labels") or []), ensure_ascii=False))
            db.add(r)
            db.flush()
            mine[r.ext_id] = r
        if r:
            r.number = x.get("number") or r.number
            apply_state(db, r, x, up.name)
    for c in u.get("comments") or []:
        r = mine.get(str(c.get("report_id")))
        if r:
            apply_comment(db, r, str(c["id"]), str(c.get("author") or ""), str(c.get("origin") or up.name),
                          str(c.get("body") or ""), bool(c.get("deleted")))
    db.commit()
    if u.get("cursor") and u["cursor"] != since:
        _edit(lambda d: d.update(since=u["cursor"]))


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
def _import(db, issue: dict) -> None:
    """An issue opened on GitHub itself becomes one here (never sent back: it has its ext_id)."""
    labels = [str(x.get("name")) for x in issue.get("labels") or [] if isinstance(x, dict)]
    r = models.Report(user_id=0, kind=next((k for k in KINDS[:3] if k in labels), "inquiry"),
                      subject=str(issue.get("title") or "")[:200], body=strip_post(issue.get("body") or ""),
                      author=str((issue.get("user") or {}).get("login") or "?")[:80], origin="github",
                      ext_id=str(issue["number"]), number=issue["number"],
                      labels_json=json.dumps(rp.clean_labels(labels), ensure_ascii=False))
    db.add(r)


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
    issue, action = ev.get("issue") or {}, ev.get("action")
    if issue.get("pull_request"):
        return {"ok": True, "skipped": "pull request"}
    num, actor = str(issue.get("number") or ""), str((ev.get("sender") or {}).get("login") or "github")
    with SessionLocal() as db:
        r = db.query(models.Report).filter(models.Report.ext_id == num).first() if num else None
        if x_github_event == "issues" and action == "opened":
            if r or MARK in (issue.get("body") or ""):
                return {"ok": True, "skipped": "ours"}            # one we opened; its number is recorded
            if not accepts_external():
                return {"ok": True, "skipped": "external issues are off"}
            _import(db, issue)
        elif not r:
            return {"ok": True, "skipped": "not ours"}
        elif x_github_event == "issues" and action in ("edited", "closed", "reopened", "labeled", "unlabeled"):
            apply_state(db, r, {"subject": issue.get("title"), "body": strip_post(issue.get("body") or ""),
                                "status": "resolved" if issue.get("state") == "closed" else "open",
                                "state_reason": issue.get("state_reason"),
                                "labels": [x.get("name") for x in issue.get("labels") or [] if isinstance(x, dict)]},
                        actor)
        elif x_github_event == "issue_comment" and action in ("created", "edited", "deleted"):
            c = ev.get("comment") or {}
            if action == "created" and MARK in (c.get("body") or ""):
                return {"ok": True, "skipped": "ours"}            # its id is recorded when we sent it
            known = db.query(models.ReportComment).filter(models.ReportComment.report_id == r.id,
                                                          models.ReportComment.ext_id == str(c.get("id"))).first()
            apply_comment(db, r, str(c.get("id")), str((c.get("user") or {}).get("login") or "?"),
                          known.origin if known else "github", strip_post(c.get("body") or ""), action == "deleted")
        else:
            return {"ok": True, "skipped": f"{x_github_event} {action}"}
        if r:
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


class RelayState(BaseModel):
    subject: Optional[str] = None
    body: Optional[str] = None
    status: Optional[str] = None
    state_reason: Optional[str] = None
    labels: Optional[list] = None
    by: str = ""


class RelayReport(RelayState):
    id: int
    kind: str = "inquiry"
    author: str = ""
    attachments: list[dict] = []


class RelayComment(BaseModel):
    id: int
    author: str = ""
    body: str = ""


def _theirs(db, sub: str, rid: int) -> models.Report:
    """An issue the sub may act on: its own, or an external one (opened on GitHub), which every sub sees."""
    r = db.get(models.Report, rid)
    if not r or r.origin not in (sub, "github"):
        raise HTTPException(404, "없음")
    return r


def _their_comment(db, sub: str, rid: int, cid: int) -> tuple:
    r = _theirs(db, sub, rid)
    c = db.get(models.ReportComment, cid)
    if not c or c.report_id != r.id or c.origin != sub:
        raise HTTPException(404, "없음")
    return r, c


def _actor(sub: str, who: str) -> str:
    return f"{who[:60]} ({sub})" if who else sub


@router.post("/api/issues/relay/reports")
def relay_report(b: RelayReport, authorization: Optional[str] = Header(default=None)):
    sub = _sub(authorization)
    with SessionLocal() as db:
        r = db.query(models.Report).filter(models.Report.origin == sub, models.Report.origin_id == b.id).first()
        if not r:
            files = "".join(f"\n- [{str(a.get('name'))[:200]}]({str(a.get('url'))[:500]})"
                            for a in b.attachments[:10] if isinstance(a, dict))
            r = models.Report(user_id=0, kind=b.kind if b.kind in KINDS[:3] else "inquiry",
                              subject=(b.subject or "")[:200], body=(b.body or "")[:20000] + (f"\n\n첨부:{files}" if files else ""),
                              author=b.author[:80], origin=sub, origin_id=b.id,
                              labels_json=json.dumps(rp.clean_labels(b.labels or [b.kind]), ensure_ascii=False))
            db.add(r)
            db.flush()
            if b.status == "resolved":
                rp.set_state(db, r, "resolved", b.state_reason, _actor(sub, b.author))
            db.commit()
            kick()
        return {"id": r.id, "number": r.number}


@router.put("/api/issues/relay/reports/{rid}")
def relay_update(rid: int, b: RelayState, authorization: Optional[str] = Header(default=None)):
    """The sub's whole state of one of its issues; what changed goes on to GitHub."""
    sub = _sub(authorization)
    with SessionLocal() as db:
        r = _theirs(db, sub, rid)
        actor = _actor(sub, b.by)
        # an external issue's words are its GitHub author's: a sub never rewrites them
        changed = rp.set_text(db, r, b.subject, b.body, actor) if r.origin != "github" else False
        if b.status in ("open", "resolved"):
            changed = rp.set_state(db, r, b.status, b.state_reason, actor) or changed
        if b.labels is not None:
            changed = rp.set_labels(db, r, b.labels, actor) or changed
        if changed:
            r.ext_dirty = True
            db.commit()
            kick()
        return {"id": r.id, "status": r.status}


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


@router.put("/api/issues/relay/reports/{rid}/comments/{cid}")
def relay_edit_comment(rid: int, cid: int, b: RelayComment, authorization: Optional[str] = Header(default=None)):
    sub = _sub(authorization)
    with SessionLocal() as db:
        _, c = _their_comment(db, sub, rid, cid)
        if not c.deleted and c.body != b.body[:20000]:
            c.body, c.edited_at, c.ext_dirty = b.body[:20000], models._now(), bool(c.ext_id)
            db.commit()
            kick()
        return {"id": c.id}


@router.delete("/api/issues/relay/reports/{rid}/comments/{cid}")
def relay_delete_comment(rid: int, cid: int, authorization: Optional[str] = Header(default=None)):
    sub = _sub(authorization)
    with SessionLocal() as db:
        _, c = _their_comment(db, sub, rid, cid)
        if not c.deleted:
            c.deleted, c.body, c.ext_dirty = True, "", bool(c.ext_id)
            db.commit()
            kick()
        return {"ok": True}


@router.get("/api/issues/relay/updates")
def relay_updates(since: str = "", authorization: Optional[str] = Header(default=None)):
    """What the sub takes back: the whole state of its issues and of the external ones (opened on GitHub, so
    every portal sees them; `external` tells the sub to make one it does not have), and the comments on them
    changed since `since` (deletions included; its own come back too, matched there by id, so a deletion on
    GitHub reaches it)."""
    sub = _sub(authorization)
    try:
        t = datetime.fromisoformat(since) if since else None
    except ValueError:
        t = None
    with SessionLocal() as db:
        rows = db.query(models.Report).filter(models.Report.origin.in_((sub, "github"))).all()
        ids = [r.id for r in rows]
        q = db.query(models.ReportComment).filter(models.ReportComment.report_id.in_(ids))
        cs = (q.filter(models.ReportComment.updated_at >= t) if t else q).order_by(models.ReportComment.id).all() if ids else []
        return {"reports": [{"id": r.id, "number": r.number, "subject": r.subject, "body": r.body, "status": r.status,
                             "state_reason": r.state_reason, "closed_by": r.closed_by, "labels": rp.labels_of(r)}
                            | ({"external": True, "kind": r.kind, "author": r.author} if r.origin == "github" else {})
                            for r in rows],
                "comments": [{"id": c.id, "report_id": c.report_id, "author": c.author, "body": c.body,
                              "origin": c.origin or server_name(), "deleted": bool(c.deleted)} for c in cs],
                "cursor": max([c.updated_at for c in cs if c.updated_at], default=t).isoformat() if (cs or t) else ""}


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
        if r["status"] == "pending":         # held by this side's manager: the opinions, for the asker to read
            from .. import held
            h = held.get(held.pid("issues", str(rid)))
            out.update(held=h["held"], comments=h["comments"])
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
    elif r.status_code == 200 and (r.json().get("held"), r.json().get("comments") or []) != (p.get("held"), p.get("comments") or []):
        got = r.json()                         # still waiting, with main's opinion: kept to show beside the request
        _edit(lambda d: d["pending"].update(held=bool(got.get("held")), comments=got.get("comments") or []))
        return
    else:
        return

    def put(d):
        d["pending"] = {k: v for k, v in (d.get("pending") or {}).items() if k != "claim"} | {"status": st["status"]}
        if "main" in st:
            d["main"], d["since"] = st["main"], ""
    _edit(put)


# ── the admin's side ──────────────────────────────────────────────────────────
@router.get("/api/admin/issues")
def admin_state(_: models.User = Depends(require_portal_admin)):
    _check_pending()
    d, gh = _read(), _gh()
    return {"mode": mode(), "repo": gh[1] if gh else None, "webhook": bool(os.environ.get("GITHUB_WEBHOOK_SECRET")),
            "webhook_url": f"{config.BASE_URL}/api/github/webhook", "kinds": kinds(),
            "accept_external": accepts_external(),
            "main": {"url": d["main"]["url"]} if _main() else None,
            "pending": {k: (d.get("pending") or {}).get(k) for k in ("url", "pin", "status", "held", "comments")} if d.get("pending") else None,
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


class ExternalBody(BaseModel):
    accept: bool


@router.put("/api/admin/issues/external")
def admin_external(b: ExternalBody, _: models.User = Depends(require_portal_admin)):
    """Take in issues opened on GitHub itself, or not."""
    _edit(lambda d: d.update(accept_external=bool(b.accept)))
    return {"accept_external": accepts_external()}


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
        names = {s["name"] for s in d.get("subs") or []} | {"github", ""}
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
    _edit(lambda d: [d.pop(k, None) for k in ("main", "pending", "since", "after_id")])
    return {"ok": True}


@router.post("/api/admin/issues/sync")
def admin_sync(_: models.User = Depends(require_portal_admin)):
    """One round now (what the minute timer does)."""
    return {"mode": sweep()}
