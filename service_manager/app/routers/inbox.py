"""Where the cover finds the inboxes a person reads. Nothing about a candidate is known here.

A service whose manifest says `capabilities.inbox` keeps candidates waiting for a
person's yes, one project per share set (the set's `inbox` member). The cover (Home,
the account menu) asks this for the ones the caller may enter — a set's inbox is open
to whoever is in the set (permissions.follows_its_set) — then reads each one's
GET /api/pending through /pp and sends the decision back there.
"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import models, permissions, registry
from ..db import get_db
from ..deps import require_portal_user

router = APIRouter()


@router.get("/api/inbox/sources")
def sources(user: models.User = Depends(require_portal_user), db: Session = Depends(get_db)) -> list[dict]:
    """[{svc, proj, set}] — the inboxes of the share sets the caller is in, in the sets' order."""
    inboxes = [s for s in registry.list_service_names()
               if (registry.read_manifest(s).get("capabilities") or {}).get("inbox")]
    out = []
    for st in registry.share_sets()[0]:
        for svc in inboxes:
            proj = (st.get("members") or {}).get(svc)
            if proj and permissions.can_enter_project(db, user, svc, proj) \
                    and not any(o["svc"] == svc and o["proj"] == proj for o in out):
                out.append({"svc": svc, "proj": proj, "set": st.get("name") or proj})
    return out
