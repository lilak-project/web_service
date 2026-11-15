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
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import config, emailer, models, permissions, registry, security, prefs
from ..db import get_db
from ..deps import portal_token, require_portal_admin, require_portal_user, require_portal_user_or_delegated
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


def _may_code(db: Session, user: models.User, kind: str, svc: str, proj: str) -> bool:
    """A manager handles every code; a project admin, the codes of what they administer."""
    return permissions.is_admin(user) or (kind == "project" and bool(svc)
                                          and permissions.is_project_admin(db, user, svc, proj or ""))


def _own_code(db: Session, user: models.User, cid: int) -> models.InviteCode:
    c = db.query(models.InviteCode).filter(models.InviteCode.id == cid).first()
    if not c or not _may_code(db, user, c.kind, c.service_name, c.project):
        raise HTTPException(404, "코드를 찾을 수 없습니다.")
    return c


@router.post("/api/admin/invite-codes", status_code=201)
def create_invite(body: InviteCreate, admin: models.User = Depends(require_portal_user),
                 db: Session = Depends(get_db)):
    kind = body.kind if body.kind in ("project", "group") else "project"
    if not _may_code(db, admin, kind, body.service or "", (body.project or "").strip()):
        raise HTTPException(403, "관리하는 프로젝트의 코드만 만들 수 있습니다.")
    if not permissions.is_admin(admin):
        body.no_verify = False          # who joins the portal unverified is a manager's call
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
def list_invites(user: models.User = Depends(require_portal_user), db: Session = Depends(get_db)):
    return [_invite_view(db, c) for c in db.query(models.InviteCode).order_by(models.InviteCode.id.desc()).all()
            if _may_code(db, user, c.kind, c.service_name, c.project)]


class ExtendBody(BaseModel):
    days: int = 7


@router.put("/api/admin/invite-codes/{cid}")
def extend_invite(cid: int, body: ExtendBody, user: models.User = Depends(require_portal_user), db: Session = Depends(get_db)):
    c = _own_code(db, user, cid)
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
def revoke_invite(cid: int, user: models.User = Depends(require_portal_user), db: Session = Depends(get_db)):
    db.delete(_own_code(db, user, cid))
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
    """An active code that lets an address outside the allowed domains sign up: a manager's.
    A project admin's code gives its project to an account, not an account to a stranger —
    unless a manager said it may (Invite codes → who may sign up)."""
    c = db.query(models.InviteCode).filter(models.InviteCode.code == (code or "").strip().upper()).first()
    if not c or _code_status(c) != "active":
        return False
    by = db.get(models.User, c.created_by) if c.created_by else None
    from .. import settings_store
    return c.created_by is None or bool(by and permissions.is_admin(by)) or settings_store.admin_codes_open_signup()


def code_no_verify(db: Session, code: str) -> bool:
    """True if an ACTIVE code is flagged to skip email verification on signup."""
    c = db.query(models.InviteCode).filter(models.InviteCode.code == (code or "").strip().upper()).first()
    return bool(c and _code_status(c) == "active" and getattr(c, "no_verify", False))


def name_taken(db: Session, name: str, but: Optional[int] = None) -> bool:
    """True when another account already goes by `name` — as its id or its display name,
    whatever the case — so nobody can post as someone else."""
    from sqlalchemy import func, or_
    n = (name or "").lower()
    q = db.query(models.User).filter(or_(func.lower(models.User.username) == n,
                                         func.lower(models.User.display_name) == n))
    return (q.filter(models.User.id != but) if but else q).first() is not None


def clean_display(db: Session, name: Optional[str], but: Optional[int] = None, own: str = "") -> Optional[str]:
    """A display name fit to show: one line, 40 characters, nobody else's name and no chat
    keyword (unless it is the account's own id, as the built-in admin's is). None for none."""
    import unicodedata
    from .auth import RESERVED_NAMES
    name = " ".join((name or "").split())
    if not name:
        return None
    if len(name) > 40 or any(unicodedata.category(ch)[0] == "C" for ch in name):
        raise HTTPException(400, "표시 이름은 40자까지, 한 줄로 씁니다.")
    if name_taken(db, name, but) or (name.lower() in RESERVED_NAMES and name != own):
        raise HTTPException(400, "다른 계정이 쓰는 이름이거나 예약된 이름입니다.")
    return name


class RedeemBody(BaseModel):
    code: str


@router.post("/api/invite-codes/redeem")
def redeem(body: RedeemBody, user: models.User = Depends(require_portal_user), db: Session = Depends(get_db)):
    from . import auth
    key = f"redeem:{user.id}"                  # a code is short: guessing must not be free
    if auth._too_many(key, 10):
        auth._slow_down()
    try:
        return {"ok": True, **redeem_code(db, user.id, body.code)}
    except ValueError as e:
        auth._failed(key)
        raise HTTPException(400, str(e))


# ── Account self-service ──────────────────────────────────────────────────────
def _user_groups(db: Session, user_id: int) -> list[dict]:
    gids = [m.group_id for m in db.query(models.GroupMembership).filter(
        models.GroupMembership.user_id == user_id).all()]
    if not gids:
        return []
    return [{"id": g.id, "name": g.name, "icon": g.icon, "color": g.color} for g in
            db.query(models.Group).filter(models.Group.id.in_(gids)).order_by(models.Group.name).all()]


RESERVED_COLORS = config.RESERVED_COLORS


def effective_color(db: Session, u: models.User) -> Optional[str]:
    """The colour this user's avatar shows — see config.avatar_color for the rule."""
    return config.avatar_color(
        manager=u.role == "manager",
        scoped_admin=permissions.has_any_admin(db, u.id),
        stored=u.profile_color,
    )


def _direct_perms(db: Session, uid: int) -> list:
    """A user's OWN service/project grants (with the scoped-admin flag)."""
    return [{"service": p.service_name, "project": p.project or None, "admin": bool(p.is_admin)}
            for p in db.query(models.ServicePermission).filter(models.ServicePermission.user_id == uid).all()]


def _inherited_perms(db: Session, uid: int) -> list:
    """Grants a user inherits from the groups they belong to."""
    gids = permissions.user_group_ids(db, uid)
    if not gids:
        return []
    gnames = {g.id: g.name for g in db.query(models.Group).filter(models.Group.id.in_(gids)).all()}
    return [{"service": p.service_name, "project": p.project or None, "group": gnames.get(p.group_id),
             "admin": bool(p.is_admin)}
            for p in db.query(models.GroupPermission).filter(models.GroupPermission.group_id.in_(gids)).all()]


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
        "profile_color": effective_color(db, u), "profile_shape": u.profile_shape,
        "is_admin": u.role == "manager", "manager_color": config.MANAGER_COLOR,
        # scoped (service/project) admin: recognised + dark-grey avatar, locked like managers'
        "admin_scopes": permissions.admin_scopes(db, u.id),
        "scoped_admin": permissions.has_any_admin(db, u.id),
        "scoped_admin_color": config.SCOPED_ADMIN_COLOR,
        # the user's own access grants (services/projects), direct + inherited
        "permissions": _direct_perms(db, u.id), "inherited_permissions": _inherited_perms(db, u.id),
        "verification_current": permissions.verification_current(u),
        "verified_at": u.email_verified_at.isoformat() if u.email_verified_at else None,
        "verify_days_ago": days_ago, "verify_days_left": left, "pending_email": u.pending_email,
        "groups": _user_groups(db, u.id),
        # The account's own settings (language, …) — they follow it to any browser.
        "prefs": prefs.get(u),
    }


@router.get("/api/account")
def my_account(user: models.User = Depends(require_portal_user), db: Session = Depends(get_db)):
    return _account_view(db, user)


@router.get("/api/introspect")
def introspect(user: models.User = Depends(require_portal_user_or_delegated), db: Session = Depends(get_db)):
    """Canonical FRESH identity for managed services (elog/nptoy/g4toy/…) to sync a
    portal token's live role/profile/verification on entry — the single source that
    replaces the three divergent models the services used to have: elog synced role
    only at creation (a demotion never propagated), nptoy read portal.db directly
    (coupled to the private schema), g4toy trusted the ≤24 h-stale token claim.

    `require_portal_user` already validates the token AND loads the live row (401 if
    deactivated), so every field here is current. Minimal, stable shape — keep it
    backward-compatible; services merge it over their token payload. Field names
    mirror the token claims (`prole`, `name`, `color`, `shape`, …) so a service can
    consume it exactly like the payload."""
    role = user.role
    return {
        "id": user.id,
        "email": user.email,
        "username": user.username,
        "name": user.display_name or user.username,
        "role": role,
        "prole": role,
        "color": effective_color(db, user),
        "shape": user.profile_shape,
        "verified": permissions.verification_current(user),
        "active": user.is_active,
        # elog-style profile superset (a service provisions a full local mirror)
        "phone": user.phone,
        "erole": user.experiment_role,
        "pfrom": user.participation_from,
        "pto": user.participation_to,
    }


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
    if data.get("display_name"):
        data["display_name"] = clean_display(db, data["display_name"], user.id, user.username) or ""
    for k in ("display_name", "phone", "experiment_role", "participation_from",
              "participation_to", "profile_color", "profile_shape"):
        if k in data:
            v = data[k]
            setattr(user, k, (v.strip() or None) if isinstance(v, str) else v)
    # Colour is role-gated: managers always get MANAGER_COLOR; nobody else may store
    # a reserved colour (silently dropped), so it can't outlive the role that earned
    # it. A scoped admin's grey is derived by effective_color, not stored — that way
    # revoking the grant gives them their own colour back. elog uses the same rule.
    if user.role == "manager":
        user.profile_color = config.MANAGER_COLOR
    elif (user.profile_color or "").lower() in RESERVED_COLORS:
        user.profile_color = None
    db.commit()
    return _account_view(db, user)


class PrefsBody(BaseModel):
    lang: Optional[str] = None
    # The tags this account starred — first in every tags tab (rack services,
    # note, project_manager), whatever the case.
    favTags: Optional[list[str]] = None
    # What the home screen lists first: "svc" or "svc/project", newest first.
    recent: Optional[list[str]] = None
    # The service bar's width and spacing: "wide" (the default) or "compact".
    density: Optional[str] = None
    # List or groups, for the service bar and Home alike: "group" (the default) or "list".
    homeView: Optional[str] = None
    # Bright (the default) or dark, for NEON's pages and the rack services alike.
    theme: Optional[str] = None
    # The time zone calendars read and write times in (IANA name). Absent = each one's own.
    zone: Optional[str] = None
    # The zones a calendar's menu offers, in order: [{zone, name}]. Absent = its own list.
    zones: Optional[list[dict]] = None
    # This account's own service bar: order, groups, hidden cards, its own names.
    # Absent = the manager's default. See _clean_layout.
    layout: Optional[dict] = None
    # The chat room this account last used: "portal" or "svc/proj".
    chatRoom: Optional[str] = None


def _clean_layout(d: dict) -> dict:
    """Keep only the known shape, with bounded sizes: a personal layout is
    {order:[key], groups:[{id,name,members:[key],hidden}], hidden:[key],
     labels:{key:name}, looseHidden:bool}. Keys are card keys or "#g:<id>"."""
    def keys(v, n=2000):
        out = [str(k)[:200] for k in (v or []) if isinstance(k, (str, int)) and str(k).strip()]
        if len(out) > n:
            raise HTTPException(400, "사이드바 배치가 너무 큽니다.")
        return list(dict.fromkeys(out))
    groups = []
    for g in (d.get("groups") or [])[:200]:
        if not isinstance(g, dict) or not str(g.get("id") or "").strip():
            continue
        one = {"id": str(g["id"])[:40], "name": str(g.get("name") or "")[:80],
               "members": keys(g.get("members")), "hidden": bool(g.get("hidden"))}
        if isinstance(g.get("share_set"), str) and g["share_set"].strip():
            one["share_set"] = g["share_set"].strip()[:80]     # copied from the shared group it began as
        groups.append(one)
    labels = {str(k)[:200]: str(v).strip()[:80] for k, v in (d.get("labels") or {}).items()
              if isinstance(v, str) and v.strip()}
    if len(labels) > 2000:
        raise HTTPException(400, "사이드바 배치가 너무 큽니다.")
    return {"order": keys(d.get("order")), "groups": groups, "hidden": keys(d.get("hidden")),
            "labels": labels, "looseHidden": bool(d.get("looseHidden"))}


@router.get("/api/account/prefs")
def my_prefs(user: models.User = Depends(require_portal_user)):
    """This account's own settings alone — what a service asks for (starred tags)."""
    return {"prefs": prefs.get(user)}


@router.put("/api/account/prefs")
def update_prefs(body: PrefsBody, user: models.User = Depends(require_portal_user), db: Session = Depends(get_db)):
    """Save this account's own settings. Only the fields sent change."""
    data = body.model_dump(exclude_unset=True)
    if "lang" in data:
        lang = (data["lang"] or "").strip()
        if lang and not re.fullmatch(r"[a-z]{2}(-[A-Za-z]{2})?", lang):
            raise HTTPException(400, "언어 코드가 올바르지 않습니다.")
        prefs.put(user, lang=lang or None)
    if "favTags" in data:
        tags = [str(t).strip() for t in (data["favTags"] or []) if str(t).strip()]
        if len(tags) > 500 or any(len(t) > 100 for t in tags):
            raise HTTPException(400, "즐겨찾는 태그가 너무 많거나 깁니다.")
        prefs.put(user, favTags=list(dict.fromkeys(tags)) or None)
    if "recent" in data:
        keys = [str(k).strip() for k in (data["recent"] or []) if str(k).strip()]
        if any(len(k) > 200 for k in keys):
            raise HTTPException(400, "최근 목록이 올바르지 않습니다.")
        prefs.put(user, recent=list(dict.fromkeys(keys))[:8] or None)
    if "density" in data:
        if data["density"] not in ("wide", "compact", None):
            raise HTTPException(400, "화면 밀도 값이 올바르지 않습니다.")
        prefs.put(user, density=None if data["density"] == "wide" else data["density"])
    if "homeView" in data:
        if data["homeView"] not in ("list", "group", None):
            raise HTTPException(400, "홈 보기 값이 올바르지 않습니다.")
        prefs.put(user, homeView=None if data["homeView"] == "group" else data["homeView"])
    if "theme" in data:
        if data["theme"] not in ("bright", "dark", None):
            raise HTTPException(400, "테마 값이 올바르지 않습니다.")
        prefs.put(user, theme=None if data["theme"] == "bright" else data["theme"])
    if "chatRoom" in data:
        room = (data["chatRoom"] or "").strip()
        if room and not re.fullmatch(r"portal|[A-Za-z0-9_\-]{1,64}/[A-Za-z0-9_\-]{1,64}", room):
            raise HTTPException(400, "채팅방 이름이 올바르지 않습니다.")
        prefs.put(user, chatRoom=room or None)
    if "layout" in data:
        prefs.put(user, layout=_clean_layout(data["layout"]) if data["layout"] else None)
    if "zone" in data:
        zone = (data["zone"] or "").strip()
        try:
            if zone:
                ZoneInfo(zone)
        except (ValueError, KeyError, OSError):
            raise HTTPException(400, "시간대 이름이 올바르지 않습니다.")
        prefs.put(user, zone=zone or None)
    if "zones" in data:
        zones = []
        for z in data["zones"] or []:
            tz, name = str((z or {}).get("zone") or "").strip(), str((z or {}).get("name") or "").strip()
            try:
                ZoneInfo(tz)
            except (ValueError, KeyError, OSError):
                raise HTTPException(400, "시간대 이름이 올바르지 않습니다.")
            if not name or len(name) > 40:
                raise HTTPException(400, "시간대 이름표가 비었거나 깁니다.")
            zones.append({"zone": tz, "name": name})
        if len(zones) > 40:
            raise HTTPException(400, "시간대가 너무 많습니다.")
        prefs.put(user, zones=zones or None)
    db.commit()
    return {"prefs": prefs.get(user)}


@router.post("/api/account/sign-out-everywhere")
def sign_out_everywhere(user: models.User = Depends(require_portal_user), db: Session = Depends(get_db)):
    """End every session this account has — this browser's and any other's.
    Tokens issued before now stop working (the API and the service proxies
    both check); signing in again starts a new one."""
    import time
    prefs.put(user, sessions_after=time.time())
    db.commit()
    return {"ok": True}


class PasswordBody(BaseModel):
    current_password: str
    new_password: str


@router.post("/api/account/password")
def change_password(body: PasswordBody, user: models.User = Depends(require_portal_user), db: Session = Depends(get_db)):
    if not security.verify_password(body.current_password, user.password_hash):
        raise HTTPException(400, "현재 비밀번호가 올바르지 않습니다.")
    if len(body.new_password or "") < config.PASSWORD_MIN_LENGTH:
        raise HTTPException(400, f"새 비밀번호는 최소 {config.PASSWORD_MIN_LENGTH}자 이상이어야 합니다.")
    user.password_hash = security.hash_password(body.new_password)
    # Whoever had the old password may still hold a session: end them all, and
    # hand this browser a fresh token minted after the cut.
    import time
    from ..deps import portal_token
    prefs.put(user, sessions_after=time.time())
    db.commit()
    return {"ok": True, "access_token": portal_token(user)}


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


class ReverifyBody(BaseModel):
    code: Optional[str] = None


@router.post("/api/account/verify")
def reverify(body: ReverifyBody = ReverifyBody(), user: models.User = Depends(require_portal_user),
             db: Session = Depends(get_db)):
    """The yearly re-verification, by mail: with no code, a 6-digit code is sent to the
    account's address; with the code, the verification is stamped. (It used to stamp on
    request alone, which made the yearly check something anyone could wave through.)
    Only where no mail can be sent AND the dev echo is on (a laptop) is the code handed back."""
    from .auth import _failed, _slow_down, _too_many
    key = f"reverify:{user.id}"
    code = re.sub(r"\D", "", body.code or "")
    if not code:
        if _too_many(key, 5):
            _slow_down()
        _failed(key)                                   # counts sends too: five mails a quarter-hour
        token = f"{secrets.randbelow(1_000_000):06d}"
        try:
            emailer.send_verification_email(user.email, token)
        except emailer.EmailDeliveryError as exc:
            print(f"[re-verify] delivery failed for {user.email}: {exc}", flush=True)
            if not config.EMAIL_VERIFY_DEV_ECHO:
                raise HTTPException(502, "인증 메일 발송에 실패했습니다. 잠시 후 다시 시도하세요.")
        user.verify_token = token
        db.commit()
        return {"ok": True, "sent": True, "email": user.email,
                "verify_code": token if config.EMAIL_VERIFY_DEV_ECHO else None}
    if _too_many(key, 5):
        _slow_down()
    if not user.verify_token or not secrets.compare_digest(user.verify_token, code):
        _failed(key)
        raise HTTPException(400, "인증 코드가 올바르지 않습니다.")
    user.email_verified = True
    user.email_verified_at = datetime.utcnow()
    user.verify_token = None
    db.commit()
    return {"ok": True, **_account_view(db, user)}


class ConfirmPwBody(BaseModel):
    password: str = ""


@router.delete("/api/account")
def delete_self(body: ConfirmPwBody = ConfirmPwBody(), user: models.User = Depends(require_portal_user), db: Session = Depends(get_db)):
    # A session left open on a shared machine must not be enough to erase the account.
    if not security.verify_password(body.password or "", user.password_hash):
        raise HTTPException(403, "비밀번호가 올바르지 않습니다.")
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


def _end_sessions(u: models.User, admin: models.User) -> None:
    """A password a manager replaced is usually one that leaked: whoever is signed in with
    the old one goes too. (The manager's own session stays — they are the one typing.)"""
    if u.id != admin.id:
        import time
        prefs.put(u, sessions_after=time.time())


class AdminPwBody(BaseModel):
    new_password: str


@router.post("/api/admin/users/{uid}/password")
def admin_set_password(uid: int, body: AdminPwBody, admin: models.User = Depends(require_portal_admin), db: Session = Depends(get_db)):
    u = _get_user(db, uid)
    if len(body.new_password or "") < config.PASSWORD_MIN_LENGTH:
        raise HTTPException(400, f"비밀번호는 최소 {config.PASSWORD_MIN_LENGTH}자 이상이어야 합니다.")
    u.password_hash = security.hash_password(body.new_password)
    _end_sessions(u, admin)
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
def admin_reset_password_email(uid: int, admin: models.User = Depends(require_portal_admin), db: Session = Depends(get_db)):
    """Set a NEW random password and email it straight to the user, so an
    admin-initiated reset never exposes the password to the admin. In local dev
    (DEV_ECHO on) the password is also returned so the flow is testable without a
    mail provider; in production DEV_ECHO is off and a delivery failure is an error
    (the password is never leaked back through the API)."""
    u = _get_user(db, uid)
    newpw = secrets.token_urlsafe(9)
    try:
        emailer.send_password_reset_email(u.email, newpw)
    except emailer.EmailDeliveryError as exc:
        print(f"[password-reset] delivery failed for {u.email}: {exc}", flush=True)
        if not config.EMAIL_VERIFY_DEV_ECHO:
            raise HTTPException(502, "비밀번호 재설정 메일 발송에 실패했습니다. 메일 설정을 확인하세요.")
    u.password_hash = security.hash_password(newpw)
    _end_sessions(u, admin)
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
    elif (u.profile_color or "").lower() in RESERVED_COLORS:
        u.profile_color = None                      # demoted → hand the reserved colour back
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
    perms = [{"service": p.service_name, "project": p.project or None, "admin": bool(p.is_admin)}
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
    admin: bool = False           # every member becomes a scoped admin of this scope


@router.post("/api/admin/group-permissions", status_code=201)
def grant_group_perm(body: GroupPermBody, _: models.User = Depends(require_portal_admin), db: Session = Depends(get_db)):
    proj = (body.project or "").strip()
    exists = db.query(models.GroupPermission).filter(
        models.GroupPermission.group_id == body.group_id,
        models.GroupPermission.service_name == body.service,
        models.GroupPermission.project == proj).first()
    if exists:
        exists.is_admin = bool(body.admin)   # idempotent: also toggles the admin flag
    else:
        db.add(models.GroupPermission(group_id=body.group_id, service_name=body.service,
                                      project=proj, is_admin=bool(body.admin)))
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


# ── Delegation: a service writing in ANOTHER service for the person ──────────
# The rule (web_service/CLAUDE.md): services read each other through links and tags;
# a service that must write somewhere else for a person asks here for a token that
# is good for that one project, a few minutes, and says it came through it. It never
# passes the person's own token on.
class DelegateBody(BaseModel):
    to: str                       # "svc/proj" (or "svc" for a single-project service)
    minutes: int = 5


@router.post("/api/delegate")
def delegate(body: DelegateBody, user: models.User = Depends(require_portal_user), db: Session = Depends(get_db),
             x_portal_service: str = Header(default=""), x_portal_service_key: str = Header(default="")):
    import hmac
    import logging
    if not (x_portal_service and registry.valid_name(x_portal_service)
            and hmac.compare_digest(x_portal_service_key, security.service_key(x_portal_service))):
        raise HTTPException(403, "포털이 띄운 서비스만 위임을 청할 수 있습니다.")
    svc, _, proj = body.to.strip().partition("/")
    if not registry.valid_name(svc) or (proj and not registry.valid_name(proj)) or not registry.service_dir(svc).exists():
        raise HTTPException(400, "위임할 곳이 올바르지 않습니다.")
    # Only where this service is registered to write (its manifest's `capabilities.delegates`):
    # a service gone wrong reaches the few services it works with, not every project the person has.
    if svc not in ((registry.read_manifest(x_portal_service).get("capabilities") or {}).get("delegates") or []):
        raise HTTPException(403, f"'{x_portal_service}' 서비스는 '{svc}'에 대신 쓰도록 등록되어 있지 않습니다 (capabilities.delegates).")
    if not permissions.can_enter_project(db, user, svc, proj):
        raise HTTPException(403, "이 프로젝트에 대한 권한이 없습니다.")
    minutes = max(1, min(int(body.minutes or 5), 10))
    logging.getLogger("portal.delegate").info("%s via %s -> %s (%d min)", user.username, x_portal_service, body.to, minutes)
    return {"token": portal_token(user, scope=body.to.strip(), via=x_portal_service, minutes=minutes),
            "expires_in": minutes * 60}
