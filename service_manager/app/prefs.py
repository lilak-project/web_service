"""
An account's own preferences — kept on the account (users.preferences_json),
so they follow the person to any browser:

    lang    the UI language ('ko', 'en', …)
    entry   {service: project} — the project pressing that service opens
            straight away ('' = none: show the list, even if the service has
            a default entrance)
"""
from __future__ import annotations

import json

from . import models


def get(user: models.User) -> dict:
    try:
        d = json.loads(user.preferences_json or "{}")
        return d if isinstance(d, dict) else {}
    except ValueError:
        return {}


def put(user: models.User, **changes) -> dict:
    """Merge `changes` in; a None value drops that preference."""
    d = get(user)
    for k, v in changes.items():
        if v is None:
            d.pop(k, None)
        else:
            d[k] = v
    user.preferences_json = json.dumps(d, ensure_ascii=False)
    return d


def with_entries(user: models.User, cards: list[dict]) -> list[dict]:
    """Each multi-project card's `entry_project` as THIS account sees it."""
    for s in cards:
        if s.get("multi_project"):
            s["entry_project"] = entry_for(user, s["name"], s.get("entry_project") or "")
    return cards


def entry_for(user: models.User, svc: str, default: str = "") -> str:
    """The project this account opens a service at: its own choice when it has
    made one (an empty one included), else the service's default."""
    e = get(user).get("entry") or {}
    return e[svc] if svc in e else default
