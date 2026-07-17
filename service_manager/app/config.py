"""
Configuration — everything is env-driven so the same code runs on a laptop or a
deployed server (Phase C: host portability). No config file is required; sensible
defaults make `./run.sh` work out of the box.
"""
from __future__ import annotations

import os
from pathlib import Path

# Project root = the directory that contains `app/`.
ROOT = Path(__file__).resolve().parent.parent

# Where every service's data lives (one sub-dir per service). Kept OUTSIDE the
# code repo by default (a sibling `web_service/data/`) so code and data stay
# separate and the backup/move unit is just this folder (incl. `_portal/portal.db`).
# Point PORTAL_DATA_ROOT at a dedicated/large volume in production.
DATA_ROOT = Path(os.environ.get("PORTAL_DATA_ROOT", ROOT.parent / "data"))

# The portal's own SQLite DB (accounts + service registry + permissions).
# Kept under the reserved `_portal/` dir, which the service list skips.
PORTAL_DB = Path(os.environ.get("PORTAL_DB", DATA_ROOT / "_portal" / "portal.db"))

# Avatar colour reserved for GLOBAL admins/managers (same as elog's MANAGER_COLOR).
# Managers always get it; non-managers can never pick it.
MANAGER_COLOR = "#111827"
# Avatar colour for SCOPED admins (service/project admins, not global managers) —
# a distinct dark grey so they read as "an admin, but only here".
SCOPED_ADMIN_COLOR = "#4b5563"

# Portal HTTP port. Defaults to 8025 to avoid colliding with the existing
# lilak_elog launcher on :8010 (and another local service on :8020).
PORTAL_PORT = int(os.environ.get("PORTAL_PORT", 8025))

# Port window for managed (subprocess) services. 8026..8075 = 50 slots, so up to
# ~50 concurrent user sessions can each claim a port. Ports stay internal to the
# container (proxied via PORTAL_PORT); widening the range needs no compose change.
SERVICE_PORT_START = int(os.environ.get("SERVICE_PORT_START", 8026))
SERVICE_PORT_END = int(os.environ.get("SERVICE_PORT_END", 8075))

# Public base URL the portal is reachable at (used when registering external
# services / building entry links). Defaults to localhost for dev.
BASE_URL = os.environ.get("PORTAL_BASE_URL", f"http://localhost:{PORTAL_PORT}")

# Shared JWT secret. MUST match the secret of any managed service (e.g. elog) so
# a portal token is trusted on entry. Reads ELOG_SECRET_KEY for backward-compat
# with the existing elog deployment.
SECRET_KEY = (
    os.environ.get("PORTAL_SECRET_KEY")
    or os.environ.get("ELOG_SECRET_KEY")
    or "lilak-dev-secret-CHANGE-in-production"
)
TOKEN_EXPIRE_HOURS = int(os.environ.get("PORTAL_TOKEN_EXPIRE_HOURS", "24"))

# Handshake registration token. A service self-registers by POSTing its descriptor
# to `/api/handshake` with this bearer — so registering is "set the portal URL +
# token in the service, done" instead of an admin filling a long form. Rotate via
# env in production.
_DEFAULT_REGISTER_TOKEN = "lilak-portal-register-CHANGE"
REGISTER_TOKEN = os.environ.get("PORTAL_REGISTER_TOKEN", _DEFAULT_REGISTER_TOKEN)
# Self-registration is DISABLED until an operator sets a real token, so the public
# default value can't be used to register services on an exposed portal.
REGISTER_ENABLED = bool(REGISTER_TOKEN) and REGISTER_TOKEN != _DEFAULT_REGISTER_TOKEN

# Email verification. When DEV_ECHO is on, the verification link is returned in
# the register response + logged, so the flow is testable locally without an
# email provider. In production, configure Resend and keep DEV_ECHO off.
# REQUIRED gates login on verification.
EMAIL_VERIFY_REQUIRED = os.environ.get("EMAIL_VERIFY_REQUIRED", "1") not in ("0", "false", "False")
EMAIL_VERIFY_DEV_ECHO = os.environ.get("EMAIL_VERIFY_DEV_ECHO", "1") not in ("0", "false", "False")
RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "").strip()
RESEND_FROM_EMAIL = os.environ.get("RESEND_FROM_EMAIL", "").strip()
RESEND_REPLY_TO = os.environ.get("RESEND_REPLY_TO", "").strip()

# Sign-up email gating. A comma-separated allow-list of email domains that may
# self-register freely (e.g. "ibs.re.kr,kaist.ac.kr"). Empty = any email allowed.
# Anyone whose domain is NOT on the list may still sign up if they present a valid
# invite code. (When Firebase Auth is wired, the same rule belongs in a
# `beforeCreate` blocking function — see the note in auth.register.)
SIGNUP_ALLOWED_DOMAINS = [
    d.strip().lower() for d in os.environ.get("SIGNUP_ALLOWED_DOMAINS", "").split(",") if d.strip()
]


# Frontend the portal serves: its OWN build (frontend/dist), which depends only
# on the lilak_ui kit — not on lilak_elog. Override with PORTAL_FRONTEND_DIST.
# main.py falls back to the bundled minimal cover (app/static) if no build exists.
FRONTEND_DIST = Path(os.environ.get(
    "PORTAL_FRONTEND_DIST",
    ROOT / "frontend" / "dist",
))


def ensure_dirs() -> None:
    PORTAL_DB.parent.mkdir(parents=True, exist_ok=True)
    DATA_ROOT.mkdir(parents=True, exist_ok=True)
