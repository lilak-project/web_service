"""
Accounts + invite codes.

- Invite codes (admin): generate a redeemable code that grants a service / single
  project without admin approval. Default 1-day expiry, max 7. Reusable until it
  expires or is revoked.
- Redeem (any signed-in user, and at signup): exchange a code for the permission.
- Account self-service: change password, request an email change (admin-gated),
  (temp) re-verify email, delete own account.
- Admin over everyone: set password, force-verify, approve email change, delete.

Email verification expires yearly (permissions.verification_current); while real
email isn't wired, "verify" is a trusted local stub that stamps email_verified_at.
"""
from __future__ import annotations

import re
import secrets
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import config, models, permissions, registry, security
from ..db import get_db
from ..deps import require_portal_admin, require_portal_user
from ..models import VERIFY_VALID_DAYS

router = APIRouter(tags=["accounts"])
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


# ── Invite codes (project OR group; custom or generated; admin-managed) ───────
_CODE_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


def _code_status(c: models.InviteCode) -> str:
    if not c.active:
        return "revoked"
    if c.expires_at < datetime.utcnow():
        return "expired"
    if c.max_uses and c.uses >= c.max_uses:
        return "used"
    return "active"


def _group_name(db: Session, gid) -> Optional[str]:
    if not gid:
        return None
    g = db.query(models.Group).filter(models.Group.id == gid).first()
    return g.name if g else None


def _invite_view(db: Session, c: models.InviteCode) -> dict:
    return {"id": c.id, "code": c.code, "kind": c.kind,
            "service": c.service_name or None, "project": c.project or None,
            "group_id": c.group_id, "group": _group_name(db, c.group_id),
            "expires_at": c.expires_at.isoformat(), "uses": c.uses,
            "max_uses": c.max_uses, "no_verify": bool(getattr(c, "no_verify", False)),
            "status": _code_status(c)}


class InviteCreate(BaseModel):
    kind: str = "project"               # "project" | "group"
    service: Optional[str] = None       # project codes
    project: Optional[str] = ""
    group_id: Optional[int] = None      # group codes
    days: int = 7
    code: Optional[str] = None          # admin-chosen (≥8 chars); else generated
    max_uses: int = 0                   # 0 = unlimited; 1 = single-use; N = N
    count: int = 1                      # bulk: generate this many codes at once
    no_verify: bool = False             # signup with this code skips email verification


@router.post("/api/admin/invite-codes", status_code=201)
def create_invite(body: InviteCreate, admin: models.User = Depends(require_portal_admin),
                 db: Session = Depends(get_db)):
    kind = body.kind if body.kind in ("project", "group") else "project"
    if kind == "project":
        if not body.service or not registry.service_dir(body.service).exists():
            raise HTTPException(404, "서비스를 지정하세요.")
    else:
        if not db.query(models.Group).filter(models.Group.id == body.group_id).first():
            raise HTTPException(404, "그룹을 찾을 수 없습니다.")
    days = max(1, min(365, int(body.days or 7)))
    max_uses = max(0, min(100000, int(body.max_uses or 0)))
    count = max(1, min(100, int(body.count or 1)))
    custom = (body.code or "").strip()
    if custom and count > 1:
        raise HTTPException(400, "직접 코드는 한 번에 1개만 만들 수 있습니다.")

    def _mk_code() -> str:
        if custom:
            c = custom.upper()
            if not _CODE_RE.match(c):
                raise HTTPException(400, "코드는 영문/숫자/-/_ 로 8~64자여야 합니다.")
            return c
        return secrets.token_hex(4).upper()

    common = dict(
        kind=kind,
        service_name=(body.service or "") if kind == "project" else "",
        project=(body.project or "").strip() if kind == "project" else "",
        group_id=body.group_id if kind == "group" else None,
        expires_at=datetime.utcnow() + timedelta(days=days),
        created_by=admin.id, max_uses=max_uses, no_verify=bool(body.no_verify))

    made = []
    for _ in range(count):
        # avoid the rare generated-code collision
        for _try in range(5):
            code = _mk_code()
            if not db.query(models.InviteCode).filter(models.InviteCode.code == code).first():
                break
        else:
            raise HTTPException(409, "코드 생성에 실패했습니다 (충돌).")
        if custom and db.query(models.InviteCode).filter(models.InviteCode.code == code).first():
            raise HTTPException(409, "이미 존재하는 코드입니다.")
        row = models.InviteCode(code=code, **common)
        db.add(row); db.flush(); made.append(row)
    db.commit()
    views = [_invite_view(db, r) for r in made]
    return {"count": len(views), "codes": views, **(views[0] if len(views) == 1 else {}), "days": days}


@router.get("/api/admin/invite-codes")
def list_invites(_: models.User = Depends(require_portal_admin), db: Session = Depends(get_db)):
    return [_invite_view(db, c) for c in db.query(models.InviteCode).order_by(models.InviteCode.id.desc()).all()]


class ExtendBody(BaseModel):
    days: int = 7


@router.put("/api/admin/invite-codes/{cid}")
def extend_invite(cid: int, body: ExtendBody, _: models.User = Depends(require_portal_admin), db: Session = Depends(get_db)):
    c = db.query(models.InviteCode).filter(models.InviteCode.id == cid).first()
    if not c:
        raise HTTPException(404, "코드를 찾을 수 없습니다.")
    days = max(1, min(365, int(body.days or 7)))
    base = max(c.expires_at, datetime.utcnow())      # extend from now if already expired
    c.expires_at = base + timedelta(days=days)
    c.active = True
    db.commit()
    return _invite_view(db, c)


@router.post("/api/admin/invite-codes/prune-expired")
def prune_expired_invites(_: models.User = Depends(require_portal_admin), db: Session = Depends(get_db)):
    """Bulk-delete every EXPIRED code (past its expiry). Revoked/used ones are kept."""
    n = db.query(models.InviteCode).filter(models.InviteCode.expires_at < datetime.utcnow()).delete()
    db.commit()
    return {"deleted": n}


@router.delete("/api/admin/invite-codes/{cid}")
def revoke_invite(cid: int, _: models.User = Depends(require_portal_admin), db: Session = Depends(get_db)):
    db.query(models.InviteCode).filter(models.InviteCode.id == cid).delete()
    db.commit()
    return {"deleted": cid}


def redeem_code(db: Session, user_id: int, code: str) -> dict:
    """Redeem a code for a user — grant a project, or join a group (inheriting its
    project grants). Raises ValueError on a bad code."""
    c = db.query(models.InviteCode).filter(models.InviteCode.code == (code or "").strip().upper()).first()
    if not c or _code_status(c) != "active":
        raise ValueError("유효하지 않거나 만료된 코드입니다.")
    if c.kind == "group":
        if not db.query(models.GroupMembership).filter(
            models.GroupMembership.user_id == user_id, models.GroupMembership.group_id == c.group_id).first():
            db.add(models.GroupMembership(user_id=user_id, group_id=c.group_id))
        c.uses += 1; db.commit()
        return {"kind": "group", "group": _group_name(db, c.group_id)}
    if not db.query(models.ServicePermission).filter(
        models.ServicePermission.user_id == user_id,
        models.ServicePermission.service_name == c.service_name,
        models.ServicePermission.project == c.project).first():
        db.add(models.ServicePermission(user_id=user_id, service_name=c.service_name, project=c.project))
    c.uses += 1; db.commit()
    return {"kind": "project", "service": c.service_name, "project": c.project or None}


def code_is_valid(db: Session, code: str) -> bool:
    c = db.query(models.InviteCode).filter(models.InviteCode.code == (code or "").strip().upper()).first()
    return bool(c and _code_status(c) == "active")


def code_no_verify(db: Session, code: str) -> bool:
    """True if an ACTIVE code is flagged to skip email verification on signup."""
    c = db.query(models.InviteCode).filter(models.InviteCode.code == (code or "").strip().upper()).first()
    return bool(c and _code_status(c) == "active" and getattr(c, "no_verify", False))


class RedeemBody(BaseModel):
    code: str


@router.post("/api/invite-codes/redeem")
def redeem(body: RedeemBody, user: models.User = Depends(require_portal_user), db: Session = Depends(get_db)):
    try:
        return {"ok": True, **redeem_code(db, user.id, body.code)}
    except ValueError as e:
        raise HTTPException(400, str(e))


# ── Account self-service ──────────────────────────────────────────────────────
def _user_groups(db: Session, user_id: int) -> list[dict]:
    gids = [m.group_id for m in db.query(models.GroupMembership).filter(
        models.GroupMembership.user_id == user_id).all()]
    if not gids:
        return []
    return [{"id": g.id, "name": g.name, "icon": g.icon, "color": g.color} for g in
            db.query(models.Group).filter(models.Group.id.in_(gids)).order_by(models.Group.name).all()]


def effective_color(u: models.User) -> Optional[str]:
    """Admins/managers always show the reserved MANAGER_COLOR; others keep theirs."""
    return config.MANAGER_COLOR if u.role == "manager" else u.profile_color


def _account_view(db: Session, u: models.User) -> dict:
    left = days_ago = None
    if u.email_verified_at:
        days_ago = (datetime.utcnow() - u.email_verified_at).days
        left = VERIFY_VALID_DAYS - days_ago
    return {
        "id": u.id, "username": u.username, "display_name": u.display_name, "email": u.email,
        "role": u.role, "is_active": u.is_active, "email_verified": u.email_verified,
        # elog-style profile (the portal account is a superset — these flow to elog via SSO)
        "phone": u.phone, "experiment_role": u.experiment_role,
        "participation_from": u.participation_from, "participation_to": u.participation_to,
        "profile_color": effective_color(u), "profile_shape": u.profile_shape,
        "is_admin": u.role == "manager", "manager_color": config.MANAGER_COLOR,
        "verification_current": permissions.verification_current(u),
        "verified_at": u.email_verified_at.isoformat() if u.email_verified_at else None,
        "verify_days_ago": days_ago, "verify_days_left": left, "pending_email": u.pending_email,
        "groups": _user_groups(db, u.id),
    }


@router.get("/api/account")
def my_account(user: models.User = Depends(require_portal_user), db: Session = Depends(get_db)):
    return _account_view(db, user)


class ProfileBody(BaseModel):
    display_name: Optional[str] = None
    phone: Optional[str] = None
    experiment_role: Optional[str] = None
    participation_from: Optional[str] = None
    participation_to: Optional[str] = None
    profile_color: Optional[str] = None
    profile_shape: Optional[str] = None


@router.post("/api/account/profile")
def update_profile(body: ProfileBody, user: models.User = Depends(require_portal_user), db: Session = Depends(get_db)):
    """Edit the elog-style profile. Only the fields present in the body are touched;
    a null clears that field. These propagate to elog on the next SSO entry."""
    data = body.model_dump(exclude_unset=True)
    for k in ("display_name", "phone", "experiment_role", "participation_from",
              "participation_to", "profile_color", "profile_shape"):
        if k in data:
            v = data[k]
            setattr(user, k, (v.strip() or None) if isinstance(v, str) else v)
    # Colour is role-gated: admins always get MANAGER_COLOR; non-admins can never
    # take it (silently dropped). elog uses the same rule.
    if user.role == "manager":
        user.profile_color = config.MANAGER_COLOR
    elif (user.profile_color or "").lower() == config.MANAGER_COLOR.lower():
        user.profile_color = None
    db.commit()
    return _account_view(db, user)


class PasswordBody(BaseModel):
    current_password: str
    new_password: str


@router.post("/api/account/password")
def change_password(body: PasswordBody, user: models.User = Depends(require_portal_user), db: Session = Depends(get_db)):
    if not security.verify_password(body.current_password, user.password_hash):
        raise HTTPException(400, "현재 비밀번호가 올바르지 않습니다.")
    if len(body.new_password or "") < 4:
        raise HTTPException(400, "새 비밀번호가 너무 짧습니다.")
    user.password_hash = security.hash_password(body.new_password)
    db.commit()
    return {"ok": True}


class EmailBody(BaseModel):
    new_email: str


@router.post("/api/account/request-email")
def request_email_change(body: EmailBody, user: models.User = Depends(require_portal_user), db: Session = Depends(get_db)):
    email = (body.new_email or "").strip()
    if not _EMAIL_RE.match(email):
        raise HTTPException(400, "올바른 이메일 주소를 입력하세요.")
    if db.query(models.User).filter(models.User.email == email, models.User.id != user.id).first():
        raise HTTPException(400, "이미 사용 중인 이메일입니다.")
    user.pending_email = email
    db.commit()
    return {"ok": True, "pending_email": email, "note": "관리자 승인 후 변경됩니다."}


@router.post("/api/account/verify")
def reverify(user: models.User = Depends(require_portal_user), db: Session = Depends(get_db)):
    """Temporary (dev) re-verification: stamps the yearly verification. Replaced by
    a real email round-trip once a sender is wired up."""
    user.email_verified = True
    user.email_verified_at = datetime.utcnow()
    user.verify_token = None
    db.commit()
    return {"ok": True, **_account_view(db, user)}


@router.delete("/api/account")
def delete_self(user: models.User = Depends(require_portal_user), db: Session = Depends(get_db)):
    if permissions.is_admin(user) and db.query(models.User).filter(models.User.role == "manager").count() <= 1:
        raise HTTPException(400, "마지막 관리자 계정은 삭제할 수 없습니다.")
    db.query(models.ServicePermission).filter(models.ServicePermission.user_id == user.id).delete()
    db.query(models.AccessRequest).filter(models.AccessRequest.user_id == user.id).delete()
    db.query(models.GroupMembership).filter(models.GroupMembership.user_id == user.id).delete()
    db.delete(user); db.commit()
    return {"deleted": user.id}


# ── Admin over everyone ───────────────────────────────────────────────────────
def _get_user(db: Session, uid: int) -> models.User:
    u = db.query(models.User).filter(models.User.id == uid).first()
    if not u:
        raise HTTPException(404, "계정을 찾을 수 없습니다.")
    return u


class AdminPwBody(BaseModel):
    new_password: str


@router.post("/api/admin/users/{uid}/password")
def admin_set_password(uid: int, body: AdminPwBody, _: models.User = Depends(require_portal_admin), db: Session = Depends(get_db)):
    u = _get_user(db, uid)
    if len(body.new_password or "") < 4:
        raise HTTPException(400, "비밀번호가 너무 짧습니다.")
    u.password_hash = security.hash_password(body.new_password)
    db.commit()
    return {"ok": True}


@router.post("/api/admin/users/{uid}/verify")
def admin_verify(uid: int, _: models.User = Depends(require_portal_admin), db: Session = Depends(get_db)):
    u = _get_user(db, uid)
    u.email_verified = True
    u.email_verified_at = datetime.utcnow()
    u.verify_token = None
    db.commit()
    return _account_view(db, u)


@router.post("/api/admin/users/{uid}/request-verify")
def admin_request_verify(uid: int, _: models.User = Depends(require_portal_admin), db: Session = Depends(get_db)):
    """Issue a fresh verification link for the user to (re)verify their email. No real
    sender yet, so in dev the link is returned to hand to the user."""
    u = _get_user(db, uid)
    token = secrets.token_urlsafe(32)
    u.verify_token = token
    db.commit()
    url = f"{config.BASE_URL}/api/auth/verify?token={token}"
    return {"ok": True, "verify_url": url if config.EMAIL_VERIFY_DEV_ECHO else None}


@router.post("/api/admin/users/{uid}/reset-password-email")
def admin_reset_password_email(uid: int, _: models.User = Depends(require_portal_admin), db: Session = Depends(get_db)):
    """Set a NEW random password (would be emailed to the user). No sender yet, so in
    dev the new password is returned so the admin can pass it on."""
    u = _get_user(db, uid)
    newpw = secrets.token_urlsafe(9)
    u.password_hash = security.hash_password(newpw)
    db.commit()
    return {"ok": True, "email": u.email, "password": newpw if config.EMAIL_VERIFY_DEV_ECHO else None}


class ApproveEmailBody(BaseModel):
    approve: bool = True


@router.post("/api/admin/users/{uid}/approve-email")
def admin_approve_email(uid: int, body: ApproveEmailBody, _: models.User = Depends(require_portal_admin), db: Session = Depends(get_db)):
    u = _get_user(db, uid)
    if not u.pending_email:
        raise HTTPException(400, "대기 중인 이메일 변경이 없습니다.")
    if body.approve:
        if db.query(models.User).filter(models.User.email == u.pending_email, models.User.id != u.id).first():
            raise HTTPException(400, "이미 사용 중인 이메일입니다.")
        u.email = u.pending_email
        u.email_verified = True                 # admin-vouched → trusted
        u.email_verified_at = datetime.utcnow()
    u.pending_email = None
    db.commit()
    return _account_view(db, u)


class RoleBody(BaseModel):
    role: str


@router.post("/api/admin/users/{uid}/role")
def admin_set_role(uid: int, body: RoleBody, _: models.User = Depends(require_portal_admin), db: Session = Depends(get_db)):
    u = _get_user(db, uid)
    role = body.role if body.role in ("user", "manager") else None
    if role is None:
        raise HTTPException(400, "role은 user 또는 manager 여야 합니다.")
    if u.role == "manager" and role != "manager" and db.query(models.User).filter(models.User.role == "manager").count() <= 1:
        raise HTTPException(400, "마지막 관리자는 강등할 수 없습니다.")
    u.role = role
    if role == "manager":
        u.profile_color = config.MANAGER_COLOR      # managers always get the reserved colour
    db.commit()
    return _account_view(db, u)


class ActiveBody(BaseModel):
    active: bool


@router.post("/api/admin/users/{uid}/active")
def admin_set_active(uid: int, body: ActiveBody, _: models.User = Depends(require_portal_admin), db: Session = Depends(get_db)):
    u = _get_user(db, uid)
    if not body.active and u.role == "manager" and db.query(models.User).filter(
            models.User.role == "manager", models.User.is_active == True).count() <= 1:  # noqa: E712
        raise HTTPException(400, "마지막 활성 관리자는 비활성화할 수 없습니다.")
    u.is_active = bool(body.active)
    db.commit()
    return _account_view(db, u)


class ConfirmPwBody(BaseModel):
    password: str = ""


@router.delete("/api/admin/users/{uid}")
def admin_delete_user(uid: int, body: ConfirmPwBody, admin: models.User = Depends(require_portal_admin), db: Session = Depends(get_db)):
    # Deleting an account requires the admin to re-enter their own password.
    if not security.verify_password(body.password or "", admin.password_hash):
        raise HTTPException(403, "관리자 비밀번호가 올바르지 않습니다.")
    u = _get_user(db, uid)
    if u.role == "manager" and db.query(models.User).filter(models.User.role == "manager").count() <= 1:
        raise HTTPException(400, "마지막 관리자 계정은 삭제할 수 없습니다.")
    db.query(models.ServicePermission).filter(models.ServicePermission.user_id == uid).delete()
    db.query(models.AccessRequest).filter(models.AccessRequest.user_id == uid).delete()
    db.query(models.GroupMembership).filter(models.GroupMembership.user_id == uid).delete()
    db.delete(u); db.commit()
    return {"deleted": uid}


# ── Groups (admin) ────────────────────────────────────────────────────────────
def _group_view(db: Session, g: models.Group) -> dict:
    members = db.query(models.GroupMembership).filter(models.GroupMembership.group_id == g.id).count()
    perms = [{"service": p.service_name, "project": p.project or None}
             for p in db.query(models.GroupPermission).filter(models.GroupPermission.group_id == g.id).all()]
    return {"id": g.id, "name": g.name, "description": g.description,
            "icon": g.icon, "color": g.color, "members": members, "permissions": perms}


@router.get("/api/admin/groups")
def list_groups(_: models.User = Depends(require_portal_admin), db: Session = Depends(get_db)):
    return [_group_view(db, g) for g in db.query(models.Group).order_by(models.Group.name).all()]


class GroupBody(BaseModel):
    name: str
    description: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None


@router.post("/api/admin/groups", status_code=201)
def create_group(body: GroupBody, _: models.User = Depends(require_portal_admin), db: Session = Depends(get_db)):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(400, "그룹 이름을 입력하세요.")
    if db.query(models.Group).filter(models.Group.name == name).first():
        raise HTTPException(409, "이미 존재하는 그룹입니다.")
    icon = re.sub(r"[^a-z0-9_-]", "", (body.icon or "").strip().lower()) or None
    color = (body.color or "").strip() or None
    g = models.Group(name=name, description=(body.description or None), icon=icon, color=color)
    db.add(g); db.commit(); db.refresh(g)
    return _group_view(db, g)


class GroupMetaBody(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None


@router.put("/api/admin/groups/{gid}")
def update_group(gid: int, body: GroupMetaBody, _: models.User = Depends(require_portal_admin), db: Session = Depends(get_db)):
    """Edit a group's name / description / icon / colour (the square group mark)."""
    g = db.query(models.Group).filter(models.Group.id == gid).first()
    if not g:
        raise HTTPException(404, "그룹을 찾을 수 없습니다.")
    data = body.model_dump(exclude_unset=True)
    if "name" in data and data["name"] is not None:
        nm = data["name"].strip()
        if nm and db.query(models.Group).filter(models.Group.name == nm, models.Group.id != gid).first():
            raise HTTPException(409, "이미 존재하는 그룹입니다.")
        if nm:
            g.name = nm
    if "description" in data:
        g.description = (data["description"] or None)
    if "icon" in data:
        g.icon = re.sub(r"[^a-z0-9_-]", "", (data["icon"] or "").strip().lower()) or None
    if "color" in data:
        c = (data["color"] or "").strip()
        if c and not re.match(r"^#[0-9a-fA-F]{6}$", c):
            raise HTTPException(400, "color는 #rrggbb 형식이어야 합니다.")
        g.color = c or None
    db.commit(); db.refresh(g)
    return _group_view(db, g)


@router.post("/api/admin/groups/{gid}/deactivate")
def deactivate_group(gid: int, _: models.User = Depends(require_portal_admin), db: Session = Depends(get_db)):
    """Deactivate every (non-manager) member of a group at once."""
    if not db.query(models.Group).filter(models.Group.id == gid).first():
        raise HTTPException(404, "그룹을 찾을 수 없습니다.")
    uids = [m.user_id for m in db.query(models.GroupMembership).filter(models.GroupMembership.group_id == gid).all()]
    n = 0
    for u in db.query(models.User).filter(models.User.id.in_(uids)).all():
        if u.role == "manager" or not u.is_active:
            continue                                  # never deactivate admins via a group action
        u.is_active = False
        n += 1
    db.commit()
    return {"deactivated": n}


@router.post("/api/admin/groups/{gid}/reset-permissions")
def reset_group_member_permissions(gid: int, _: models.User = Depends(require_portal_admin), db: Session = Depends(get_db)):
    """Remove ALL direct (per-user) service permissions from every non-manager member
    of the group at once. Group-inherited grants are left intact — only the users'
    own grants are cleared. Admins are never touched by a group action."""
    if not db.query(models.Group).filter(models.Group.id == gid).first():
        raise HTTPException(404, "그룹을 찾을 수 없습니다.")
    uids = [m.user_id for m in db.query(models.GroupMembership).filter(models.GroupMembership.group_id == gid).all()]
    mgr = {u.id for u in db.query(models.User).filter(models.User.id.in_(uids), models.User.role == "manager").all()}
    targets = [uid for uid in uids if uid not in mgr]
    n = 0
    if targets:
        n = db.query(models.ServicePermission).filter(
            models.ServicePermission.user_id.in_(targets)).delete(synchronize_session=False)
    db.commit()
    return {"reset": int(n or 0), "users": len(targets)}


@router.post("/api/admin/groups/{gid}/clear-permissions")
def clear_group_permissions(gid: int, _: models.User = Depends(require_portal_admin), db: Session = Depends(get_db)):
    """Remove all of this group's own grants (GroupPermission). Members immediately stop
    inheriting them. Per-user direct grants are untouched (see reset-permissions)."""
    if not db.query(models.Group).filter(models.Group.id == gid).first():
        raise HTTPException(404, "그룹을 찾을 수 없습니다.")
    n = db.query(models.GroupPermission).filter(
        models.GroupPermission.group_id == gid).delete(synchronize_session=False)
    db.commit()
    return {"cleared": int(n or 0)}


@router.delete("/api/admin/groups/{gid}")
def delete_group(gid: int, _: models.User = Depends(require_portal_admin), db: Session = Depends(get_db)):
    db.query(models.GroupMembership).filter(models.GroupMembership.group_id == gid).delete()
    db.query(models.GroupPermission).filter(models.GroupPermission.group_id == gid).delete()
    db.query(models.InviteCode).filter(models.InviteCode.group_id == gid).delete()
    db.query(models.Group).filter(models.Group.id == gid).delete()
    db.commit()
    return {"deleted": gid}


class MemberBody(BaseModel):
    user_id: int


@router.post("/api/admin/groups/{gid}/members", status_code=201)
def add_member(gid: int, body: MemberBody, _: models.User = Depends(require_portal_admin), db: Session = Depends(get_db)):
    if not db.query(models.Group).filter(models.Group.id == gid).first():
        raise HTTPException(404, "그룹을 찾을 수 없습니다.")
    if not db.query(models.GroupMembership).filter(
        models.GroupMembership.group_id == gid, models.GroupMembership.user_id == body.user_id).first():
        db.add(models.GroupMembership(group_id=gid, user_id=body.user_id)); db.commit()
    return {"ok": True}


@router.delete("/api/admin/groups/{gid}/members/{uid}")
def remove_member(gid: int, uid: int, _: models.User = Depends(require_portal_admin), db: Session = Depends(get_db)):
    db.query(models.GroupMembership).filter(
        models.GroupMembership.group_id == gid, models.GroupMembership.user_id == uid).delete()
    db.commit()
    return {"ok": True}


class GroupPermBody(BaseModel):
    group_id: int
    service: str
    project: Optional[str] = ""


@router.post("/api/admin/group-permissions", status_code=201)
def grant_group_perm(body: GroupPermBody, _: models.User = Depends(require_portal_admin), db: Session = Depends(get_db)):
    proj = (body.project or "").strip()
    if not db.query(models.GroupPermission).filter(
        models.GroupPermission.group_id == body.group_id,
        models.GroupPermission.service_name == body.service,
        models.GroupPermission.project == proj).first():
        db.add(models.GroupPermission(group_id=body.group_id, service_name=body.service, project=proj))
        db.commit()
    return {"granted": True}


@router.delete("/api/admin/group-permissions")
def revoke_group_perm(body: GroupPermBody, _: models.User = Depends(require_portal_admin), db: Session = Depends(get_db)):
    db.query(models.GroupPermission).filter(
        models.GroupPermission.group_id == body.group_id,
        models.GroupPermission.service_name == body.service,
        models.GroupPermission.project == (body.project or "").strip()).delete()
    db.commit()
    return {"granted": False}
