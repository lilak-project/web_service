"""
Per-project permission + annual-verification helpers, shared by the service list,
the project list, and the reverse proxies.

A ServicePermission row with project="" is a *whole-service* grant (covers every
project); a non-empty project grants just that one. Managers bypass everything.
Email verification expires after VERIFY_VALID_DAYS — a stale account keeps its
login and can still SEE its projects, but can't enter them until it re-verifies.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from . import models, security
from .models import VERIFY_VALID_DAYS


def is_admin(user: models.User) -> bool:
    """Global manager — admin everywhere."""
    return user.role == "manager"


def admin_scopes(db: Session, user_id: int) -> list[dict]:
    """The service/project scopes a user is a SCOPED admin of (is_admin grants).
    project="" = whole-service admin; non-empty = that project only."""
    return [{"service": r.service_name, "project": r.project}
            for r in db.query(models.ServicePermission).filter(
                models.ServicePermission.user_id == user_id,
                models.ServicePermission.is_admin.is_(True),
            ).all()]


def has_any_admin(db: Session, user_id: int) -> bool:
    """True if the user is a scoped admin of anything (→ dark-grey avatar)."""
    return db.query(models.ServicePermission).filter(
        models.ServicePermission.user_id == user_id,
        models.ServicePermission.is_admin.is_(True),
    ).first() is not None


def is_service_admin(db: Session, user: models.User, svc: str) -> bool:
    """Global manager, or a whole-service scoped admin of `svc`."""
    if is_admin(user):
        return True
    return db.query(models.ServicePermission).filter(
        models.ServicePermission.user_id == user.id,
        models.ServicePermission.service_name == svc,
        models.ServicePermission.project == "",
        models.ServicePermission.is_admin.is_(True),
    ).first() is not None


def is_project_admin(db: Session, user: models.User, svc: str, proj: str) -> bool:
    """Global manager, whole-service admin of `svc`, or the admin of this project."""
    if is_service_admin(db, user, svc):
        return True
    return db.query(models.ServicePermission).filter(
        models.ServicePermission.user_id == user.id,
        models.ServicePermission.service_name == svc,
        models.ServicePermission.project == proj,
        models.ServicePermission.is_admin.is_(True),
    ).first() is not None


def verification_current(user: models.User) -> bool:
    """True if the account's email verification is still within its yearly window."""
    if is_admin(user):
        return True
    if not user.email_verified or not user.email_verified_at:
        return False
    return (datetime.utcnow() - user.email_verified_at) <= timedelta(days=VERIFY_VALID_DAYS)


def user_group_ids(db: Session, user_id: int) -> list[int]:
    return [m.group_id for m in db.query(models.GroupMembership).filter(
        models.GroupMembership.user_id == user_id).all()]


# Effective grants = a user's OWN ServicePermission rows ∪ the GroupPermission
# rows of every group they belong to. Helpers below fold both together.
def has_service_grant(db: Session, user_id: int, svc: str) -> bool:
    if db.query(models.ServicePermission).filter(
        models.ServicePermission.user_id == user_id,
        models.ServicePermission.service_name == svc,
        models.ServicePermission.project == "",
    ).first() is not None:
        return True
    gids = user_group_ids(db, user_id)
    if not gids:
        return False
    return db.query(models.GroupPermission).filter(
        models.GroupPermission.group_id.in_(gids),
        models.GroupPermission.service_name == svc,
        models.GroupPermission.project == "",
    ).first() is not None


def project_grants(db: Session, user_id: int, svc: str) -> set[str]:
    out = {r.project for r in db.query(models.ServicePermission).filter(
        models.ServicePermission.user_id == user_id,
        models.ServicePermission.service_name == svc,
        models.ServicePermission.project != "",
    ).all()}
    gids = user_group_ids(db, user_id)
    if gids:
        out |= {r.project for r in db.query(models.GroupPermission).filter(
            models.GroupPermission.group_id.in_(gids),
            models.GroupPermission.service_name == svc,
            models.GroupPermission.project != "",
        ).all()}
    return out


def has_any_grant(db: Session, user_id: int, svc: str) -> bool:
    """Any permission within the service (whole-service or any single project),
    direct OR via a group the user belongs to."""
    if db.query(models.ServicePermission).filter(
        models.ServicePermission.user_id == user_id,
        models.ServicePermission.service_name == svc,
    ).first() is not None:
        return True
    gids = user_group_ids(db, user_id)
    if not gids:
        return False
    return db.query(models.GroupPermission).filter(
        models.GroupPermission.group_id.in_(gids),
        models.GroupPermission.service_name == svc,
    ).first() is not None


def can_enter_project(db: Session, user: models.User, svc: str, proj: str) -> bool:
    if is_admin(user) or is_project_admin(db, user, svc, proj):
        return True
    if not verification_current(user):
        return False
    return has_service_grant(db, user.id, svc) or (proj in project_grants(db, user.id, svc))


def user_from_request(db: Session, token: str | None) -> models.User | None:
    """Resolve a portal user from a raw JWT (used by the proxies, which read it
    from a cookie because a top-level navigation carries no Authorization header)."""
    payload = security.decode_access_token(token) if token else None
    if not payload:
        return None
    u = db.query(models.User).filter(models.User.id == int(payload.get("sub", 0))).first()
    return u if (u and u.is_active) else None
