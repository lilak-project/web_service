"""
Feedback — bug reports, recommendations and inquiries.

Any signed-in user can file a report and see the thread of their own reports
(with the admin's reply + status). Admins see everyone's reports, can reply, and
can flip a report between open and resolved.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import models
from ..db import get_db
from ..deps import require_portal_admin, require_portal_user

router = APIRouter(tags=["reports"])

KINDS = {"bug", "recommendation", "inquiry"}


def _view(db: Session, r: models.Report, with_user: bool = False) -> dict:
    d = {
        "id": r.id, "kind": r.kind, "subject": r.subject, "body": r.body,
        "status": r.status, "reply": r.reply,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "updated_at": r.updated_at.isoformat() if r.updated_at else None,
    }
    if with_user:
        u = db.query(models.User).filter(models.User.id == r.user_id).first()
        d["username"] = u.username if u else "(deleted)"
        d["user_shape"] = u.profile_shape if u else None
        d["user_color"] = u.profile_color if u else None
    return d


class ReportCreate(BaseModel):
    kind: str = "inquiry"
    subject: str = ""
    body: str = ""


class ReplyBody(BaseModel):
    reply: str = ""


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
    r = models.Report(user_id=user.id, kind=kind, subject=subject[:200], body=text)
    db.add(r)
    db.commit()
    db.refresh(r)
    return _view(db, r)


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
    r = _get(db, rid)
    r.reply = (body.reply or "").strip() or None
    db.commit()
    db.refresh(r)
    return _view(db, r, with_user=True)


@router.post("/api/admin/reports/{rid}/resolve")
def resolve_report(rid: int, body: ResolveBody, admin: models.User = Depends(require_portal_admin),
                   db: Session = Depends(get_db)):
    r = _get(db, rid)
    r.status = "resolved" if body.resolved else "open"
    db.commit()
    db.refresh(r)
    return _view(db, r, with_user=True)


@router.delete("/api/admin/reports/{rid}")
def delete_report(rid: int, admin: models.User = Depends(require_portal_admin),
                  db: Session = Depends(get_db)):
    r = _get(db, rid)
    db.delete(r)
    db.commit()
    return {"ok": True}
