"""Portal chat — `/api/chat/*`: the speech bubbles over the cover.

Rooms: "portal" (everyone signed in) and "system" (each account's own: what it
says there goes to the platform agent, and the cover reads `/commands` there
before anything is sent) always exist. A project's room "svc/proj" exists once
someone who may enter the project opens it (POST /api/chat/rooms); only those
who may enter it read or write it. Messages are plain text with @mentions, an
optional reply, and files. `@agent <task>` in a project room hands the task to
that project's platform agent (/api/agent/runs); the message keeps the run, and
its answer is shown under it when the worker has one.

The client polls (`after=<last id>`), as the kit's community chat does.
"""
import json
import re
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import config, models, permissions, prefs, project_runtime, registry
from ..db import get_db
from ..deps import require_portal_user
from . import agent

router = APIRouter(tags=["portal-chat"])

PORTAL_ROOM = "portal"
SYSTEM_ROOM = "system"           # each account's own; stored as "system:<user id>"
MAX_FILE = 20 * 1024 * 1024
AGENT_RE = re.compile(r"(^|\s)@agent\b", re.I)


def _uploads() -> Path:
    d = config.DATA_ROOT / "_portal" / "chat_uploads"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _check_room(db: Session, user: models.User, room: str) -> str:
    """The room as stored, if this account may use it."""
    if room == PORTAL_ROOM:
        return room
    if room == SYSTEM_ROOM:
        return f"{SYSTEM_ROOM}:{user.id}"
    svc, _, proj = room.partition("/")
    if not (registry.valid_name(svc) and registry.valid_name(proj)):
        raise HTTPException(400, "방 이름이 올바르지 않습니다.")
    if not permissions.can_enter_project(db, user, svc, proj):
        raise HTTPException(403, "이 프로젝트 방에 들어갈 권한이 없습니다.")
    if not db.query(models.ChatRoom).filter_by(key=room).first():
        raise HTTPException(404, "아직 열지 않은 방입니다.")
    return room


def _room_admin(db: Session, user: models.User, room: str) -> bool:
    """Who may clear someone else's message: a manager anywhere, a project's admin in its room."""
    if room.startswith(SYSTEM_ROOM + ":"):
        return room == f"{SYSTEM_ROOM}:{user.id}"
    svc, _, proj = room.partition("/")
    return permissions.is_admin(user) or (bool(proj) and permissions.is_project_admin(db, user, svc, proj))


def _members(db: Session, room: str) -> list:
    """The accounts that can read `room`: who an @mention can reach.
    # ponytail: asks can_enter_project per account — fine for tens of accounts; one
    # joined query over the grants when there are hundreds."""
    users = db.query(models.User).filter(models.User.is_active == True).order_by(models.User.username).all()  # noqa: E712
    if room == PORTAL_ROOM:
        return users
    if room.startswith(SYSTEM_ROOM + ":"):
        return [u for u in users if f"{SYSTEM_ROOM}:{u.id}" == room]
    svc, _, proj = room.partition("/")
    return [u for u in users if permissions.can_enter_project(db, u, svc, proj)]


def _mentions(db: Session, user: models.User, room: str, body: str) -> list[int]:
    """The account ids `body` @mentions, among the room's members, by id or by display name
    (longest name first, so `@kim.lee` is not also `@kim`). `@all` is every member, and only
    from someone who runs the room; 0 stands for it."""
    if "@" not in body:
        return []
    low, ids = body.lower(), []

    def take(name: str) -> bool:
        nonlocal low
        if not name:
            return False
        pat = re.compile(r"(?<![\w@])@" + re.escape(name.lower()) + r"(?![a-z0-9_])")   # `@lee님` is still lee
        hit = bool(pat.search(low))
        low = pat.sub(lambda m: " " * len(m.group()), low)
        return hit

    names = [(n, u.id) for u in _members(db, room) if u.id != user.id for n in {u.username, u.display_name} if n]
    for name, uid in sorted(names, key=lambda x: -len(x[0])):
        if take(name) and uid not in ids:
            ids.append(uid)
    if take("all") and _room_admin(db, user, room):
        ids.append(0)
    return ids


@router.get("/api/chat/members")
def members(room: str, db: Session = Depends(get_db), user: models.User = Depends(require_portal_user)):
    """Who can be @mentioned here — names and icons only."""
    room = _check_room(db, user, room)
    return [{"id": u.id, "username": u.username, "name": u.display_name or u.username,
             "shape": u.profile_shape, "color": u.profile_color, "admin": permissions.is_admin(u)}
            for u in _members(db, room)]


class ReadBody(BaseModel):
    room: str
    id: int


@router.post("/api/chat/read")
def read(b: ReadBody, db: Session = Depends(get_db), user: models.User = Depends(require_portal_user)):
    """This account has read `room` up to message `id` — kept on the account, so the
    count is the same in every browser."""
    room = _check_room(db, user, b.room)
    seen = dict(prefs.get(user).get("chat_read") or {})
    if b.id > int(seen.get(room) or 0):
        seen[room] = b.id
        prefs.put(user, chat_read=seen)
        db.commit()
    return {"ok": True}


@router.get("/api/chat/unread")
def unread(db: Session = Depends(get_db), user: models.User = Depends(require_portal_user)):
    """Per room: messages since this account last read it, and how many of them mention
    it. A room never opened counts its mentions only — not its whole history."""
    from sqlalchemy import or_
    seen = prefs.get(user).get("chat_read") or {}
    # Asked every 20 s by every open cover: only the rooms something waits in are checked for
    # entry (once each), not every project of every service as rooms() lists them.
    # ponytail: the newest 500 candidates, counted here; a GROUP BY when rooms get busy.
    rows = db.query(models.ChatMessage).filter(
        models.ChatMessage.deleted == False, models.ChatMessage.user_id != user.id,  # noqa: E712
        or_(models.ChatMessage.room.in_(list(seen)), models.ChatMessage.mentions_json != "[]"),
    ).order_by(models.ChatMessage.id.desc()).limit(500).all()
    may: dict = {}

    def enters(room: str) -> bool:
        if room not in may:
            svc, _, proj = room.partition("/")
            may[room] = (room == PORTAL_ROOM or room == f"{SYSTEM_ROOM}:{user.id}"
                         or (bool(proj) and permissions.can_enter_project(db, user, svc, proj)))
        return may[room]

    out = {}
    for m in rows:
        if m.id <= int(seen.get(m.room) or 0) or not enters(m.room):
            continue
        at = json.loads(m.mentions_json or "[]")
        c = out.setdefault(m.room, {"unread": 0, "mentions": 0})
        c["unread"] += m.room in seen
        c["mentions"] += (user.id in at or 0 in at)
    out = {k: v for k, v in out.items() if v["unread"] or v["mentions"]}
    return {"rooms": out, "unread": sum(v["unread"] for v in out.values()),
            "mentions": sum(v["mentions"] for v in out.values())}


def _project_rooms(db: Session, user: models.User) -> list[dict]:
    """Every project this account may enter, as a room would be named."""
    out = []
    for svc in registry.list_service_names():
        try:
            m = registry.read_manifest(svc)
        except Exception:  # a broken manifest is not a reason to lose the list
            continue
        if not (m.get("capabilities") or {}).get("multi_project"):
            continue
        for p in project_runtime.list_projects(svc):
            if permissions.can_enter_project(db, user, svc, p["name"]):
                out.append({"key": f"{svc}/{p['name']}", "service": svc, "project": p["name"],
                            "label": p.get("label") or p["name"], "service_label": m.get("label") or svc})
    return out


def _label(db: Session, key: str) -> dict:
    svc, _, proj = key.partition("/")
    try:
        sl = registry.read_manifest(svc).get("label") or svc
    except Exception:
        sl = svc
    pl = next((p.get("label") for p in project_runtime.list_projects(svc) if p["name"] == proj), None) or proj
    return {"key": key, "service": svc, "project": proj, "label": pl, "service_label": sl}


@router.get("/api/chat/rooms")
def rooms(db: Session = Depends(get_db), user: models.User = Depends(require_portal_user)):
    """The portal room, this account's system room, then the project rooms opened so
    far that it may enter. (A project with no room is offered by /api/chat/rooms/new.)"""
    # Rooms that had messages before rooms were opened by hand count as opened.
    have = {r.key for r in db.query(models.ChatRoom).all()}
    for (k,) in db.query(models.ChatMessage.room).distinct().all():
        if "/" in k and ":" not in k and k not in have:
            db.add(models.ChatRoom(key=k))
            have.add(k)
    db.commit()
    out = [{"key": PORTAL_ROOM}, {"key": SYSTEM_ROOM}]
    for k in sorted(have):
        svc, _, proj = k.partition("/")
        if permissions.can_enter_project(db, user, svc, proj):
            out.append(_label(db, k))
    return out


@router.get("/api/chat/rooms/new")
def new_rooms(db: Session = Depends(get_db), user: models.User = Depends(require_portal_user)):
    """Projects this account may enter that have no room yet."""
    have = {r.key for r in db.query(models.ChatRoom).all()}
    return [r for r in _project_rooms(db, user) if r["key"] not in have]


class RoomBody(BaseModel):
    service: str
    project: str


@router.post("/api/chat/rooms")
def open_room(b: RoomBody, db: Session = Depends(get_db), user: models.User = Depends(require_portal_user)):
    """Open a project's room. Anyone who may enter the project may; the room is then
    there for everyone else who may enter it too."""
    if not (registry.valid_name(b.service) and registry.valid_name(b.project)):
        raise HTTPException(400, "방 이름이 올바르지 않습니다.")
    if not permissions.can_enter_project(db, user, b.service, b.project):
        raise HTTPException(403, "이 프로젝트 방에 들어갈 권한이 없습니다.")
    key = f"{b.service}/{b.project}"
    if not db.query(models.ChatRoom).filter_by(key=key).first():
        db.add(models.ChatRoom(key=key, created_by=user.id))
        db.commit()
    return _label(db, key)


def _out(m: models.ChatMessage, runs: dict, by_id: dict, users: dict | None = None) -> dict:
    r = runs.get(m.run_id) if m.run_id else None
    u = (users or {}).get(m.user_id)
    reply = by_id.get(m.reply_to_id) if m.reply_to_id else None
    if reply and reply.room != m.room:      # rows from before send() checked: never quote another room
        reply = None
    return {
        "id": m.id, "room": m.room, "user_id": m.user_id, "author_name": m.author_name,
        # The author's account icon, drawn as the cover draws it (a manager's is black).
        "author_username": u.username if u else None,
        "author_shape": u.profile_shape if u else None,
        "author_color": u.profile_color if u else None,
        "author_admin": bool(u and permissions.is_admin(u)),
        "via": getattr(m, "via", "") or "",
        "body": "" if m.deleted else m.body, "deleted": m.deleted,
        "reply_to_id": m.reply_to_id,
        "reply_to_author": reply.author_name if reply else None,
        "reply_to_body": (reply.body[:120] if reply and not reply.deleted else None),
        "attachments": [] if m.deleted else json.loads(m.attachments_json or "[]"),
        "mentions": [] if m.deleted else json.loads(m.mentions_json or "[]"),
        "run": ({"id": r.id, "status": r.status, "result": r.result} if r else None),
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


@router.get("/api/chat/messages")
def messages(room: str, after: int = 0, before: int = 0, db: Session = Depends(get_db),
             user: models.User = Depends(require_portal_user)):
    room = _check_room(db, user, room)
    q = db.query(models.ChatMessage).filter_by(room=room)
    if before:      # the 80 before that one: paging back through the room
        rows = list(reversed(q.filter(models.ChatMessage.id < before).order_by(models.ChatMessage.id.desc()).limit(80).all()))
    elif after:
        rows = q.filter(models.ChatMessage.id > after).order_by(models.ChatMessage.id).limit(200).all()
    else:
        rows = list(reversed(q.order_by(models.ChatMessage.id.desc()).limit(80).all()))
    # A pending agent answer has to come back on a later poll: hand back the
    # messages still waiting too, so the client can update them in place.
    waiting = (q.filter(models.ChatMessage.run_id.isnot(None), models.ChatMessage.id <= after)
               .order_by(models.ChatMessage.id.desc()).limit(20).all() if after else [])
    run_ids = {m.run_id for m in rows + waiting if m.run_id}
    runs = {r.id: r for r in db.query(models.AgentRun).filter(models.AgentRun.id.in_(run_ids)).all()} if run_ids else {}
    waiting = [m for m in waiting if runs.get(m.run_id) and runs[m.run_id].status in ("queued", "running", "done", "failed")]
    reply_ids = {m.reply_to_id for m in rows if m.reply_to_id}
    by_id = {m.id: m for m in db.query(models.ChatMessage).filter(models.ChatMessage.id.in_(reply_ids)).all()} if reply_ids else {}
    uids = {m.user_id for m in rows + waiting if m.user_id}
    users = {u.id: u for u in db.query(models.User).filter(models.User.id.in_(uids)).all()} if uids else {}
    return {"me": {"id": user.id, "name": user.display_name or user.username, "admin": _room_admin(db, user, room)},
            "messages": [_out(m, runs, by_id, users) for m in rows],
            "updates": [_out(m, runs, by_id, users) for m in waiting]}


class SendBody(BaseModel):
    room: str
    body: str = ""
    reply_to_id: Optional[int] = None
    attachments: list[dict] = []


@router.post("/api/chat/messages")
def send(b: SendBody, db: Session = Depends(get_db), user: models.User = Depends(require_portal_user)):
    return post(b, db, user)


def post(b: SendBody, db: Session, user: models.User, via: str = "") -> dict:
    """Send `b` as `user`. `via`: the program writing for them (the MCP chat_send tool
    passes its token's name) — never taken from a request, so a page cannot claim one."""
    room = _check_room(db, user, b.room)
    from datetime import datetime, timedelta
    if db.query(models.ChatMessage).filter(models.ChatMessage.user_id == user.id,
            models.ChatMessage.created_at > datetime.utcnow() - timedelta(minutes=1)).count() >= 30:
        raise HTTPException(429, "메시지를 너무 빨리 보내고 있습니다. 잠시 뒤에 다시 보내세요.")
    body = (b.body or "").strip()[:8000]
    atts = [{k: str(a.get(k, ""))[:200] for k in ("id", "name", "type")} | {"size": int(a.get("size") or 0)}
            for a in (b.attachments or [])[:10] if isinstance(a, dict) and re.fullmatch(r"[0-9a-f]{32}(\.\w{1,8})?", str(a.get("id", "")))]
    if not body and not atts:
        raise HTTPException(400, "보낼 내용이 없습니다.")
    # A reply quotes its target (author, first words): only a message of THIS room may be one,
    # or a room you cannot read could be read a quote at a time through one you can.
    target = db.get(models.ChatMessage, b.reply_to_id) if b.reply_to_id else None
    if b.reply_to_id and (not target or target.room != room):
        raise HTTPException(400, "답글을 달 메시지가 이 방에 없습니다.")
    m = models.ChatMessage(room=room, user_id=user.id, author_name=user.display_name or user.username,
                           body=body, reply_to_id=b.reply_to_id, attachments_json=json.dumps(atts, ensure_ascii=False),
                           mentions_json=json.dumps(_mentions(db, user, room, body)), via=(via or "")[:64])
    if room.startswith(SYSTEM_ROOM + ":") and body and not via:
        # The system room is the account talking to the platform agent: every line
        # is a task for it, under the portal's own key (llm_keys "portal").
        try:
            r = agent.add_run(agent.RunBody(service="portal", project="", task=body), db=db, user=user)
        except HTTPException as e:
            if e.status_code == 403:
                raise HTTPException(403, "System 방의 agent는 지금은 매니저만 부를 수 있습니다.")
            raise
        m.run_id = r["id"]
    elif AGENT_RE.search(body):
        if room == PORTAL_ROOM:
            raise HTTPException(400, "@agent는 프로젝트 방에서 부를 수 있습니다.")
        svc, _, proj = room.partition("/")
        task = AGENT_RE.sub(" ", body).strip()
        # The same gate a run started anywhere else goes through (keys, rights).
        r = agent.add_run(agent.RunBody(service=svc, project=proj, task=task), db=db, user=user)
        m.run_id = r["id"]
    db.add(m)
    db.commit()
    return _out(m, {}, {}, {user.id: user})


@router.delete("/api/chat/messages/{mid}")
def delete(mid: int, db: Session = Depends(get_db), user: models.User = Depends(require_portal_user)):
    m = db.get(models.ChatMessage, mid)
    if not m or (m.user_id != user.id and not _room_admin(db, user, m.room)):
        raise HTTPException(404, "그런 메시지가 없습니다.")
    m.deleted = True
    db.commit()
    return {"ok": True}


@router.post("/api/chat/upload")
async def upload(file: UploadFile = File(...), user: models.User = Depends(require_portal_user)):
    from . import auth
    key = f"upload:{user.id}"                  # 20 files a quarter hour: the disk is shared
    if auth._too_many(key, 20):
        auth._slow_down()
    auth._failed(key)
    data = await file.read(MAX_FILE + 1)
    if len(data) > MAX_FILE:
        raise HTTPException(413, "파일이 너무 큽니다 (20MB까지).")
    ext = Path(file.filename or "").suffix.lower()
    ext = ext if re.fullmatch(r"\.\w{1,8}", ext or "") else ""
    fid = uuid.uuid4().hex + ext
    (_uploads() / fid).write_bytes(data)
    return {"id": fid, "name": (file.filename or fid)[:200], "type": (file.content_type or "")[:100], "size": len(data)}


@router.get("/api/chat/files/{fid}")
def file(fid: str, room: str, db: Session = Depends(get_db), user: models.User = Depends(require_portal_user)):
    """A file, to someone who can read a room it was posted in."""
    if not re.fullmatch(r"[0-9a-f]{32}(\.\w{1,8})?", fid):
        raise HTTPException(404, "없음")
    room = _check_room(db, user, room)
    hit = db.query(models.ChatMessage).filter(models.ChatMessage.room == room, models.ChatMessage.deleted == False,  # noqa: E712
                                              models.ChatMessage.attachments_json.contains(fid)).first()
    p = _uploads() / fid
    if not hit or not p.is_file():
        raise HTTPException(404, "없음")
    name = next((a.get("name") for a in json.loads(hit.attachments_json) if a.get("id") == fid), fid)
    return FileResponse(p, filename=name)
