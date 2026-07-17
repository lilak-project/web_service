"""Shared FastAPI dependencies + portal token minting."""
from __future__ import annotations

from typing import Optional

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy.orm import Session

from . import config, models, security
from .db import get_db


def portal_token(user: models.User) -> str:
    """Mint a portal token carrying `portal: true` + the account profile, so a
    service can link/provision a matching local user on entry."""
    return security.create_access_token(user.id, user.username, user.role, extra={
        "portal": True,
        "email": user.email,
        "name": user.display_name,
        # admins always carry the reserved MANAGER_COLOR (elog applies the same rule);
        # a stale reserved colour is dropped rather than mirrored into the service.
        "color": config.avatar_color(manager=user.role == "manager", stored=user.profile_color),
        "shape": user.profile_shape,
        "prole": user.role,
        # rest of the elog-style profile, so elog provisions a full mirror
        "phone": user.phone,
        "erole": user.experiment_role,
        "pfrom": user.participation_from,
        "pto": user.participation_to,
    })


def require_portal_user(
    authorization: Optional[str] = Header(default=None),
    db: Session = Depends(get_db),
) -> models.User:
    token = security.bearer(authorization)
    payload = security.decode_access_token(token) if token else None
    # Require the `portal: true` claim (every portal-minted token carries it, see
    # portal_token). Without this, a token issued by a MANAGED service for its own
    # local user — same HS256 secret, no `portal` claim — would authenticate here if
    # its `sub` collided with a portal user id (token confusion across trust domains).
    if not payload or not payload.get("portal"):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="로그인이 필요합니다.")
    user = db.query(models.User).filter(models.User.id == int(payload.get("sub", 0))).first()
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="로그인이 필요합니다.")
    return user


def require_portal_admin(user: models.User = Depends(require_portal_user)) -> models.User:
    if user.role != "manager":
        raise HTTPException(status_code=403, detail="관리자 권한이 필요합니다.")
    return user
