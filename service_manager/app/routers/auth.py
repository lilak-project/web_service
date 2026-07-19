"""Central portal accounts — `/api/auth/*`. First account becomes the admin.

Email verification (local stub): a new signup is created *unverified* with a
one-time `verify_token`. The "send the link" step is pluggable — in dev the link
is returned + logged (no email provider needed); in production a real sender
(e.g. Firebase) delivers it. Login is blocked until the address is verified.
"""
from __future__ import annotations

import re
import secrets
from html import escape

from fastapi import APIRouter, Depends, Form, HTTPException, status
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session

from .. import config, emailer, models, schemas, security
from ..db import get_db
from ..deps import portal_token, require_portal_user

router = APIRouter(tags=["portal-auth"])

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _verify_url(token: str) -> str:
    return f"{config.BASE_URL}/api/auth/verify?token={token}"


@router.post("/api/auth/login", response_model=schemas.TokenResponse)
def login(payload: schemas.LoginRequest, db: Session = Depends(get_db)):
    user = (
        db.query(models.User)
        .filter(models.User.username == payload.username, models.User.is_active == True)  # noqa: E712
        .first()
    )
    if not user or not security.verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="아이디 또는 비밀번호가 올바르지 않습니다.")
    # Transparently upgrade a legacy (sha256) hash to bcrypt now that we have the
    # plaintext and it verified. One-time, on the account's next login.
    if security.needs_rehash(user.password_hash):
        user.password_hash = security.hash_password(payload.password)
        db.commit()
    if config.EMAIL_VERIFY_REQUIRED and not user.email_verified:
        # Structured 403: the password checked out, so tell the client WHO is
        # pending — the frontend reopens the code-entry screen instead of
        # dead-ending on a "verification required" error (the signup already
        # exists, so re-registering is impossible).
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail={
            "code": "verify_required",
            "username": user.username,
            "email": user.email,
        })
    return schemas.TokenResponse(access_token=portal_token(user), user_id=user.id,
                                 username=user.username, role=user.role)


@router.post("/api/auth/register", status_code=status.HTTP_201_CREATED)
def register(payload: schemas.RegisterRequest, db: Session = Depends(get_db)):
    email = (payload.email or "").strip()
    if not _EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail="올바른 이메일 주소를 입력하세요.")
    if db.query(models.User).filter(models.User.username == payload.username).first():
        raise HTTPException(status_code=400, detail="이미 사용 중인 아이디입니다.")
    if db.query(models.User).filter(models.User.email == email).first():
        raise HTTPException(status_code=400, detail="이미 사용 중인 이메일입니다.")
    if len(payload.password or "") < config.PASSWORD_MIN_LENGTH:
        raise HTTPException(status_code=400,
            detail=f"비밀번호는 최소 {config.PASSWORD_MIN_LENGTH}자 이상이어야 합니다.")

    first = db.query(models.User).count() == 0
    # Sign-up gating: an allow-listed email domain may register freely; anyone else
    # needs a valid invite code. (The first account — the admin — is exempt.) When
    # Firebase Auth is wired, enforce the same in a `beforeCreate` blocking function.
    code = (getattr(payload, "invite_code", None) or "").strip()
    if not first and config.SIGNUP_ALLOWED_DOMAINS:
        domain = email.rsplit("@", 1)[-1].lower()
        from .accounts import code_is_valid
        if domain not in config.SIGNUP_ALLOWED_DOMAINS and not (code and code_is_valid(db, code)):
            raise HTTPException(status_code=403,
                detail="허용된 이메일 도메인이 아닙니다. 가입하려면 유효한 초대 코드가 필요합니다.")
    token = f"{secrets.randbelow(1_000_000):06d}"
    # An invite code flagged `no_verify` approves the signup without email verification.
    from .accounts import code_no_verify
    verified = (not config.EMAIL_VERIFY_REQUIRED) or bool(code and code_no_verify(db, code))
    from datetime import datetime as _dt
    user = models.User(
        username=payload.username,
        display_name=payload.display_name or payload.username,
        email=email,
        role="manager" if first else "user",
        is_active=True,
        email_verified=verified,
        email_verified_at=_dt.utcnow() if verified else None,
        verify_token=None if verified else token,
        password_hash=security.hash_password(payload.password),
    )

    if config.EMAIL_VERIFY_REQUIRED and not verified:
        try:
            emailer.send_verification_email(email, token)
        except emailer.EmailDeliveryError as exc:
            print(f"[email-verify] delivery failed for {email}: {exc}", flush=True)
            if not config.EMAIL_VERIFY_DEV_ECHO:
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail="인증 메일 발송에 실패했습니다. 잠시 후 다시 시도하세요.",
                )

    db.add(user)
    db.commit()
    db.refresh(user)

    # Optional invite code → instant project permission (no admin approval).
    redeemed = None
    code = (getattr(payload, "invite_code", None) or "").strip()
    if code:
        from .accounts import redeem_code
        try:
            redeemed = redeem_code(db, user.id, code)
        except ValueError:
            redeemed = {"error": "유효하지 않은 코드"}

    if verified:
        # Verification disabled or bypassed by a trusted invite code → immediate login.
        return {"verify_required": False, "access_token": portal_token(user),
                "user_id": user.id, "username": user.username, "role": user.role,
                "redeemed": redeemed}

    print(f"[email-verify] sent 6-digit code to {email}", flush=True)
    return {
        "verify_required": True,
        "email": email,
        "username": user.username,
        "message": "인증 메일을 보냈습니다. 메일의 6자리 코드를 입력하세요.",
        # Dev convenience only — omitted once a real sender is wired up.
        "verify_code": token if config.EMAIL_VERIFY_DEV_ECHO else None,
        "redeemed": redeemed,
    }


@router.post("/api/auth/verify-code", response_model=schemas.TokenResponse)
def verify_code(payload: schemas.VerifyCodeRequest, db: Session = Depends(get_db)):
    code = re.sub(r"\D", "", payload.code or "")
    user = (
        db.query(models.User)
        .filter(
            models.User.username == (payload.username or "").strip(),
            models.User.is_active == True,  # noqa: E712
        )
        .first()
    )
    if not user or user.email_verified or not user.verify_token or user.verify_token != code:
        raise HTTPException(status_code=400, detail="인증 코드가 올바르지 않습니다.")
    from datetime import datetime as _dt
    user.email_verified = True
    user.email_verified_at = _dt.utcnow()
    user.verify_token = None
    db.commit()
    return schemas.TokenResponse(access_token=portal_token(user), user_id=user.id,
                                 username=user.username, role=user.role)


@router.post("/api/auth/register-cancel")
def register_cancel(payload: schemas.LoginRequest, db: Session = Depends(get_db)):
    """Abandon a signup stuck at email verification: delete the still-unverified
    account so its username/email become free again. Requires the password so a
    third party can't cancel someone's pending signup knowing only the username.
    A verified account is never deletable this way (that's DELETE /api/account)."""
    user = (
        db.query(models.User)
        .filter(models.User.username == (payload.username or "").strip())
        .first()
    )
    if not user or not security.verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="아이디 또는 비밀번호가 올바르지 않습니다.")
    if user.email_verified:
        raise HTTPException(status_code=400, detail="이미 인증이 완료된 계정입니다.")
    # Same cleanup as account deletion — an invite code redeemed at signup may
    # have granted permission/membership rows already.
    db.query(models.ServicePermission).filter(models.ServicePermission.user_id == user.id).delete()
    db.query(models.AccessRequest).filter(models.AccessRequest.user_id == user.id).delete()
    db.query(models.GroupMembership).filter(models.GroupMembership.user_id == user.id).delete()
    db.delete(user)
    db.commit()
    return {"deleted": True}


def _verify_page(title: str, body: str, ok: bool, token: str | None = None) -> str:
    color = "#2f9e44" if ok else "#e03131"
    action = ""
    if token:
        safe_token = escape(token, quote=True)
        action = f"""
  <form method="post" action="/api/auth/verify" style="margin-top:16px">
    <input type="hidden" name="token" value="{safe_token}">
    <button type="submit" style="display:inline-block;padding:8px 18px;
       border:2px solid #14140f;border-radius:8px;background:#ffd23f;color:#14140f;
       text-decoration:none;font-weight:600;cursor:pointer">이메일 인증하기</button>
  </form>"""
    else:
        action = """
  <a href="/projects" style="display:inline-block;margin-top:12px;padding:8px 18px;
     border:2px solid #14140f;border-radius:8px;background:#ffd23f;color:#14140f;
     text-decoration:none;font-weight:600">로그인하러 가기</a>"""
    return f"""<!doctype html><meta charset="utf-8">
<title>{title}</title>
<div style="font:16px/1.6 system-ui,sans-serif;max-width:420px;margin:80px auto;text-align:center">
  <div style="font-size:40px">{'✓' if ok else '✕'}</div>
  <h2 style="color:{color};margin:.3em 0">{title}</h2>
  <p style="color:#555">{body}</p>
  {action}
</div>"""


def _verify_token(token: str, db: Session) -> HTMLResponse:
    user = db.query(models.User).filter(models.User.verify_token == token).first()
    if not user:
        return HTMLResponse(_verify_page("인증 링크가 유효하지 않습니다",
                                         "이미 인증되었거나 만료된 링크일 수 있습니다.", False),
                            status_code=400)
    from datetime import datetime as _dt
    user.email_verified = True
    user.email_verified_at = _dt.utcnow()
    user.verify_token = None
    db.commit()
    return HTMLResponse(_verify_page("이메일 인증 완료",
                                     f"{user.username} 계정이 활성화되었습니다. 이제 로그인할 수 있습니다.", True))


@router.get("/api/auth/verify", response_class=HTMLResponse)
def verify_prompt(token: str, db: Session = Depends(get_db)):
    return HTMLResponse(_verify_page("이메일 인증",
                                     "메일 보안 스캐너의 자동 인증을 막기 위해 아래 버튼을 눌러 인증을 완료하세요.",
                                     True, token=token))


@router.post("/api/auth/verify", response_class=HTMLResponse)
def verify_submit(token: str = Form(...), db: Session = Depends(get_db)):
    return _verify_token(token, db)


@router.get("/api/auth/me", response_model=schemas.UserOut)
def me(current_user: models.User = Depends(require_portal_user)):
    return current_user


@router.post("/api/auth/logout")
def logout(_: models.User = Depends(require_portal_user)):
    return {"ok": True}
