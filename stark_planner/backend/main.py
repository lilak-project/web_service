"""stark_planner backend — minimal FastAPI shell.

Identifies the portal user (SSO) and serves the built frontend. Add feature
routers under routes/ and include them here as the tabs get real content.
"""
import os
from pathlib import Path

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from portal_auth import identity
from layout import build_layout_router
from profiles import build_profiles_router

# Runtime data lives OUTSIDE the repo, next to every other service's
# (~/web_service/data/<service>/), per the portal convention.
DATA = Path(os.environ.get(
    "STARKPLANNER_DATA_DIR",
    Path(__file__).resolve().parents[2] / "data" / "stark_planner",
))

app = FastAPI(title="stark_planner")

app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)

# Configurable tab / menu-bar layout — the SAME source the Settings 탭 and the portal
# Manage UI edit. defaults is this service's code-provided layout (single-panel
# tabs); a tab given rail menu items in the editor renders the kit Rail.
_LAYOUT_DEFAULT = {"tabs": [
    {"id": "sim", "icon": "shapes"},
    {"id": "set", "icon": "settings", "codeMenu": [
        {"id": "account", "label": "계정", "icon": "user"},
        {"id": "users", "label": "사용자 관리", "icon": "users"},
        {"id": "tabs", "label": "탭", "icon": "browse"},
    ]},
]}
app.include_router(build_layout_router(
    path=DATA / "layout.json",
    identity=identity, defaults=_LAYOUT_DEFAULT))


# Named planner setups, one folder per portal account.
app.include_router(build_profiles_router(
    path=DATA / "profiles", identity=identity))


@app.get("/api/health")
def health():
    return {"ok": True, "service": "stark_planner"}


@app.get("/api/whoami")
def whoami(user: dict = Depends(identity)):
    """Portal identity of the caller (advisory; entry is gated by the portal)."""
    return user


# Serve the built frontend (frontend/dist) behind the portal.
DIST = Path(__file__).resolve().parents[1] / "frontend" / "dist"
if DIST.is_dir():
    app.mount("/", StaticFiles(directory=DIST, html=True), name="frontend")
