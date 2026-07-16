#!/usr/bin/env python3
"""Bake git SHAs for the portal + each submodule into git-versions.json.

Run on the HOST at build time (build.sh), where `git` and the `.git` dirs exist.
The Docker image has NEITHER (the source is COPYd in without `.git`, and the
runtime image has no `git` binary), so gitinfo.py reads this file as its fallback
and the portal's per-service SHA cards keep working inside the container.

Keyed by each submodule's path RELATIVE to the stack root (web_service/) — the
same key gitinfo derives from a service's `cwd` — so a service whose code dir is
a subdirectory (e.g. nptoy/backend) still resolves to its repo (nptoy).
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]        # …/web_service


def git(*args: str, cwd: Path = ROOT) -> str:
    try:
        out = subprocess.run(
            ["git", *args], cwd=str(cwd),
            capture_output=True, text=True, timeout=10,
        )
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:
        return ""


def submodule_paths() -> list[str]:
    raw = git("config", "--file", ".gitmodules",
              "--get-regexp", r"^submodule\..*\.path$")
    return [line.split(None, 1)[1] for line in raw.splitlines() if line.strip()]


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else \
        ROOT / "service_manager" / "git-versions.json"

    data: dict = {"portal": git("rev-parse", "--short", "HEAD") or None,
                  "services": {}}
    for path in submodule_paths():
        sub = ROOT / path
        sha = git("rev-parse", "--short", "HEAD", cwd=sub)
        if not sha:                                # submodule not checked out
            continue
        data["services"][path] = {
            "sha": sha,
            # raw remote — gitinfo normalizes it to a browsable https URL.
            "remote": git("config", "--get", "remote.origin.url", cwd=sub) or None,
            # is HEAD on a remote branch? if not, the web commit URL would 404.
            "pushed": bool(git("branch", "-r", "--contains", "HEAD", cwd=sub).strip()),
        }

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, indent=2) + "\n")
    print(f"[gen-versions] wrote {out} "
          f"(portal={data['portal']}, {len(data['services'])} services)")


if __name__ == "__main__":
    main()
