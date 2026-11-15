"""Platform agents — `/api/agent/*`: the AI keys the portal holds, and the runs
handed to an agent. The agent itself runs in a separate worker
(app/agent_worker.py); this only records what was asked and shows what came of it.

Keys: a manager manages every key; a project's admin may add or change keys whose
uses are only projects they administer (never the portal default).
Runs: anyone who can enter the project may hand it one.
"""
import json
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import llm_keys, models, permissions, registry
from ..db import get_db
from ..deps import require_portal_user

router = APIRouter(tags=["portal-agent"])

PROVIDERS = ("claude", "openai")
KINDS = ("api", "login")
APPROVAL = ("human", "similar", "auto")


def _key_out(k: models.LlmKey) -> dict:
    return {"id": k.id, "name": k.name, "provider": k.provider, "kind": k.kind, "hint": k.hint,
            "uses": llm_keys.uses(k), "created_by": k.created_by,
            "created_at": k.created_at.isoformat() if k.created_at else None,
            "last_used_at": k.last_used_at.isoformat() if k.last_used_at else None}


def _may_use(db: Session, user: models.User, use: str) -> bool:
    """May this account aim a key at `use`? The portal default is a manager's."""
    if permissions.is_admin(user):
        return use == "portal" or "/" in use
    svc, _, proj = use.partition("/")
    return bool(proj) and permissions.is_project_admin(db, user, svc, proj)


def _may_manage(db: Session, user: models.User, k: models.LlmKey) -> bool:
    if permissions.is_admin(user):
        return True
    u = llm_keys.uses(k)
    return bool(u) and all(_may_use(db, user, x) for x in u)


class KeyBody(BaseModel):
    name: Optional[str] = None
    provider: Optional[str] = None
    kind: Optional[str] = None
    secret: Optional[str] = None
    uses: Optional[list[str]] = None


def _clean_uses(db: Session, user: models.User, uses: list) -> list:
    out = list(dict.fromkeys(str(u).strip() for u in uses if str(u).strip()))
    bad = [u for u in out if not _may_use(db, user, u)]
    if bad:
        raise HTTPException(403, f"이 쓰임새에는 키를 붙일 수 없습니다: {', '.join(bad)}")
    return out


@router.get("/api/agent/keys")
def list_keys(db: Session = Depends(get_db), user: models.User = Depends(require_portal_user)):
    rows = db.query(models.LlmKey).order_by(models.LlmKey.id).all()
    return [_key_out(k) for k in rows if _may_manage(db, user, k) or k.created_by == user.id]


@router.post("/api/agent/keys")
def add_key(body: KeyBody, db: Session = Depends(get_db), user: models.User = Depends(require_portal_user)):
    if body.provider not in PROVIDERS or body.kind not in KINDS:
        raise HTTPException(400, "종류가 올바르지 않습니다.")
    secret = (body.secret or "").strip()
    if body.kind == "api" and not secret:
        raise HTTPException(400, "API 키를 넣어 주세요.")
    uses = _clean_uses(db, user, body.uses or [])
    if not uses:
        raise HTTPException(400, "쓰임새를 하나 이상 고르세요.")
    k = models.LlmKey(name=(body.name or "").strip()[:64] or body.provider, provider=body.provider, kind=body.kind,
                      secret=llm_keys.seal(secret) if body.kind == "api" else None,
                      hint=(secret[:7] + "…") if body.kind == "api" else "login",
                      uses=json.dumps(uses), created_by=user.id)
    db.add(k)
    db.commit()
    return _key_out(k)


@router.put("/api/agent/keys/{kid}")
def change_key(kid: int, body: KeyBody, db: Session = Depends(get_db), user: models.User = Depends(require_portal_user)):
    k = db.get(models.LlmKey, kid)
    if not k or not _may_manage(db, user, k):
        raise HTTPException(404, "그런 키가 없습니다.")
    if body.name is not None:
        k.name = body.name.strip()[:64] or k.name
    if body.uses is not None:
        uses = _clean_uses(db, user, body.uses)
        if not uses:
            raise HTTPException(400, "쓰임새를 하나 이상 고르세요.")
        k.uses = json.dumps(uses)
    if body.secret and k.kind == "api":
        k.secret, k.hint = llm_keys.seal(body.secret.strip()), body.secret.strip()[:7] + "…"
    db.commit()
    return _key_out(k)


@router.delete("/api/agent/keys/{kid}")
def delete_key(kid: int, db: Session = Depends(get_db), user: models.User = Depends(require_portal_user)):
    k = db.get(models.LlmKey, kid)
    if not k or not _may_manage(db, user, k):
        raise HTTPException(404, "그런 키가 없습니다.")
    db.delete(k)
    db.commit()
    return {"ok": True}


# ── runs ─────────────────────────────────────────────────────────────────────

def _run_out(r: models.AgentRun) -> dict:
    t = lambda d: d.isoformat() if d else None  # noqa: E731
    return {"id": r.id, "user_id": r.user_id, "service": r.service, "project": r.project, "provider": r.provider,
            "model": r.model, "approval": r.approval, "task": r.task, "status": r.status, "key_id": r.key_id,
            "result": r.result, "tokens_in": r.tokens_in, "tokens_out": r.tokens_out, "cost_usd": r.cost_usd,
            "created_at": t(r.created_at), "started_at": t(r.started_at), "finished_at": t(r.finished_at)}


class RunBody(BaseModel):
    service: str
    project: str = ""
    task: str
    provider: str = "claude"
    approval: str = "human"
    model: str = ""


@router.post("/api/agent/runs")
def add_run(body: RunBody, db: Session = Depends(get_db), user: models.User = Depends(require_portal_user)):
    if body.provider not in PROVIDERS or body.approval not in APPROVAL:
        raise HTTPException(400, "종류가 올바르지 않습니다.")
    if not registry.valid_name(body.service) or (body.project and not registry.valid_name(body.project)):
        raise HTTPException(400, "서비스나 프로젝트 이름이 올바르지 않습니다.")
    if not permissions.can_enter_project(db, user, body.service, body.project):
        raise HTTPException(403, "이 프로젝트에 들어갈 권한이 없습니다.")
    if not body.task.strip():
        raise HTTPException(400, "맡길 일을 적어 주세요.")
    if not llm_keys.choose(db, body.provider, body.service, body.project):
        raise HTTPException(400, f"이 프로젝트에 쓸 {body.provider} 키가 없습니다.")
    r = models.AgentRun(user_id=user.id, service=body.service, project=body.project, provider=body.provider,
                        model=body.model.strip()[:64], approval=body.approval, task=body.task.strip()[:20000])
    db.add(r)
    db.commit()
    return _run_out(r)


@router.get("/api/agent/runs")
def list_runs(db: Session = Depends(get_db), user: models.User = Depends(require_portal_user)):
    q = db.query(models.AgentRun)
    if not permissions.is_admin(user):
        q = q.filter_by(user_id=user.id)
    return [_run_out(r) for r in q.order_by(models.AgentRun.id.desc()).limit(100).all()]


@router.get("/api/agent/runs/{rid}")
def get_run(rid: int, db: Session = Depends(get_db), user: models.User = Depends(require_portal_user)):
    r = db.get(models.AgentRun, rid)
    if not r or (r.user_id != user.id and not permissions.is_admin(user)):
        raise HTTPException(404, "그런 실행이 없습니다.")
    return _run_out(r)
