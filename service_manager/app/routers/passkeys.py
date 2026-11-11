"""Passkeys (WebAuthn) — `/api/auth/passkey/*` and `/api/auth/passkeys`.

A signed-in account registers this device (Touch ID, Face ID, a security key);
afterwards the sign-in page's "Sign in with a passkey" asks the device, and the
account comes from the passkey itself — no username typed. The answer is the
same portal token a password sign-in gets.

The relying party is the host the page is on (the Origin's hostname), so each
portal address registers its own passkeys. Browsers allow WebAuthn only on
https or localhost.
"""
import secrets
import threading
import time
from datetime import datetime
from typing import Any
from urllib.parse import urlparse

import webauthn
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy.orm import Session
from webauthn.helpers import base64url_to_bytes, bytes_to_base64url
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria, PublicKeyCredentialDescriptor,
    ResidentKeyRequirement, UserVerificationRequirement,
)

from .. import config, models, schemas
from ..db import get_db
from ..deps import portal_token, require_portal_user

router = APIRouter(tags=["portal-passkeys"])

# Challenges waiting for their answer, by a one-time state id.
# ponytail: in memory, one process — a restart drops a ceremony in flight, it is just retried.
_TTL = 600                     # a quiet autofill wait can sit a while
_pending: dict = {}
_lock = threading.Lock()


def _put(entry: dict) -> str:
    sid = secrets.token_urlsafe(16)
    now = time.time()
    with _lock:
        for k in [k for k, v in _pending.items() if now - v["t"] > _TTL]:
            _pending.pop(k, None)
        _pending[sid] = {**entry, "t": now}
    return sid


def _take(sid: str, kind: str) -> dict:
    with _lock:
        e = _pending.pop(sid or "", None)
    if not e or e["kind"] != kind or time.time() - e["t"] > _TTL:
        raise HTTPException(status_code=400, detail="Passkey request expired. Try again.")
    return e


def _origin(request: Request) -> tuple:
    """The page's origin and its hostname (= the relying party id)."""
    origin = request.headers.get("origin") or ""
    host = urlparse(origin).hostname
    if not host:
        raise HTTPException(status_code=400, detail="No origin on the request.")
    return origin, host


class FinishBody(BaseModel):
    state: str
    credential: dict[str, Any]
    name: str = ""


# ── a signed-in account adds and removes its passkeys ────────────────────────

@router.post("/api/auth/passkey/register/options")
def register_options(request: Request, db: Session = Depends(get_db),
                     user: models.User = Depends(require_portal_user)):
    _, rp_id = _origin(request)
    mine = db.query(models.Passkey).filter_by(user_id=user.id, rp_id=rp_id).all()
    opts = webauthn.generate_registration_options(
        rp_id=rp_id, rp_name="LILAK portal",
        user_id=str(user.id).encode(), user_name=user.username,
        user_display_name=user.display_name or user.username,
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.REQUIRED,          # usernameless sign-in needs it
            user_verification=UserVerificationRequirement.REQUIRED),
        exclude_credentials=[PublicKeyCredentialDescriptor(id=base64url_to_bytes(p.credential_id)) for p in mine],
    )
    sid = _put({"kind": "reg", "challenge": opts.challenge, "user_id": user.id, "rp_id": rp_id})
    return {"state": sid, "options": webauthn.options_to_json(opts)}


@router.post("/api/auth/passkey/register")
def register_finish(body: FinishBody, request: Request, db: Session = Depends(get_db),
                    user: models.User = Depends(require_portal_user)):
    e = _take(body.state, "reg")
    origin, host = _origin(request)
    if e["user_id"] != user.id or host != e["rp_id"]:
        raise HTTPException(status_code=400, detail="Passkey request does not match.")
    try:
        v = webauthn.verify_registration_response(
            credential=body.credential, expected_challenge=e["challenge"],
            expected_rp_id=e["rp_id"], expected_origin=origin, require_user_verification=True)
    except Exception as ex:  # the library raises several kinds; all mean "not accepted"
        raise HTTPException(status_code=400, detail=f"Passkey not accepted: {ex}")
    cid = bytes_to_base64url(v.credential_id)
    if db.query(models.Passkey).filter_by(credential_id=cid).first():
        raise HTTPException(status_code=409, detail="This passkey is already registered.")
    pk = models.Passkey(user_id=user.id, credential_id=cid,
                        public_key=bytes_to_base64url(v.credential_public_key),
                        sign_count=v.sign_count, rp_id=e["rp_id"],
                        name=(body.name or "").strip()[:64] or "passkey")
    db.add(pk)
    db.commit()
    return _out(pk)


def _out(p: models.Passkey) -> dict:
    return {"id": p.id, "name": p.name, "rp_id": p.rp_id,
            "created_at": p.created_at.isoformat() if p.created_at else None,
            "last_used_at": p.last_used_at.isoformat() if p.last_used_at else None}


@router.get("/api/auth/passkeys")
def list_passkeys(db: Session = Depends(get_db), user: models.User = Depends(require_portal_user)):
    rows = db.query(models.Passkey).filter_by(user_id=user.id).order_by(models.Passkey.id).all()
    return [_out(p) for p in rows]


@router.delete("/api/auth/passkeys/{pid}")
def delete_passkey(pid: int, db: Session = Depends(get_db), user: models.User = Depends(require_portal_user)):
    p = db.query(models.Passkey).filter_by(id=pid, user_id=user.id).first()
    if not p:
        raise HTTPException(status_code=404, detail="No such passkey.")
    db.delete(p)
    db.commit()
    return {"ok": True}


# ── anyone: sign in with one ─────────────────────────────────────────────────

@router.post("/api/auth/passkey/login/options")
def login_options(request: Request):
    _, rp_id = _origin(request)
    # No allow-list: the device offers whatever passkeys it holds for this host.
    opts = webauthn.generate_authentication_options(
        rp_id=rp_id, user_verification=UserVerificationRequirement.REQUIRED)
    sid = _put({"kind": "login", "challenge": opts.challenge, "rp_id": rp_id})
    return {"state": sid, "options": webauthn.options_to_json(opts)}


@router.post("/api/auth/passkey/login", response_model=schemas.TokenResponse)
def login_finish(body: FinishBody, request: Request, db: Session = Depends(get_db)):
    e = _take(body.state, "login")
    origin, host = _origin(request)
    cid = body.credential.get("id") or ""
    pk = db.query(models.Passkey).filter_by(credential_id=cid).first()
    if not pk or host != pk.rp_id or pk.rp_id != e["rp_id"]:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="This passkey is not registered here.")
    try:
        v = webauthn.verify_authentication_response(
            credential=body.credential, expected_challenge=e["challenge"],
            expected_rp_id=pk.rp_id, expected_origin=origin,
            credential_public_key=base64url_to_bytes(pk.public_key),
            credential_current_sign_count=pk.sign_count, require_user_verification=True)
    except Exception as ex:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=f"Passkey not accepted: {ex}")
    user = db.query(models.User).filter(models.User.id == pk.user_id, models.User.is_active == True).first()  # noqa: E712
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="This account is not active.")
    if config.EMAIL_VERIFY_REQUIRED and not user.email_verified:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail={
            "code": "verify_required", "username": user.username, "email": user.email})
    pk.sign_count = v.new_sign_count
    pk.last_used_at = datetime.utcnow()
    db.commit()
    return schemas.TokenResponse(access_token=portal_token(user), user_id=user.id,
                                 username=user.username, role=user.role)
