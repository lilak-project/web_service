"""
Service Manager — the generalized LILAK portal.

Central accounts + a kind-agnostic service registry (manifest + adapters) + a
stable reverse-proxy entry point, serving a cover UI. Routes are registered most-
specific first so the catch-all SPA/static handler never shadows the API.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from . import config
from .routers import accounts, auth, home, iconlab, project_mgmt, projects, proxy, reports, scaffold, services

config.ensure_dirs()

app = FastAPI(title="LILAK Service Manager")
# TODO(Phase C): narrow allow_origins for production.
app.add_middleware(CORSMiddleware, allow_origins=["*"],
                   allow_methods=["*"], allow_headers=["*"])


# Compat with the elog React app, which addresses the portal as `/launcher/api/*`
# and `/launcher/p/<name>/*` (Vite strips the prefix in dev). Strip it here so the
# same calls resolve to our own `/api/*` and `/p/*` routes.
@app.middleware("http")
async def _strip_launcher_prefix(request: Request, call_next):
    p = request.scope.get("path", "")
    if p == "/launcher" or p.startswith("/launcher/"):
        new = p[len("/launcher"):] or "/"
        request.scope["path"] = new
        request.scope["raw_path"] = new.encode("utf-8")
    return await call_next(request)


# Order matters: auth + specific service routes, then lifecycle, then proxy.
app.include_router(auth.router)
app.include_router(accounts.router)
app.include_router(services.router)
app.include_router(scaffold.router)        # /api/admin/services/scaffold (+ job status)
app.include_router(home.router)            # /api/admin/home (builtin overrides + card order)
app.include_router(iconlab.router)
app.include_router(reports.router)         # /api/reports + /api/admin/reports (feedback)
app.include_router(project_mgmt.router)   # /api/services/{svc}/projects… + /pp/…
app.include_router(projects.router)
app.include_router(proxy.router)


@app.get("/api/health")
def health():
    return {"ok": True, "service": "service_manager",
            "port": config.PORTAL_PORT, "data_root": str(config.DATA_ROOT)}


# Serve the AI integration guide so it's viewable/copyable from the portal UI.
_GUIDES = {
    "service-guide": config.ROOT / "AI_SERVICE_GUIDE.md",
    "service-contract": config.ROOT / "SERVICE_CONTRACT.md",
}


@app.get("/api/guide")
def guide(doc: str = "service-guide"):
    path = _GUIDES.get(doc)
    if not path or not path.is_file():
        return {"doc": doc, "markdown": ""}
    return {"doc": doc, "markdown": path.read_text(encoding="utf-8")}


# ── Cover UI (React SPA) ──────────────────────────────────────────────────────
# Serve the elog React build (the same ProjectsPage cover as :8010/projects) when
# available; otherwise fall back to the bundled minimal cover (app/static). The
# React app addresses us as `/launcher/api/*` (stripped above) — all of which this
# backend implements — so `/projects` renders and talks to us unchanged.
_DIST = config.FRONTEND_DIST if config.FRONTEND_DIST.is_dir() else (Path(__file__).parent / "static")
_INDEX = _DIST / "index.html"
if _DIST.is_dir():
    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str):
        if path:
            candidate = (_DIST / path).resolve()
            if candidate.is_file() and str(candidate).startswith(str(_DIST.resolve())):
                return FileResponse(str(candidate))
        if _INDEX.is_file():
            return FileResponse(str(_INDEX))
        return Response(status_code=404)
