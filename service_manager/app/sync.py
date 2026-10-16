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

Config lives next to the service's manifest: data/<svc>/sync.json for the
service as a whole, and data/<svc>/sync/<project>.json for a project that is
linked on its own (its own role, partner and token). A project with its own
link is left out of the service's: each project travels by exactly one link.
"""
from __future__ import annotations

import json
import secrets
from pathlib import Path
from typing import Optional

from . import registry

FILE = "sync.json"


def path(svc: str, proj: str = "") -> Path:
    return registry.service_dir(svc) / ("sync" / Path(f"{proj}.json") if proj else Path(FILE))


def read(svc: str, proj: str = "") -> dict:
    try:
        d = json.loads(path(svc, proj).read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:                            # noqa: BLE001 — absent/corrupt = off
        return {}


def write(svc: str, cfg: dict, proj: str = "") -> dict:
    p = path(svc, proj)
    if proj and not cfg.get("role"):
        p.unlink(missing_ok=True)                # off: the service's link applies again
        return cfg
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    return cfg


def own_links(svc: str) -> list[str]:
    """Projects linked on their own."""
    d = registry.service_dir(svc) / "sync"
    return sorted(f.stem for f in d.glob("*.json") if read(svc, f.stem).get("role")) if d.is_dir() else []


def effective(svc: str, proj: str = "") -> dict:
    """The link a project travels by: its own, else the service's."""
    if proj:
        own = read(svc, proj)
        if own.get("role"):
            return own
    return read(svc)


def role(svc: str) -> str:
    """'main' | 'sub' | '' (sync off)."""
    r = (read(svc) or {}).get("role") or ""
    return r if r in ("main", "sub") else ""


def is_read_only(svc: str, proj: str = "") -> bool:
    """A mirrored copy is read-only unless the operator explicitly unlocks it.
    A two-way sub is not a mirror: what is written here travels to main."""
    cfg = effective(svc, proj)
    return cfg.get("role") == "sub" and not cfg.get("two_way") and cfg.get("read_only", True)


def accepts_push(svc: str, proj: str) -> bool:
    """Main lets its paired subs write back (two-way) only when its own admin
    said so — handing out a token alone does not."""
    cfg = effective(svc, proj)
    return cfg.get("role") == "main" and bool(cfg.get("accept_push"))


def new_token() -> str:
    return secrets.token_urlsafe(32)


def _match(cfg: dict, presented: str) -> bool:
    tok = cfg.get("token") or ""
    return bool(tok) and cfg.get("role") == "main" and secrets.compare_digest(tok, presented)


def scope(svc: str, presented: Optional[str]) -> Optional[tuple]:
    """What a sync token opens: ("service", projects linked on their own — which
    it does NOT open), ("project", {that project}), or None.

    The service's token opens every project without a link of its own (one
    pushed by a two-way sub that main has not seen yet included). A project's
    token opens that project alone — a partner given one project cannot even
    list the others."""
    presented = presented or ""
    if not presented:
        return None
    own = set(own_links(svc))
    for p in own:
        if _match(read(svc, p), presented):
            return ("project", {p})
    if _match(read(svc), presented):
        return ("service", own)
    return None


def allows(sc: tuple, proj: str) -> bool:
    kind, names = sc
    return proj in names if kind == "project" else proj not in names


# ── pairing by request: an address in, an approval, the token handed over ────
# main keeps the requests it was sent (data/<svc>/sync-requests.json); a sub
# keeps the ones it is waiting on (data/<svc>/sync-pending.json). A request
# carries a `claim` only its sender ever saw, and both sides show the same
# short pin made from it, so whoever approves can tell it is the right one.
REQ_KEEP_S = 7 * 86400
REQ_MAX = 20


def _jpath(svc: str, name: str) -> Path:
    return registry.service_dir(svc) / name


def read_list(svc: str, name: str) -> list:
    try:
        d = json.loads(_jpath(svc, name).read_text(encoding="utf-8"))
        return d if isinstance(d, list) else []
    except Exception:                            # noqa: BLE001
        return []


def write_list(svc: str, name: str, rows: list) -> None:
    p = _jpath(svc, name)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)


def pin(claim: str) -> str:
    """Six digits both sides can read out to each other."""
    import hashlib
    n = int(hashlib.sha256(claim.encode()).hexdigest(), 16) % 1_000_000
    return f"{n // 1000:03d}-{n % 1000:03d}"
