"""
The home "링크" card — a plain bookmark list on the portal cover.

Not a service: nothing here is proxied, started, or permission-checked entry by
entry. It exists because a lab portal is where people go to FIND things, and much
of what they need is not a portal-managed service — an instrument's own web page,
a wiki, a PDF, a dashboard on another host.

Stored in `data/_portal/links.json`, beside home.json: per-SERVER data that lives
in the data volume, survives a redeploy, and never enters the image. Everyone
signed in may read the list; only an admin may change it.
"""
from __future__ import annotations

import json
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import config, models
from ..deps import require_portal_admin, require_portal_user

router = APIRouter(tags=["portal-links"])

_FILE = config.DATA_ROOT / "_portal" / "links.json"
MAX_LINKS = 100

# These entries are rendered as anchors in the cover, so the scheme is the whole
# security story: `javascript:` (or `data:`) in an href executes in the portal's
# origin, with the signed-in admin's session. Allow only real navigations — http,
# https, and same-portal absolute paths — and reject everything else outright
# rather than trying to sanitise it.
_SAFE_URL = re.compile(r"^(https?://[^\s]+|/[^\s]*)$", re.IGNORECASE)


class Link(BaseModel):
    label: str
    url: str
    note: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None


class LinksBody(BaseModel):
    links: list[Link]


def _read() -> dict:
    try:
        d = json.loads(_FILE.read_text(encoding="utf-8"))
        if isinstance(d, dict) and isinstance(d.get("links"), list):
            return {"links": d["links"]}
    except Exception:
        pass
    return {"links": []}


def _clean(item: Link) -> dict:
    label = (item.label or "").strip()[:80]
    url = (item.url or "").strip()
    if not label:
        raise HTTPException(400, "이름을 입력해 주세요.")
    if not _SAFE_URL.match(url):
        raise HTTPException(400, f"'{label}': 주소는 http://, https:// 또는 /로 시작해야 합니다.")
    out = {"label": label, "url": url}
    if item.note:
        out["note"] = item.note.strip()[:200]
    if item.icon:
        out["icon"] = re.sub(r"[^a-z0-9_-]", "", item.icon.strip().lower()) or None
    if item.color:
        color = item.color.strip()
        if not re.match(r"^#[0-9a-fA-F]{6}$", color):
            raise HTTPException(400, "color는 #rrggbb 형식이어야 합니다.")
        out["color"] = color
    return {k: v for k, v in out.items() if v is not None}


@router.get("/api/links")
def get_links(_: models.User = Depends(require_portal_user)):
    """The cover reads this for every signed-in user — the links are the point.

    The card's own appearance (label/icon/colour/hidden) rides along, because it
    lives in home.json behind an ADMIN-only endpoint. Without it a non-admin could
    not tell that this portal renamed the card, or hid it. It is display config,
    not privileged data, so serving just this card's slice is safe."""
    from .home import _read as _read_home
    card = (_read_home().get("builtins") or {}).get("links") or {}
    return {**_read(), "card": {k: card.get(k) for k in ("label", "icon", "color", "hidden")}}


@router.put("/api/admin/links")
def set_links(body: LinksBody, _: models.User = Depends(require_portal_admin)):
    """Replace the whole list. Whole-list rather than per-item because the editor
    edits it as a list (reorder included), so there is one write and no ids to keep
    in sync."""
    if len(body.links) > MAX_LINKS:
        raise HTTPException(400, f"링크는 최대 {MAX_LINKS}개까지입니다.")
    links = [_clean(i) for i in body.links]
    _FILE.parent.mkdir(parents=True, exist_ok=True)
    _FILE.write_text(json.dumps({"links": links}, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True, "links": links}
