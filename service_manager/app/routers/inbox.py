"""Where the cover finds the inboxes a person reads. Nothing about a candidate is known here.

A service whose manifest says `capabilities.inbox` keeps candidates waiting for a
person's yes, one project per share set (the set's `inbox` member). The cover (Home,
the account menu) asks this for the ones the caller may enter — a set's inbox is open
to whoever is in the set (permissions.follows_its_set) — then reads each one's
GET /api/pending through /pp and sends the decision back there.
"""
import base64
from datetime import datetime

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from .. import held, models, permissions, registry, senders as reg
from ..db import get_db
from ..deps import require_portal_user

router = APIRouter()


@router.get("/api/inbox/sources")
def sources(user: models.User = Depends(require_portal_user), db: Session = Depends(get_db)) -> list[dict]:
    """[{svc, proj, set}] — the inboxes of the share sets the caller is in, in the sets' order."""
    inboxes = [s for s in registry.list_service_names()
               if (registry.read_manifest(s).get("capabilities") or {}).get("inbox")]
    # The portal's own first: what waits for this account's yes about the portal itself (below).
    out = [{"portal": True, "svc": "", "proj": "", "set": "portal"}] \
        if permissions.is_admin(user) or permissions.has_any_admin(db, user.id) else []
    for st in registry.share_sets()[0]:
        for svc in inboxes:
            proj = (st.get("members") or {}).get(svc)
            if proj and permissions.can_enter_project(db, user, svc, proj) \
                    and not any(o["svc"] == svc and o["proj"] == proj for o in out):
                out.append({"svc": svc, "proj": proj, "set": st.get("name") or proj})
    return out


# ── The portal as one more inbox ─────────────────────────────────────────────
# What waits for a yes about the portal itself is read on the same page as the sets' inboxes,
# through the same three calls an inbox service answers (pending, one opened, decide):
#   path    a host path a service asked to use (routers/reach.py)            — a manager's
#   access  an account asking into a service or project (routers/services)  — a manager's, or its admin's
#   email   an account's change of e-mail address (routers/accounts)        — a manager's
#   sync    another server asking to link its services to this one (routers/sync, one per batch) — a manager's
#   issues  another portal asking to send its issues through this one (routers/issues)          — a manager's
#   sender  an MCP token asking to send candidates to the inbox (app/senders.py)                 — a manager's
# A link request shows its pin: it is approved only when the asking side shows the same one.
# Each is decided by the same function its own settings page calls; nothing is kept here.
def _pid(*parts: str) -> str:
    return held.pid(*parts)


def _unpid(s: str) -> list:
    try:
        return held.unpid(s)
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(404, "그 항목이 없습니다.") from None


def _day(ts) -> str:
    try:
        return (datetime.fromtimestamp(ts) if isinstance(ts, (int, float)) else ts).strftime("%Y-%m-%d")
    except Exception:  # noqa: BLE001
        return ""


def _waiting(user: models.User, db: Session) -> list[dict]:
    from . import reach, services
    out = []
    card = lambda **c: {"mode": "", "status": "waiting", "subject": "", "remark": "", "blocked": "", "goes": "portal",  # noqa: E731
                        "attachments": [], "decidedAt": "", "actions": ["approve", "discard"], **c}
    if permissions.is_admin(user):
        for s in reach.state(user)["services"]:
            for e in s["paths"]:
                if e["status"] == "waiting":
                    out.append(card(id=_pid("path", s["name"], e["path"]), kind="path", title=f"{s['label']} → {e['path']}",
                                    date=_day(e.get("at")), **{"from": s["name"]},
                                    sections=[{"k": "makes", "title": s["name"], "text": e["path"]},
                                              *([{"k": "remark", "text": e["why"]}] if e.get("why") else [])]))
        for u in db.query(models.User).filter(models.User.pending_email.isnot(None)).all():
            out.append(card(id=_pid("email", str(u.id)), kind="email", title=f"{u.username}: {u.email} → {u.pending_email}",
                            date="", **{"from": u.username},
                            sections=[{"k": "change", "rows": [["email", u.email or "", u.pending_email or ""]]}]))
        from . import issues, sync
        for g in sync.all_asked(user):
            who = g.get("from_name") or g.get("from_url") or "?"
            out.append(card(id=_pid("sync", str(g["batch"])), kind="sync", title=f"{who} → {len(g['items'])}",
                            date=_day(g.get("at")), **{"from": f"{g.get('by') or who} · pin {g['pin']}"},
                            sections=[{"k": "makes", "title": g.get("from_url") or "",
                                       "text": "\n".join(f"{i['svc']}{'/' + i['project'] if i['project'] else ''}"
                                                         f"{'  ⇄' if i['two_way'] else ''}" for i in g["items"])},
                                      {"k": "remark", "text": f"pin {g['pin']}"}]))
        for r in issues.admin_state(user)["requests"]:
            who = r.get("from_name") or r.get("from_url") or "?"
            out.append(card(id=_pid("issues", str(r["id"])), kind="issues", title=who, date=_day(r.get("at")),
                            **{"from": f"{r.get('by') or who} · pin {r['pin']}"},
                            sections=[{"k": "makes", "title": r.get("from_url") or "", "text": who},
                                      {"k": "remark", "text": f"pin {r['pin']}"}]))
        for r in reg.rows():
            if r["status"] == "waiting":
                out.append(card(id=reg.pid(r["token_id"]), kind="sender", title=f"{r['name']} ({r['token']})",
                                date=_day(r.get("at")), **{"from": r.get("by") or r["token"]},
                                sections=[{"k": "makes", "title": r["token"], "text": "\n".join([
                                    "kinds: " + ", ".join(r["kinds"]), "reads: " + (r["reads_at"] or r["reads"])])}]))
    names = {u.id: u.username for u in db.query(models.User).all()}
    for r in services._to_resolve(db, user):
        where = r.service_name + (f"/{r.project}" if r.project else "")
        out.append(card(id=_pid("access", str(r.id)), kind="access", title=f"{names.get(r.user_id, '?')} → {where}",
                        date=_day(r.created_at), **{"from": names.get(r.user_id, "?")},
                        sections=[{"k": "makes", "title": names.get(r.user_id, "?"), "text": where}]))
    # Held, with what was said about it (app/held.py): the third answer beside yes and no.
    for c in out:
        h = held.get(c["id"])
        c.update(status="held" if h["held"] else "waiting", comments=h["comments"], actions=["approve", "hold", "discard"])
    return out


@router.get("/api/inbox/portal/pending")
def portal_pending(user: models.User = Depends(require_portal_user), db: Session = Depends(get_db)) -> dict:
    items = [{k: v for k, v in c.items() if k != "sections"} for c in _waiting(user, db)]
    held_n = sum(c["status"] == "held" for c in items)        # as an inbox service counts: waiting, and held apart
    return {"count": len(items) - held_n, "held": held_n, "items": items}


@router.get("/api/inbox/portal/decided")
def portal_decided(_: models.User = Depends(require_portal_user)) -> dict:
    return {"count": 0, "items": []}      # each kind keeps its own history on its settings page


@router.get("/api/inbox/portal/inbox/{cid}")
def portal_one(cid: str, user: models.User = Depends(require_portal_user), db: Session = Depends(get_db)) -> dict:
    c = next((x for x in _waiting(user, db) if x["id"] == cid), None)
    if not c:
        raise HTTPException(404, "그 항목이 없습니다.")
    return c


@router.post("/api/inbox/portal/inbox/{cid}/decide")
def portal_decide(cid: str, body: dict = Body(...), user: models.User = Depends(require_portal_user),
                  db: Session = Depends(get_db)) -> dict:
    """approve, discard (a path is blocked, a request or a link rejected, an address change dropped),
    or hold {text}: it stays, held, with that opinion for whoever asked to read."""
    act = str(body.get("action"))
    yes = {"approve": True, "discard": False}.get(act)
    if (yes is None and act != "hold") or not any(x["id"] == cid for x in _waiting(user, db)):   # only what waits for THIS account
        raise HTTPException(409, "이 항목에 지금 할 수 없는 일입니다.")
    if act == "hold":
        return _said(cid, user, body.get("text"), hold=True)
    kind, *rest = _unpid(cid)
    if kind == "path":
        from . import reach
        reach.put_path(reach.PathBody(service=rest[0], path=rest[1], status="approved" if yes else "blocked"), user)
    elif kind == "access":
        from . import services
        services.admin_resolve_request(int(rest[0]), services.ResolveBody(action="approve" if yes else "reject"), user, db)
    elif kind == "email":
        from . import accounts
        accounts.admin_approve_email(int(rest[0]), accounts.ApproveEmailBody(approve=yes), user, db)
    elif kind == "sync":
        from . import sync
        bad = [r for r in sync.all_decide(sync.AllDecide(batch=rest[0], action="approve" if yes else "reject"), user)["results"]
               if not r["ok"]]
        if bad:
            raise HTTPException(502, "; ".join(f"{r['svc']}: {r['error']}" for r in bad))
    elif kind == "issues":
        from . import issues
        issues.admin_decide(rest[0], issues.LinkDecide(action="approve" if yes else "reject"), user)
    elif kind == "sender":
        reg.decide(rest[0], yes)
        return {"ok": True}                      # reg.decide dropped the thread itself
    held.drop(cid)
    return {"ok": True}


def _said(cid: str, user: models.User, text, hold: bool = False) -> dict:
    try:
        return held.say(cid, user.email or user.username, text, hold=hold)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None


@router.post("/api/inbox/portal/inbox/{cid}/comment")
def portal_comment(cid: str, body: dict = Body(...), user: models.User = Depends(require_portal_user),
                   db: Session = Depends(get_db)) -> dict:
    """One more opinion on something that waits, its state as it was."""
    if not any(x["id"] == cid for x in _waiting(user, db)):
        raise HTTPException(404, "그 항목이 없습니다.")
    return _said(cid, user, body.get("text"))


# ── Who sends to the inbox ───────────────────────────────────────────────────
# Seen from the cards alone, so nothing has to be registered: a candidate says where it came
# from (`sender.via` the MCP token it came through, `from`, a mail's `subject`), a portal item
# by its kind. `back` is where a hold's opinion can be read by whoever sent it.
BACK = {"token": "my_proposals", "mail": "none", "tidy": "none", "service": "browse",
        "account": "my_requests", "portal": "link", "other": "none"}


def sender_of(c: dict) -> tuple:
    """(what kind of sender, its name) of one card."""
    kind, who = c.get("kind"), str(c.get("from") or "")
    via = ((c.get("sender") or {}).get("via") or "").strip()
    via = via[4:].strip() if via.startswith("MCP ") else via        # stamped as "MCP <token name>"
    if kind == "path":
        return "service", who
    if kind in ("access", "email"):
        return "account", who
    if kind in ("sync", "issues"):
        return "portal", who.split(" · pin ")[0]
    if who == "포털 정리":                       # tidy.py, on this portal's own clock
        return "tidy", who
    if via:
        return "token", via
    if who.startswith("MCP "):
        return "token", who[4:].strip()
    if c.get("subject"):                         # came from a mail (the mail task's drop), `from` is who wrote it
        return "mail", "mail"
    return "other", who or "?"


def senders(cards: list) -> list:
    """One row a sender: what it sends, how many wait, are held, were decided, when it last sent,
    and where an opinion goes back to. `ids` are its cards (source/id), for the page to filter by."""
    rows: dict = {}
    for c in cards:
        typ, name = sender_of(c)
        r = rows.setdefault((typ, name), {"type": typ, "name": name, "kinds": [], "waiting": 0, "held": 0, "done": 0,
                                          "last": "", "back": BACK[typ], "ids": []})
        if c.get("kind") and c["kind"] not in r["kinds"]:
            r["kinds"].append(c["kind"])
        st = c.get("status", "waiting")
        r["waiting" if st == "waiting" else "held" if st == "held" else "done"] += 1
        r["last"] = max(r["last"], str(c.get("date") or "")[:10])
        r["ids"].append(c["_key"])
    # A token's registration (app/senders.py) beside what it sent; one registered that has sent nothing is listed too.
    known = {r["token"]: r for r in reg.rows()}
    for (typ, name), r in rows.items():
        if typ == "token":
            r["registered"] = known.pop(name, None)
    for tok, x in known.items():
        rows[("token", tok)] = {"type": "token", "name": tok, "kinds": [], "waiting": 0, "held": 0, "done": 0,
                                "last": "", "back": BACK["token"], "ids": [], "registered": x}
    for r in rows.values():
        if (r.get("registered") or {}).get("reads") == "never":
            r["back"] = "none"                   # it said it reads no answer
    return sorted(rows.values(), key=lambda r: (-(r["waiting"] + r["held"]), -r["done"], r["name"]))


@router.get("/api/inbox/senders")
async def inbox_senders(request: Request, user: models.User = Depends(require_portal_user),
                        db: Session = Depends(get_db)) -> list:
    """Every sender behind what the caller's inboxes hold (waiting, held, and the last 500 decided of each)."""
    cards = [{**c, "_key": f"//{c['id']}"} for c in _waiting(user, db)]
    head = {"Authorization": request.headers.get("authorization", ""), "Accept": "application/json"}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=request.app), base_url="http://portal",
                                 timeout=30, headers=head) as cl:
        for s in sources(user, db):
            if s.get("portal"):
                continue
            for path in ("pending", "decided?limit=500"):
                try:
                    r = await cl.get(f"/pp/{s['svc']}/{s['proj']}/api/{path}")
                    items = r.json().get("items") or [] if r.status_code == 200 else []
                except Exception:  # noqa: BLE001 — an inbox that is away is left out, the rest still shown
                    items = []
                cards += [{**c, "_key": f"{s['svc']}/{s['proj']}/{c['id']}"} for c in items if isinstance(c, dict)]
    return senders(cards)


# ── Registered senders (MCP tokens): what a card shows of its sender, and a manager's own hand ──
@router.get("/api/inbox/registered")
def registered(_: models.User = Depends(require_portal_user)) -> dict:
    """{token name: {name, reads, reads_at}} — for a card to name its sender and say when an answer is read."""
    return reg.by_token_name()


@router.get("/api/admin/senders")
def admin_senders(user: models.User = Depends(require_portal_user), db: Session = Depends(get_db)) -> dict:
    if not permissions.is_admin(user):
        raise HTTPException(403, "관리자 권한이 필요합니다.")
    toks = db.query(models.McpToken).filter(models.McpToken.revoked_at.is_(None)).order_by(models.McpToken.name).all()
    return {"senders": reg.rows(), "kinds": list(reg.KINDS), "reads": list(reg.READS),
            "tokens": [{"id": t.id, "name": t.name} for t in toks]}


@router.post("/api/admin/senders")
def admin_put_sender(body: dict = Body(...), user: models.User = Depends(require_portal_user),
                     db: Session = Depends(get_db)) -> dict:
    """Register a token as a sender outright, or change one (name, kinds, when it reads answers)."""
    if not permissions.is_admin(user):
        raise HTTPException(403, "관리자 권한이 필요합니다.")
    t = db.get(models.McpToken, int(body.get("token_id") or 0))
    if not t:
        raise HTTPException(404, "그런 토큰이 없습니다.")
    try:
        return reg.register(t.id, t.name, user.username, body.get("name"), body.get("kinds"), body.get("reads"), body.get("reads_at"))
    except ValueError as e:
        raise HTTPException(400, str(e)) from None


@router.delete("/api/admin/senders/{token_id}")
def admin_drop_sender(token_id: int, user: models.User = Depends(require_portal_user)) -> dict:
    """No longer a sender: its token is refused until it registers again. What it sent stays."""
    if not permissions.is_admin(user):
        raise HTTPException(403, "관리자 권한이 필요합니다.")
    reg.drop(token_id)
    return {"ok": True}
