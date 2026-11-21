"""
Issues — bug reports, recommendations, inquiries; shaped like GitHub issues so they travel 1:1.

Any signed-in user files an issue and follows its timeline (comments + events: closed with a reason,
reopened, labeled, renamed), edits what they wrote and deletes their own comments. Admins see every
issue, close it (completed | not planned) or reopen it, change its labels (the kind is one) and delete it.
Kinds other than `local` travel upstream (routers/issues.py): to GitHub on the main portal, to the main
portal on a paired sub. Status stays "open" | "resolved" (GitHub's closed), as older clients read it.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import config, models, permissions
from ..db import get_db
from ..deps import require_portal_admin, require_portal_user

router = APIRouter(tags=["reports"])

KINDS = {"bug", "recommendation", "inquiry", "local"}
REASONS = ("completed", "not_planned")


def _iso(t) -> Optional[str]:
    return t.isoformat() if t else None


# ── the state, changed the same way from the screen, GitHub, a sub or a main (callers commit) ──
def labels_of(r: models.Report) -> list:
    try:
        return list(json.loads(r.labels_json or "[]"))
    except ValueError:
        return []


def clean_labels(labels) -> list:
    out = []
    for x in labels or []:
        x = str(x).strip()[:50]
        if x and x not in out:
            out.append(x)
    return out[:20]


def event(db: Session, r: models.Report, kind: str, actor: str, detail: str = "") -> None:
    db.add(models.ReportEvent(report_id=r.id, kind=kind, actor=(actor or "")[:80], detail=(detail or "")[:200]))


def set_labels(db: Session, r: models.Report, labels, actor: str) -> bool:
    old, new = labels_of(r), clean_labels(labels)
    if old == new:
        return False
    for x in new:
        if x not in old:
            event(db, r, "labeled", actor, x)
    for x in old:
        if x not in new:
            event(db, r, "unlabeled", actor, x)
    r.labels_json = json.dumps(new, ensure_ascii=False)
    return True


def set_state(db: Session, r: models.Report, status: str, reason: Optional[str], actor: str) -> bool:
    reason = (reason if reason in REASONS else "completed") if status == "resolved" else None
    if (r.status, r.state_reason) == (status, reason):
        return False
    if status == "resolved":
        r.closed_by, r.closed_at = (actor or "")[:80], models._now()
        event(db, r, "closed", actor, reason)
    elif r.status == "resolved":
        event(db, r, "reopened", actor)
    r.status, r.state_reason = status, reason
    return True


def set_text(db: Session, r: models.Report, subject: Optional[str], body: Optional[str], actor: str) -> bool:
    changed = False
    if subject is not None and subject.strip()[:200] != (r.subject or ""):
        event(db, r, "renamed", actor, r.subject or "")
        r.subject, changed = subject.strip()[:200], True
    if body is not None and body.strip() != (r.body or ""):
        r.body, changed = body.strip(), True
    if changed:
        r.edited_at = models._now()
    return changed


# ── views ─────────────────────────────────────────────────────────────────────
def _timeline(db: Session, rid: int, me: Optional[int]) -> tuple:
    cs = (db.query(models.ReportComment).filter(models.ReportComment.report_id == rid,
                                                models.ReportComment.deleted.is_(False))
          .order_by(models.ReportComment.id).all())
    es = db.query(models.ReportEvent).filter(models.ReportEvent.report_id == rid).order_by(models.ReportEvent.id).all()
    return ([{"id": c.id, "author": c.author, "origin": c.origin, "body": c.body, "mine": bool(me and c.user_id == me),
              "created_at": _iso(c.created_at), "edited_at": _iso(c.edited_at)} for c in cs],
            [{"kind": e.kind, "actor": e.actor, "detail": e.detail, "created_at": _iso(e.created_at)} for e in es])


def _view(db: Session, r: models.Report, with_user: bool = False, me: Optional[int] = None) -> dict:
    from . import issues
    comments, events = _timeline(db, r.id, me)
    u = db.query(models.User).filter(models.User.id == r.user_id).first() if r.user_id else None
    d = {
        "id": r.id, "number": r.number, "kind": r.kind, "subject": r.subject, "body": r.body,
        "status": r.status, "state_reason": r.state_reason, "closed_by": r.closed_by, "closed_at": _iso(r.closed_at),
        "labels": labels_of(r), "comments": comments, "events": events,
        "attachments": json.loads(getattr(r, "attachments_json", None) or "[]"),
        "username": u.username if u else (r.author or "(deleted)"), "mine": bool(me and r.user_id == me),
        "origin": r.origin or "", "upstream": issues.link_of(r),
        "created_at": _iso(r.created_at), "updated_at": _iso(r.updated_at), "edited_at": _iso(r.edited_at),
    }
    if with_user:
        d["user_shape"] = u.profile_shape if u else None
        d["user_color"] = u.profile_color if u else None
    return d


class ReportCreate(BaseModel):
    kind: str = "inquiry"
    subject: str = ""
    body: str = ""
    attachments: list[dict] = []        # files already uploaded through /api/chat/upload


class ReportEdit(BaseModel):
    subject: Optional[str] = None
    body: Optional[str] = None


class ReplyBody(BaseModel):
    reply: str = ""


class CommentBody(BaseModel):
    body: str = ""


class ResolveBody(BaseModel):
    resolved: bool = True
    reason: str = "completed"           # completed | not_planned, as GitHub closes


class LabelsBody(BaseModel):
    labels: list[str] = []


_FILE_ID = re.compile(r"[0-9a-f]{32}(\.\w{1,8})?")


def _uploads() -> Path:
    return config.DATA_ROOT / "_portal" / "chat_uploads"


def _kick() -> None:
    from . import issues
    issues.kick()


def _mine_or_admin(db: Session, rid: int, user: models.User) -> models.Report:
    r = db.get(models.Report, rid)
    if not r or (r.user_id != user.id and not permissions.is_admin(user)):
        raise HTTPException(404, "없음")
    return r


def _done(db: Session, r: models.Report, user: models.User) -> dict:
    db.commit()
    db.refresh(r)
    _kick()
    return _view(db, r, with_user=permissions.is_admin(user), me=user.id)


def add_comment(db: Session, r: models.Report, user: models.User, text: str) -> models.ReportComment:
    text = (text or "").strip()
    if not text:
        raise HTTPException(400, "내용을 입력하세요.")
    c = models.ReportComment(report_id=r.id, user_id=user.id, author=user.username, body=text[:20000])
    db.add(c)
    r.updated_at = models._now()
    return c


# ── anyone signed in ──────────────────────────────────────────────────────────
@router.post("/api/reports")
def create_report(body: ReportCreate, user: models.User = Depends(require_portal_user),
                  db: Session = Depends(get_db)):
    from . import issues
    kind = body.kind if body.kind in KINDS else "inquiry"
    subject = (body.subject or "").strip()
    text = (body.body or "").strip()
    if not subject and not text:
        raise HTTPException(400, "내용을 입력하세요.")
    # Only files that are there: an id is not a way to point at anything else.
    atts = [{"id": str(a["id"]), "name": str(a.get("name") or a["id"])[:200], "type": str(a.get("type") or "")[:100],
             "size": int(a.get("size") or 0)}
            for a in (body.attachments or [])[:10]
            if isinstance(a, dict) and _FILE_ID.fullmatch(str(a.get("id", ""))) and (_uploads() / str(a["id"])).is_file()]
    r = models.Report(user_id=user.id, kind=kind, subject=subject[:200], body=text,
                      labels_json=json.dumps([kind, f"server:{issues.server_name()}"], ensure_ascii=False),
                      attachments_json=json.dumps(atts, ensure_ascii=False))
    db.add(r)
    return _done(db, r, user)


@router.put("/api/reports/{rid}")
def edit_report(rid: int, body: ReportEdit, user: models.User = Depends(require_portal_user),
                db: Session = Depends(get_db)):
    """Its title and body: by its writer or an admin."""
    r = _mine_or_admin(db, rid, user)
    if set_text(db, r, body.subject, body.body, user.username):
        r.ext_dirty = True
    return _done(db, r, user)


@router.post("/api/reports/{rid}/comments")
def comment(rid: int, body: CommentBody, user: models.User = Depends(require_portal_user),
            db: Session = Depends(get_db)):
    """A comment in the timeline: by its writer or an admin."""
    r = _mine_or_admin(db, rid, user)
    add_comment(db, r, user, body.body)
    return _done(db, r, user)


def _comment(db: Session, rid: int, cid: int, user: models.User) -> tuple:
    r = _mine_or_admin(db, rid, user)
    c = db.get(models.ReportComment, cid)
    if not c or c.report_id != r.id or c.deleted:
        raise HTTPException(404, "없음")
    return r, c


@router.put("/api/reports/{rid}/comments/{cid}")
def edit_comment(rid: int, cid: int, body: CommentBody, user: models.User = Depends(require_portal_user),
                 db: Session = Depends(get_db)):
    """Only its writer edits a comment, as on GitHub."""
    r, c = _comment(db, rid, cid, user)
    if c.user_id != user.id:
        raise HTTPException(403, "자기 댓글만 고칠 수 있습니다.")
    text = (body.body or "").strip()
    if not text:
        raise HTTPException(400, "내용을 입력하세요.")
    if text != c.body:
        c.body, c.edited_at, c.ext_dirty = text[:20000], models._now(), True
    return _done(db, r, user)


@router.delete("/api/reports/{rid}/comments/{cid}")
def delete_comment(rid: int, cid: int, user: models.User = Depends(require_portal_user),
                   db: Session = Depends(get_db)):
    """Its writer or an admin. Kept as a tombstone so the deletion goes upstream too."""
    r, c = _comment(db, rid, cid, user)
    if c.user_id != user.id and not permissions.is_admin(user):
        raise HTTPException(403, "자기 댓글만 지울 수 있습니다.")
    c.deleted, c.body, c.ext_dirty = True, "", bool(c.ext_id)
    return _done(db, r, user)


@router.get("/api/reports/{rid}/files/{fid}")
def report_file(rid: int, fid: str, user: models.User = Depends(require_portal_user), db: Session = Depends(get_db)):
    """A file sent with a report: to its writer and to the admins."""
    r = _mine_or_admin(db, rid, user)
    hit = next((a for a in json.loads(r.attachments_json or "[]") if a.get("id") == fid), None)
    p = _uploads() / fid
    if not hit or not _FILE_ID.fullmatch(fid) or not p.is_file():
        raise HTTPException(404, "없음")
    return FileResponse(p, filename=hit.get("name") or fid)


@router.get("/api/reports/mine")
def my_reports(user: models.User = Depends(require_portal_user), db: Session = Depends(get_db)):
    rows = (db.query(models.Report).filter(models.Report.user_id == user.id)
            .order_by(models.Report.created_at.desc()).all())
    return [_view(db, r, me=user.id) for r in rows]


# ── admins ────────────────────────────────────────────────────────────────────
@router.get("/api/admin/reports")
def all_reports(status: Optional[str] = None, admin: models.User = Depends(require_portal_admin),
                db: Session = Depends(get_db)):
    q = db.query(models.Report)
    if status in ("open", "resolved"):
        q = q.filter(models.Report.status == status)
    rows = q.order_by(models.Report.status.asc(), models.Report.created_at.desc()).all()
    return [_view(db, r, with_user=True, me=admin.id) for r in rows]


def _get(db: Session, rid: int) -> models.Report:
    r = db.get(models.Report, rid)
    if not r:
        raise HTTPException(404, "리포트를 찾을 수 없습니다.")
    return r


@router.post("/api/admin/reports/{rid}/reply")
def reply_report(rid: int, body: ReplyBody, admin: models.User = Depends(require_portal_admin),
                 db: Session = Depends(get_db)):
    """Kept for older clients: a reply is one more comment."""
    r = _get(db, rid)
    add_comment(db, r, admin, body.reply)
    return _done(db, r, admin)


@router.post("/api/admin/reports/{rid}/resolve")
def resolve_report(rid: int, body: ResolveBody, admin: models.User = Depends(require_portal_admin),
                   db: Session = Depends(get_db)):
    """Close (with a reason) or reopen."""
    r = _get(db, rid)
    if body.resolved and body.reason not in REASONS:
        raise HTTPException(400, "reason 은 completed 또는 not_planned 입니다.")
    if set_state(db, r, "resolved" if body.resolved else "open", body.reason, admin.username):
        r.ext_dirty = True
    return _done(db, r, admin)


@router.put("/api/admin/reports/{rid}/labels")
def put_labels(rid: int, body: LabelsBody, admin: models.User = Depends(require_portal_admin),
               db: Session = Depends(get_db)):
    r = _get(db, rid)
    if set_labels(db, r, body.labels, admin.username):
        r.ext_dirty = True
    return _done(db, r, admin)


@router.delete("/api/admin/reports/{rid}")
def delete_report(rid: int, admin: models.User = Depends(require_portal_admin),
                  db: Session = Depends(get_db)):
    r = _get(db, rid)
    db.query(models.ReportComment).filter(models.ReportComment.report_id == rid).delete()
    db.query(models.ReportEvent).filter(models.ReportEvent.report_id == rid).delete()
    db.delete(r)       # its GitHub issue (if any) stays; it is public record there
    db.commit()
    return {"ok": True}
