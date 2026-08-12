"""
Cross-portal service sync — config + helpers (stage 1: manual mirror).

Two portals on different servers can mirror ONE service's project data:
  main — owns the data; hands out a token and serves snapshots.
  sub  — pulls from main on demand; its copy is a mirror, so it is served
         read-only (writes through the proxy are refused) to stop people editing
         data that the next sync would silently overwrite.

Only project data moves. Accounts, permissions and manager rights stay per-server
by design: each portal decides who may see its copy, and a compromised sub can
never touch main's users.

Config lives next to the service's manifest: data/<svc>/sync.json.
"""
from __future__ import annotations

import json
import secrets
from pathlib import Path
from typing import Optional

from . import registry

FILE = "sync.json"


def path(svc: str) -> Path:
    return registry.service_dir(svc) / FILE


def read(svc: str) -> dict:
    try:
        d = json.loads(path(svc).read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:                            # noqa: BLE001 — absent/corrupt = off
        return {}


def write(svc: str, cfg: dict) -> dict:
    p = path(svc)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    return cfg


def role(svc: str) -> str:
    """'main' | 'sub' | '' (sync off)."""
    r = (read(svc) or {}).get("role") or ""
    return r if r in ("main", "sub") else ""


def is_read_only(svc: str) -> bool:
    """A mirrored copy is read-only unless the operator explicitly unlocks it."""
    cfg = read(svc)
    return cfg.get("role") == "sub" and cfg.get("read_only", True)


def new_token() -> str:
    return secrets.token_urlsafe(32)


def check_token(svc: str, presented: Optional[str]) -> bool:
    """Constant-time-ish check that a caller may pull this service's snapshots."""
    cfg = read(svc)
    tok = cfg.get("token") or ""
    return bool(tok) and cfg.get("role") == "main" and secrets.compare_digest(tok, presented or "")
