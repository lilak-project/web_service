"""
Feedback — bug reports, recommendations and inquiries.

Any signed-in user can file a report and follow its thread (comments + status).
Admins see everyone's reports, comment, and flip a report between open and
resolved. Kinds other than `local` travel upstream (routers/issues.py): to GitHub
on the main portal, to the main portal on a paired sub.
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


def _comments(db: Session, rid: int) -> list:
    rows = (db.query(models.ReportComment).filter(models.ReportComment.report_id == rid)
            .order_by(models.ReportComment.id).all())
    return [{"id": c.id, "author": c.author, "origin": c.origin, "body": c.body,
             "created_at": c.created_at.isoformat() if c.created_at else None} for c in rows]


def _view(db: Session, r: models.Report, with_user: bool = False) -> dict:
    from . import issues
    d = {
        "id": r.id, "kind": r.kind, "subject": r.subject, "body": r.body,
        "status": r.status, "comments": _comments(db, r.id),
        "attachments": json.loads(getattr(r, "attachments_json", None) or "[]"),
        "origin": r.origin or "", "upstream": issues.link_of(r),
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "updated_at": r.updated_at.isoformat() if r.updated_at else None,
    }
    if with_user:
        u = db.query(models.User).filter(models.User.id == r.user_id).first() if r.user_id else None
        d["username"] = u.username if u else (r.author or "(deleted)")
        d["user_shape"] = u.profile_shape if u else None
        d["user_color"] = u.profile_color if u else None
    return d


class ReportCreate(BaseModel):
    kind: str = "inquiry"
    subject: str = ""
    body: str = ""
    attachments: list[dict] = []        # files already uploaded through /api/chat/upload


_FILE_ID = re.compile(r"[0-9a-f]{32}(\.\w{1,8})?")


def _uploads() -> Path:
    return config.DATA_ROOT / "_portal" / "chat_uploads"


class ReplyBody(BaseModel):
    reply: str = ""


class CommentBody(BaseModel):
    body: str = ""


def add_comment(db: Session, r: models.Report, user: models.User, text: str) -> models.ReportComment:
    text = (text or "").strip()
    if not text:
        raise HTTPException(400, "내용을 입력하세요.")
    c = models.ReportComment(report_id=r.id, user_id=user.id, author=user.username, body=text[:20000])
    db.add(c)
    r.updated_at = models._now()
    db.commit()
    return c


class ResolveBody(BaseModel):
    resolved: bool = True


# ── user side ─────────────────────────────────────────────────────────────────
@router.post("/api/reports")
def create_report(body: ReportCreate, user: models.User = Depends(require_portal_user),
                  db: Session = Depends(get_db)):
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
                      attachments_json=json.dumps(atts, ensure_ascii=False))
    db.add(r)
    db.commit()
    db.refresh(r)
    _kick()
    return _view(db, r)


def _kick() -> None:
    from . import issues
    issues.kick()


@router.post("/api/reports/{rid}/comments")
def comment(rid: int, body: CommentBody, user: models.User = Depends(require_portal_user),
            db: Session = Depends(get_db)):
    """A comment in the thread: by its writer or an admin."""
    r = db.get(models.Report, rid)
    if not r or (r.user_id != user.id and not permissions.is_admin(user)):
        raise HTTPException(404, "없음")
    add_comment(db, r, user, body.body)
    _kick()
    db.refresh(r)
    return _view(db, r, with_user=permissions.is_admin(user))


@router.get("/api/reports/{rid}/files/{fid}")
def report_file(rid: int, fid: str, user: models.User = Depends(require_portal_user), db: Session = Depends(get_db)):
    """A file sent with a report: to its writer and to the admins."""
    r = db.get(models.Report, rid)
    if not r or (r.user_id != user.id and not permissions.is_admin(user)):
        raise HTTPException(404, "없음")
    hit = next((a for a in json.loads(r.attachments_json or "[]") if a.get("id") == fid), None)
    p = _uploads() / fid
    if not hit or not _FILE_ID.fullmatch(fid) or not p.is_file():
        raise HTTPException(404, "없음")
    return FileResponse(p, filename=hit.get("name") or fid)


@router.get("/api/reports/mine")
def my_reports(user: models.User = Depends(require_portal_user), db: Session = Depends(get_db)):
    rows = (db.query(models.Report).filter(models.Report.user_id == user.id)
            .order_by(models.Report.created_at.desc()).all())
    return [_view(db, r) for r in rows]


# ── admin side ────────────────────────────────────────────────────────────────
@router.get("/api/admin/reports")
def all_reports(status: Optional[str] = None, admin: models.User = Depends(require_portal_admin),
                db: Session = Depends(get_db)):
    q = db.query(models.Report)
    if status in ("open", "resolved"):
        q = q.filter(models.Report.status == status)
    rows = q.order_by(models.Report.status.asc(), models.Report.created_at.desc()).all()
    return [_view(db, r, with_user=True) for r in rows]


def _get(db: Session, rid: int) -> models.Report:
    r = db.query(models.Report).filter(models.Report.id == rid).first()
    if not r:
        raise HTTPException(404, "리포트를 찾을 수 없습니다.")
    return r


@router.post("/api/admin/reports/{rid}/reply")
def reply_report(rid: int, body: ReplyBody, admin: models.User = Depends(require_portal_admin),
                 db: Session = Depends(get_db)):
    """Kept for older clients: a reply is now one more comment."""
    r = _get(db, rid)
    add_comment(db, r, admin, body.reply)
    _kick()
    db.refresh(r)
    return _view(db, r, with_user=True)


@router.post("/api/admin/reports/{rid}/resolve")
def resolve_report(rid: int, body: ResolveBody, admin: models.User = Depends(require_portal_admin),
                   db: Session = Depends(get_db)):
    r = _get(db, rid)
    r.status = "resolved" if body.resolved else "open"
    db.commit()
    db.refresh(r)
    _kick()
    return _view(db, r, with_user=True)


@router.delete("/api/admin/reports/{rid}")
def delete_report(rid: int, admin: models.User = Depends(require_portal_admin),
                  db: Session = Depends(get_db)):
    r = _get(db, rid)
    db.query(models.ReportComment).filter(models.ReportComment.report_id == rid).delete()
    db.delete(r)       # its GitHub issue (if any) stays; it is public record there
    db.commit()
    return {"ok": True}
