"""Per-user workspaces + disk quota (PLAN §4.3).

Layout: <data>/g4toy/users/<user_key>/jobs/<job_id>/  (input macro + outputs + log).
All paths are derived from the sanitized user_key and a uuid job id, so nothing
user-supplied ever reaches the filesystem — no path traversal (PLAN §8).
"""
from __future__ import annotations

from pathlib import Path

import config


def user_dir(user_key: str) -> Path:
    return config.USERS_ROOT / user_key


def jobs_dir(user_key: str) -> Path:
    return user_dir(user_key) / "jobs"


def job_dir(user_key: str, job_id: str) -> Path:
    return jobs_dir(user_key) / job_id


def dir_size(path: Path) -> int:
    if not path.exists():
        return 0
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


def user_usage(user_key: str) -> int:
    return dir_size(jobs_dir(user_key))


def quota() -> int:
    return config.USER_QUOTA_BYTES
