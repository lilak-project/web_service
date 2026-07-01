"""g4toy backend configuration.

All runtime state lives under the portal data root (PLAN §6 / SERVICE_CONTRACT §9):
`<PORTAL_DATA_ROOT>/g4toy/`. No absolute paths are baked in — the portal injects
`PORTAL_DATA_ROOT` when it spawns this as a managed service; a sensible local
default is used for standalone dev.
"""
from __future__ import annotations

import os
from pathlib import Path

# ── Identity / JWT ────────────────────────────────────────────────────────────
# Same scheme as the portal (HS256). The portal forwards the user's portal JWT in
# the Authorization header (identity.accepts_portal_token = true) and shares the
# secret via env, so we validate with the exact same key + fallbacks the portal
# uses (service_manager/app/config.py).
SECRET_KEY = (
    os.environ.get("PORTAL_SECRET_KEY")
    or os.environ.get("ELOG_SECRET_KEY")
    or "lilak-dev-secret-CHANGE-in-production"
)
ALGORITHM = "HS256"

# ── Paths ─────────────────────────────────────────────────────────────────────
SERVICE_NAME = os.environ.get("PORTAL_SERVICE", "g4toy")
_DEFAULT_DATA_ROOT = Path(__file__).resolve().parent.parent.parent / "data"
PORTAL_DATA_ROOT = Path(os.environ.get("PORTAL_DATA_ROOT", _DEFAULT_DATA_ROOT))
DATA_ROOT = PORTAL_DATA_ROOT / SERVICE_NAME          # <data>/g4toy/
USERS_ROOT = DATA_ROOT / "users"                     # <data>/g4toy/users/<key>/jobs/<id>/
DB_PATH = Path(os.environ.get("G4TOY_DB", DATA_ROOT / "g4toy.db"))

# Frontend served by this backend through the portal proxy (base-path aware).
PUBLIC_DIR = Path(__file__).resolve().parent.parent / "public"

# ── Limits ────────────────────────────────────────────────────────────────────
JOB_TIMEOUT_SEC = int(os.environ.get("G4TOY_JOB_TIMEOUT_SEC", "600"))   # per-job wall clock
USER_QUOTA_BYTES = int(os.environ.get("G4TOY_USER_QUOTA_BYTES", str(1024 * 1024 * 1024)))  # 1 GB
WORKER_POLL_SEC = float(os.environ.get("G4TOY_WORKER_POLL_SEC", "1.0"))

# ── nptool toolchain (the only simulation engine) ─────────────────────────────
# Everything runs the real nptool `npsimulation`: batch jobs via `-B <macro>` and
# live sessions via `-N`. Local-dev path for now (the toolchain ships in the Docker
# image, milestone 4).
NPTOOL_SETUP = os.environ.get(
    "G4TOY_NPTOOL_SETUP", "/Users/jungwoo/Research/nptool_cens/nptool.sh")

# Whitelisted projects (never arbitrary paths/commands). Used by both batch jobs
# and interactive sessions.
# Example templates the input workspace can be seeded from (inputs.py discovers the
# detector/reaction files inside each).
_NP = "/Users/jungwoo/Research/nptool_cens/Projects"
PROJECTS = {
    "ATOMX_12C": {"label": "ATOMX_12C", "dir": f"{_NP}/jungwoo/simulation_12C"},
    "ATOMX_34Ar": {"label": "ATOMX_34Ar", "dir": f"{_NP}/jungwoo/simulation_34Ar"},
    "ELARK": {"label": "ELARK", "dir": f"{_NP}/ko2520/sim_ko2520",
              "detector": ".tmp/stark_ko2520_21Na.det", "reaction": ".tmp/21Na_elastic.reac"},
    "STARK": {"label": "STARK", "dir": f"{_NP}/STARK",
              "detector": "detectors/stark_full.det", "reaction": "sources/alpha.source"},
}
DEFAULT_PROJECT = next(iter(PROJECTS))
MAX_SESSIONS = int(os.environ.get("G4TOY_MAX_SESSIONS", "4"))     # global live cap
# How many events per /run/beamOn nptool streams to the live viewer text file
# (`--online-data-streaming N`). Small = light + fast live update.
ONLINE_EVENTS = int(os.environ.get("G4TOY_ONLINE_EVENTS", "10"))
SESSION_MAX_BEAMON = int(os.environ.get("G4TOY_SESSION_MAX_BEAMON", "100000"))


def ensure_dirs() -> None:
    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    USERS_ROOT.mkdir(parents=True, exist_ok=True)
