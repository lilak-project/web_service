"""
community.py — reusable community/chat backend for LILAK services (SQLite).

Drop-in: build a router and include it. The host supplies an `identity`
dependency (portal SSO → {authenticated,email,username,name,role}) and paths.

    from community import build_community_router
    app.include_router(build_community_router(
        db_path=DATA / "community.db",
        uploads_dir=DATA / "community_uploads",
        identity=identity,                 # from portal_auth
    ))

Frontend: pair with the kit <Community> via the matching api adapter (see
lilak_ui demo/community.jsx `realApi`). Endpoints, all under /api/community:
  GET  messages · POST messages · POST upload · GET files/{name}
  DELETE messages/{id} · POST clear · GET users · POST ban
  GET  questions · GET completed · POST complete/{id}
  GET  anon-identity · GET polls · POST polls · POST polls/{id}/vote · POST polls/{id}/close

Anonymity: an anon identity (name+icon) is assigned on first contact and kept.
Anon messages carry an opaque author key; the real name is returned ONLY to
managers. The anon name pool (surnames × given names) is editable at runtime
via set_anon_names() (wire an admin settings screen to it).
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Callable, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File
from fastapi.responses import FileResponse

# ── anon name pool: 20 surnames × 100 given names (mixed M/F). Editable. ──────
_SURNAMES = ["김", "이", "박", "최", "정", "강", "조", "윤", "장", "임",
             "한", "오", "서", "신", "권", "황", "안", "송", "류", "홍"]
_GIVEN = [
    "민준", "서준", "예준", "도윤", "시우", "주원", "하준", "지호", "지후", "준서",
    "준우", "현우", "도현", "지훈", "건우", "우진", "선우", "서진", "민재", "현준",
    "연우", "유준", "정우", "승우", "승현", "시윤", "준혁", "은우", "지환", "승민",
    "지우", "유찬", "윤우", "민성", "준영", "이준", "윤호", "시후", "진우", "지완",
    "태윤", "재윤", "재원", "동현", "은호", "우빈", "규민", "찬우", "성현", "정현",
    "서연", "서윤", "지우", "서현", "민서", "하은", "하윤", "윤서", "지유", "지민",
    "채원", "수아", "지아", "지윤", "은서", "다은", "예은", "수빈", "소율", "예린",
    "수현", "예원", "지현", "예서", "서영", "유진", "채은", "윤아", "지안", "혜원",
    "가은", "지원", "소연", "예진", "주아", "유나", "가윤", "시아", "서율", "나윤",
    "아린", "유주", "예나", "채윤", "다인", "소은", "은채", "연서", "수민", "지수",
]

# icons that exist in the kit ICONS map (anon avatar draws these outline)
_ICONS = ["flask", "robot", "moon", "dna", "magnet", "pulse", "waveform",
          "microscope", "thermometer", "cpu", "gauge", "flow", "tree", "map",
          "bell", "key", "star", "planet", "atom", "cat"]
_COLORS = ["#0d9488", "#6366f1", "#f59e0b", "#ef4444", "#8b5cf6", "#10b981",
           "#3b82f6", "#ec4899", "#14b8a6", "#f97316"]

_MENTION_RE = re.compile(r"@([A-Za-z0-9_가-힣]+)")


def set_anon_names(surnames: list[str] | None = None, given: list[str] | None = None) -> None:
    """Replace the anon name pool at runtime (admin-editable)."""
    global _SURNAMES, _GIVEN
    if surnames:
        _SURNAMES = list(surnames)
    if given:
        _GIVEN = list(given)


def _pick(seed: str, pool: list) -> str:
    h = int(hashlib.sha256(seed.encode()).hexdigest(), 16)
    return pool[h % len(pool)]


def build_community_router(*, db_path: Path, uploads_dir: Path, identity: Callable) -> APIRouter:
    db_path = Path(db_path)
    uploads_dir = Path(uploads_dir)
    uploads_dir.mkdir(parents=True, exist_ok=True)
    db_path.parent.mkdir(parents=True, exist_ok=True)

    def conn():
        c = sqlite3.connect(db_path)
        c.row_factory = sqlite3.Row
        return c

    with conn() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS cm_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            author_key TEXT, author_name TEXT, author_color TEXT, author_shape TEXT,
            anon INTEGER DEFAULT 0, real_key TEXT, real_name TEXT,
            body TEXT, kind TEXT DEFAULT 'msg', done INTEGER DEFAULT 0,
            reply_to_id INTEGER DEFAULT 0, attachments TEXT DEFAULT '[]',
            created_at TEXT
        );
        CREATE TABLE IF NOT EXISTS cm_bans (user_key TEXT PRIMARY KEY, name TEXT);
        CREATE TABLE IF NOT EXISTS cm_anon (real_key TEXT PRIMARY KEY, name TEXT, shape TEXT);
        CREATE TABLE IF NOT EXISTS cm_polls (
            id TEXT PRIMARY KEY, title TEXT, options TEXT, deadline TEXT,
            closed INTEGER DEFAULT 0, owner_key TEXT, created_at TEXT
        );
        CREATE TABLE IF NOT EXISTS cm_votes (poll_id TEXT, user_key TEXT, option_id TEXT,
            PRIMARY KEY (poll_id, user_key));
        CREATE TABLE IF NOT EXISTS cm_config (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS cm_bots (
            name TEXT PRIMARY KEY, provider TEXT, model TEXT, api_key TEXT,
            system TEXT, enabled INTEGER DEFAULT 1
        );
        """)

    # load persisted anon-name pool (if an admin edited it)
    with conn() as c:
        for row in c.execute("SELECT key, value FROM cm_config WHERE key IN ('anon_surnames','anon_given')"):
            try:
                vals = json.loads(row["value"])
                if row["key"] == "anon_surnames" and vals:
                    globals()["_SURNAMES"] = vals
                elif row["key"] == "anon_given" and vals:
                    globals()["_GIVEN"] = vals
            except Exception:
                pass

    presence: dict[str, dict] = {}          # user_key -> {name,color,shape,ts}
    router = APIRouter(prefix="/api/community", tags=["community"])

    # ── identity helpers ──────────────────────────────────────────────────────
    def who(user: dict) -> dict:
        name = user.get("name") or user.get("username") or user.get("email") or "guest"
        key = "u:" + hashlib.sha256((user.get("email") or user.get("username") or name).encode()).hexdigest()[:16]
        return {"key": key, "name": name, "role": user.get("role") or "user",
                "color": _pick(key, _COLORS), "shape": _pick(key, _ICONS)}

    def anon_of(real_key: str) -> dict:
        with conn() as c:
            row = c.execute("SELECT name, shape FROM cm_anon WHERE real_key=?", (real_key,)).fetchone()
            if row:
                return {"name": row["name"], "shape": row["shape"]}
            name = _pick(real_key + ":s", _SURNAMES) + _pick(real_key + ":g", _GIVEN)
            shape = _pick(real_key + ":i", _ICONS)
            c.execute("INSERT INTO cm_anon(real_key,name,shape) VALUES(?,?,?)", (real_key, name, shape))
            return {"name": name, "shape": shape}

    def is_banned(key: str) -> bool:
        with conn() as c:
            return c.execute("SELECT 1 FROM cm_bans WHERE user_key=?", (key,)).fetchone() is not None

    def row_to_msg(r: sqlite3.Row, viewer_is_manager: bool) -> dict:
        m = {
            "id": r["id"], "author_key": r["author_key"], "author_name": r["author_name"],
            "author_color": r["author_color"], "author_shape": r["author_shape"],
            "anon": bool(r["anon"]), "body": r["body"], "kind": r["kind"], "done": bool(r["done"]),
            "reply_to_id": r["reply_to_id"], "attachments": json.loads(r["attachments"] or "[]"),
            "created_at": r["created_at"],
        }
        if r["reply_to_id"]:
            with conn() as c:
                p = c.execute("SELECT author_name, body FROM cm_messages WHERE id=?", (r["reply_to_id"],)).fetchone()
                if p:
                    m["reply_to_author"] = p["author_name"]; m["reply_to_body"] = p["body"]
        if r["anon"] and viewer_is_manager:      # managers alone can unmask
            m["real_name"] = r["real_name"]
        return m

    # ── list / poll ───────────────────────────────────────────────────────────
    @router.get("/messages")
    def list_messages(user: dict = Depends(identity)):
        w = who(user)
        presence[w["key"]] = {"name": w["name"], "color": w["color"], "shape": w["shape"], "ts": time.time()}
        cutoff = time.time() - 15
        online = [{"key": k, **{x: v[x] for x in ("name", "color", "shape")}}
                  for k, v in presence.items() if v["ts"] > cutoff]
        mgr = w["role"] == "manager"
        with conn() as c:
            rows = c.execute("SELECT * FROM cm_messages ORDER BY id DESC LIMIT 150").fetchall()
        msgs = [row_to_msg(r, mgr) for r in reversed(rows)]
        return {"myKey": w["key"], "myRole": w["role"], "banned": is_banned(w["key"]),
                "online": online, "messages": msgs}

    # ── send ──────────────────────────────────────────────────────────────────
    @router.post("/messages")
    def post_message(payload: dict, user: dict = Depends(identity)):
        w = who(user)
        if is_banned(w["key"]):
            raise HTTPException(403, "이용이 제한된 계정입니다.")
        body = (payload.get("body") or "").strip()
        atts = payload.get("attachments") or []
        if not body and not atts:
            raise HTTPException(400, "빈 메시지")
        anon = bool(payload.get("anonymous"))
        if anon:
            ident = anon_of(w["key"])
            author_key = "anon:" + hashlib.sha256(w["key"].encode()).hexdigest()[:16]
            author_name, author_color, author_shape = ident["name"], None, ident["shape"]
        else:
            author_key, author_name, author_color, author_shape = w["key"], w["name"], w["color"], w["shape"]
        kind = "question" if payload.get("kind") == "question" else "msg"
        with conn() as c:
            cur = c.execute(
                """INSERT INTO cm_messages(author_key,author_name,author_color,author_shape,anon,
                   real_key,real_name,body,kind,reply_to_id,attachments,created_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                (author_key, author_name, author_color, author_shape, int(anon),
                 w["key"], w["name"], body, kind, int(payload.get("reply_to_id") or 0),
                 json.dumps(atts), _now()))
            mid = cur.lastrowid
            r = c.execute("SELECT * FROM cm_messages WHERE id=?", (mid,)).fetchone()
        if body:
            trigger_bots(body, mid)      # @bot mentions → async-ish bot replies
        return row_to_msg(r, w["role"] == "manager")

    # ── attachments ───────────────────────────────────────────────────────────
    @router.post("/upload")
    async def upload(file: UploadFile = File(...), user: dict = Depends(identity)):
        ext = Path(file.filename or "file").suffix[:12]
        name = uuid.uuid4().hex + ext
        dest = uploads_dir / name
        data = await file.read()
        dest.write_bytes(data)
        return {"id": name, "name": file.filename or name, "type": file.content_type or "",
                "size": len(data), "url": f"/api/community/files/{name}"}

    @router.get("/files/{name}")
    def get_file(name: str, user: dict = Depends(identity)):
        p = uploads_dir / name
        if ".." in name or not p.is_file():
            raise HTTPException(404, "not found")
        return FileResponse(p)

    # ── moderation ────────────────────────────────────────────────────────────
    def require_manager(user: dict) -> dict:
        w = who(user)
        if w["role"] != "manager":
            raise HTTPException(403, "manager only")
        return w

    @router.delete("/messages/{mid}", status_code=204)
    def delete_message(mid: int, user: dict = Depends(identity)):
        require_manager(user)
        with conn() as c:
            c.execute("DELETE FROM cm_messages WHERE id=?", (mid,))

    @router.post("/clear")
    def clear_all(user: dict = Depends(identity)):
        require_manager(user)
        with conn() as c:
            c.execute("DELETE FROM cm_messages")
        return {"ok": True}

    @router.get("/users")
    def list_users(user: dict = Depends(identity)):
        require_manager(user)
        with conn() as c:
            keys = c.execute("SELECT DISTINCT real_key AS k, real_name AS n FROM cm_messages WHERE real_key IS NOT NULL").fetchall()
            bans = {r["user_key"] for r in c.execute("SELECT user_key FROM cm_bans").fetchall()}
        return {"users": [{"user_key": r["k"], "name": r["n"], "banned": r["k"] in bans} for r in keys if r["k"]]}

    @router.post("/ban")
    def ban(payload: dict, user: dict = Depends(identity)):
        require_manager(user)
        key, name, banned = payload.get("user_key"), payload.get("name"), bool(payload.get("banned"))
        with conn() as c:
            if banned:
                c.execute("INSERT OR REPLACE INTO cm_bans(user_key,name) VALUES(?,?)", (key, name))
            else:
                c.execute("DELETE FROM cm_bans WHERE user_key=?", (key,))
        return {"ok": True}

    # ── questions ─────────────────────────────────────────────────────────────
    @router.get("/questions")
    def questions(user: dict = Depends(identity)):
        w = who(user)
        with conn() as c:
            rows = c.execute("SELECT * FROM cm_messages WHERE kind='question' AND done=0 ORDER BY id").fetchall()
        return {"questions": [row_to_msg(r, w["role"] == "manager") for r in rows]}

    @router.get("/completed")
    def completed(user: dict = Depends(identity)):
        w = who(user)
        with conn() as c:
            rows = c.execute("SELECT * FROM cm_messages WHERE kind='question' AND done=1 ORDER BY id").fetchall()
        return {"questions": [row_to_msg(r, w["role"] == "manager") for r in rows]}

    @router.post("/complete/{mid}")
    def complete(mid: int, user: dict = Depends(identity)):
        require_manager(user)
        with conn() as c:
            c.execute("UPDATE cm_messages SET done=1 WHERE id=? AND kind='question'", (mid,))
        return {"ok": True}

    # ── anonymous identity ────────────────────────────────────────────────────
    @router.get("/anon-identity")
    def anon_identity(user: dict = Depends(identity)):
        return anon_of(who(user)["key"])

    # ── polls ─────────────────────────────────────────────────────────────────
    def poll_out(r: sqlite3.Row, user_key: str) -> dict:
        opts = json.loads(r["options"])
        with conn() as c:
            tallies = {row["option_id"]: row["n"] for row in
                       c.execute("SELECT option_id, COUNT(*) n FROM cm_votes WHERE poll_id=? GROUP BY option_id", (r["id"],)).fetchall()}
            mine = c.execute("SELECT option_id FROM cm_votes WHERE poll_id=? AND user_key=?", (r["id"], user_key)).fetchone()
        return {"id": r["id"], "title": r["title"], "closed": bool(r["closed"]), "deadline": r["deadline"],
                "owner": r["owner_key"], "my_vote": mine["option_id"] if mine else None,
                "options": [{"id": o["id"], "text": o["text"], "votes": tallies.get(o["id"], 0)} for o in opts]}

    @router.get("/polls")
    def list_polls(user: dict = Depends(identity)):
        w = who(user)
        with conn() as c:
            # auto-close past-deadline polls
            c.execute("UPDATE cm_polls SET closed=1 WHERE closed=0 AND deadline IS NOT NULL AND deadline<>'' AND deadline < ?", (_now(),))
            rows = c.execute("SELECT * FROM cm_polls ORDER BY created_at DESC").fetchall()
        return {"polls": [poll_out(r, w["key"]) for r in rows]}

    @router.post("/polls")
    def create_poll(payload: dict, user: dict = Depends(identity)):
        w = require_manager(user)
        title = (payload.get("title") or "").strip()
        opts = [o.strip() for o in (payload.get("options") or []) if o and o.strip()]
        if not title or not opts:
            raise HTTPException(400, "제목과 항목이 필요합니다.")
        pid = uuid.uuid4().hex[:12]
        options = [{"id": f"o{i}", "text": t} for i, t in enumerate(opts)]
        with conn() as c:
            c.execute("INSERT INTO cm_polls(id,title,options,deadline,owner_key,created_at) VALUES(?,?,?,?,?,?)",
                      (pid, title, json.dumps(options, ensure_ascii=False), payload.get("deadline") or "", w["key"], _now()))
        return {"id": pid}

    @router.post("/polls/{pid}/vote")
    def vote(pid: str, payload: dict, user: dict = Depends(identity)):
        w = who(user)
        oid = payload.get("option_id")
        with conn() as c:
            p = c.execute("SELECT closed FROM cm_polls WHERE id=?", (pid,)).fetchone()
            if not p or p["closed"]:
                raise HTTPException(400, "종료된 투표")
            c.execute("INSERT OR REPLACE INTO cm_votes(poll_id,user_key,option_id) VALUES(?,?,?)", (pid, w["key"], oid))
        return {"ok": True}

    @router.post("/polls/{pid}/close")
    def close_poll(pid: str, user: dict = Depends(identity)):
        w = who(user)
        with conn() as c:
            p = c.execute("SELECT owner_key FROM cm_polls WHERE id=?", (pid,)).fetchone()
            if not p:
                raise HTTPException(404, "없음")
            if p["owner_key"] != w["key"] and w["role"] != "manager":
                raise HTTPException(403, "만든 사람 또는 관리자만 종료할 수 있습니다.")
            c.execute("UPDATE cm_polls SET closed=1 WHERE id=?", (pid,))
        return {"ok": True}

    # ── anonymous name pool (admin-editable, persisted) ───────────────────────
    @router.get("/anon-names")
    def get_anon_names(user: dict = Depends(identity)):
        require_manager(user)
        return {"surnames": _SURNAMES, "given": _GIVEN}

    @router.put("/anon-names")
    def put_anon_names(payload: dict, user: dict = Depends(identity)):
        require_manager(user)
        sur = [s.strip() for s in (payload.get("surnames") or []) if s and s.strip()]
        giv = [s.strip() for s in (payload.get("given") or []) if s and s.strip()]
        set_anon_names(sur or None, giv or None)
        with conn() as c:
            c.execute("INSERT OR REPLACE INTO cm_config(key,value) VALUES('anon_surnames',?)", (json.dumps(_SURNAMES, ensure_ascii=False),))
            c.execute("INSERT OR REPLACE INTO cm_config(key,value) VALUES('anon_given',?)", (json.dumps(_GIVEN, ensure_ascii=False),))
        return {"surnames": _SURNAMES, "given": _GIVEN}

    # ── AI bots (@botname → provider reply) ───────────────────────────────────
    @router.get("/bots")
    def list_bots(user: dict = Depends(identity)):
        require_manager(user)
        with conn() as c:
            rows = c.execute("SELECT name, provider, model, enabled FROM cm_bots").fetchall()
        return {"bots": [{"name": r["name"], "provider": r["provider"], "model": r["model"], "enabled": bool(r["enabled"])} for r in rows]}

    @router.post("/bots")
    def upsert_bot(payload: dict, user: dict = Depends(identity)):
        require_manager(user)
        name = (payload.get("name") or "").strip().lower()
        if not name:
            raise HTTPException(400, "봇 이름이 필요합니다.")
        with conn() as c:
            c.execute("""INSERT OR REPLACE INTO cm_bots(name,provider,model,api_key,system,enabled)
                         VALUES(?,?,?,?,?,?)""",
                      (name, payload.get("provider") or "echo", payload.get("model") or "",
                       payload.get("api_key") or "", payload.get("system") or "", int(payload.get("enabled", 1))))
        return {"ok": True, "name": name}

    @router.delete("/bots/{name}", status_code=204)
    def delete_bot(name: str, user: dict = Depends(identity)):
        require_manager(user)
        with conn() as c:
            c.execute("DELETE FROM cm_bots WHERE name=?", (name.lower(),))

    def trigger_bots(body: str, trigger_id: int) -> None:
        mentioned = {m.lower() for m in _MENTION_RE.findall(body)}
        if not mentioned:
            return
        with conn() as c:
            bots = c.execute("SELECT * FROM cm_bots WHERE enabled=1").fetchall()
        for b in bots:
            if b["name"] not in mentioned:
                continue
            reply = _call_bot(b["provider"], b["model"], b["api_key"], b["system"], body)
            with conn() as c:
                c.execute("""INSERT INTO cm_messages(author_key,author_name,author_color,author_shape,anon,
                             real_key,real_name,body,kind,reply_to_id,attachments,created_at)
                             VALUES(?,?,?,?,0,NULL,NULL,?,?,?, '[]', ?)""",
                          ("bot:" + b["name"], b["name"], "#8b5cf6", "robot", reply, "msg", trigger_id, _now()))

    return router


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())


def _call_bot(provider: str, model: str, api_key: str, system: str, prompt: str) -> str:
    """Return a bot reply. Real providers when a key is present; otherwise a
    stub echo so the feature works end-to-end without external credentials."""
    provider = (provider or "echo").lower()
    key = api_key or ""
    try:
        if provider == "openai" and key:
            import urllib.request
            req = urllib.request.Request(
                "https://api.openai.com/v1/chat/completions",
                data=json.dumps({"model": model or "gpt-4o-mini",
                                 "messages": ([{"role": "system", "content": system}] if system else []) +
                                             [{"role": "user", "content": prompt}]}).encode(),
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())["choices"][0]["message"]["content"].strip()
        if provider == "anthropic" and key:
            import urllib.request
            req = urllib.request.Request(
                "https://api.anthropic.com/v1/messages",
                data=json.dumps({"model": model or "claude-sonnet-5", "max_tokens": 1024,
                                 **({"system": system} if system else {}),
                                 "messages": [{"role": "user", "content": prompt}]}).encode(),
                headers={"x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return "".join(b.get("text", "") for b in json.loads(r.read())["content"]).strip()
    except Exception as e:                       # noqa: BLE001
        return f"(봇 호출 오류: {e})"
    # echo fallback (no key / provider 'echo')
    return f"🤖 {prompt.strip()[:200]}"
