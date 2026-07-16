"""gitinfo — cheap host + git-version metadata for the portal UI.

Lets you tell two deployments apart from the screen alone: the home header shows
the host + the portal's git short-SHA, and each service card shows its own repo's
short-SHA.

Two sources, in order:
  1. live `git` — accurate, used when running from a host checkout (dev).
  2. git-versions.json — baked at build time by deploy/gen-versions.py (build.sh).
     The Docker image has NO `git` binary and NO `.git` (.dockerignore strips it),
     so live git yields nothing there and this fallback is what feeds the cards.

Everything degrades to None when neither source has it (e.g. a scaffolded service,
whose code is a plain folder with no repo of its own).
"""
from __future__ import annotations

import json
import socket
import subprocess
import time
from pathlib import Path

from . import config

# The stack root (…/web_service): the portal's own code is tracked here, and every
# co-located service repo (lilak_elog, nptoy, …) is a direct child of it.
STACK_ROOT = Path(config.ROOT).parent

# Written into service_manager/ on the host at build time, so the plain
# `COPY service_manager /app/service_manager` carries it into the image.
_BAKED_PATH = Path(config.ROOT) / "git-versions.json"
_baked_loaded = False
_baked_data: dict | None = None


def _baked() -> dict | None:
    """{'portal': sha, 'services': {'<relpath>': {sha, remote, pushed}}} or None."""
    global _baked_loaded, _baked_data
    if not _baked_loaded:
        _baked_loaded = True
        try:
            _baked_data = json.loads(_BAKED_PATH.read_text())
        except Exception:
            _baked_data = None
    return _baked_data


def _git(cwd, *args: str) -> str:
    try:
        out = subprocess.run(
            ["git", *args], cwd=str(cwd),
            capture_output=True, text=True, timeout=3,
        )
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:
        return ""


def hostname() -> str:
    try:
        return socket.gethostname()
    except Exception:
        return "?"


def portal_version() -> str | None:
    """Short SHA of the portal's own repo (the stack root)."""
    live = _git(config.ROOT, "rev-parse", "--short", "HEAD")
    if live:
        return live
    return (_baked() or {}).get("portal") or None


# path -> (timestamp, value); short TTL so a fresh commit shows up without a portal
# restart, but we don't shell out to git on every /services request.
_cache: dict[str, tuple[float, dict | None]] = {}
_TTL = 30.0


def service_version(code_dir) -> dict | None:
    """{'sha','date'} for a service whose code is its OWN git repo (a direct child
    of the stack root). Returns None for external services or scaffolded folders
    that have no repo (so they don't inherit the portal/root SHA)."""
    if not code_dir:
        return None
    key = str(code_dir)
    now = time.time()
    hit = _cache.get(key)
    if hit and now - hit[0] < _TTL:
        return hit[1]
    val = _service_version(Path(code_dir))
    _cache[key] = (now, val)
    return val


def _normalize_remote(raw: str | None) -> str | None:
    """An origin remote as a browsable https URL (github/gitlab web), so the UI can
    link to the repo and the exact commit. None if there's no origin. Pure, so the
    live and baked paths share one implementation."""
    if not raw:
        return None
    url = raw.strip()
    if url.startswith("ssh://"):
        url = url[len("ssh://"):]
    if url.startswith("git@"):                     # git@host:owner/repo(.git)
        host, _, path = url[4:].partition(":")
        if not path:                               # ssh form git@host/owner/repo
            host, _, path = url[4:].partition("/")
        url = f"https://{host}/{path}"
    elif url.startswith("http://"):
        url = "https://" + url[len("http://"):]
    if url.endswith(".git"):
        url = url[:-4]
    url = url.rstrip("/")
    return url or None


def _remote_url(cwd) -> str | None:
    return _normalize_remote(_git(cwd, "config", "--get", "remote.origin.url"))


def _baked_service(code_dir: Path) -> dict | None:
    """Baked version for a service, matched by the repo its code dir lives in.

    Keys are submodule paths relative to the stack root ('nptoy'), while a service's
    cwd may be a subdir of it ('nptoy/backend') — so take the LONGEST key that is a
    path-prefix of the code dir."""
    data = _baked()
    if not data:
        return None
    services = data.get("services") or {}
    try:
        rel = Path(code_dir).resolve().relative_to(STACK_ROOT)
    except (ValueError, OSError):                  # outside the stack → not ours
        return None
    parts = rel.parts
    for n in range(len(parts), 0, -1):
        entry = services.get("/".join(parts[:n]))
        if entry:
            return {"sha": entry.get("sha"),
                    "url": _normalize_remote(entry.get("remote")),
                    "pushed": bool(entry.get("pushed"))}
    return None


def _service_version(code_dir: Path) -> dict | None:
    """Version for ANY service whose code is its own git checkout — present or
    future, wherever it lives. The only exclusion is a folder with no repo of its
    own: git then walks up to the stack root's repo, so we drop a toplevel that IS
    the stack root (e.g. a scaffolded plain folder) to avoid showing the portal's
    SHA for it."""
    if not code_dir.exists():
        return _baked_service(code_dir)
    top = _git(code_dir, "rev-parse", "--show-toplevel")
    if not top:                                    # no git binary/repo (the image)
        return _baked_service(code_dir)
    if Path(top) == STACK_ROOT:                    # no repo of its own → no version
        return None
    sha = _git(code_dir, "rev-parse", "--short", "HEAD")
    if not sha:
        return _baked_service(code_dir)
    # Is HEAD on a remote branch? If not, it's a local-only commit — the web
    # commit URL would 404, so the UI shows the SHA without linking it.
    pushed = bool(_git(code_dir, "branch", "-r", "--contains", "HEAD").strip())
    return {"sha": sha, "url": _remote_url(code_dir), "pushed": pushed}
