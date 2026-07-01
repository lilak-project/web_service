"""lilak_gui backend — minimal FastAPI shell.

For now it just identifies the portal user and serves the built frontend. LILAK
feature endpoints (run / parameters / ROOT viewer) get added tab by tab.
"""
from pathlib import Path

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from config import LILAK_PATH, LILAK_FOUND
from portal_auth import identity

app = FastAPI(title="lilak_gui")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {"ok": True, "lilak_path": str(LILAK_PATH), "lilak_found": LILAK_FOUND}


@app.get("/api/whoami")
def whoami(user: dict = Depends(identity)):
    """The portal identity of the caller (advisory; see portal_auth)."""
    return user


# Serve the built frontend (frontend/dist) in production / behind the portal.
DIST = Path(__file__).resolve().parents[1] / "frontend" / "dist"
if DIST.is_dir():
    app.mount("/", StaticFiles(directory=DIST, html=True), name="frontend")
