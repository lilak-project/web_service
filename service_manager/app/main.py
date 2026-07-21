"""
Service Manager — the generalized LILAK portal.

Central accounts + a kind-agnostic service registry (manifest + adapters) + a
stable reverse-proxy entry point, serving a cover UI. Routes are registered most-
specific first so the catch-all SPA/static handler never shadows the API.
"""
from __future__ import annotations

from pathlib import Path

import html as _html

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.exception_handlers import http_exception_handler
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse

from . import config
from .routers import accounts, auth, home, iconlab, project_mgmt, projects, proxy, reports, scaffold, services, system

config.ensure_dirs()

app = FastAPI(title="LILAK Service Manager")
app.add_middleware(CORSMiddleware, allow_origins=config.CORS_ORIGINS,
                   allow_methods=["*"], allow_headers=["*"])
# The cover UI ships a ~1.7 MB JS bundle; served raw it dominates first paint over
# the network (localhost hides it). gzip cuts it to ~460 KB. minimum_size skips
# tiny JSON so we only pay compression on payloads where it wins.
app.add_middleware(GZipMiddleware, minimum_size=1024)


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


# A browser NAVIGATING into a proxied service (/p, /pp) that errors used to get a
# bare JSON body — which standalone PWAs render as an unstyled (and, without a
# charset, mojibake) dead end. Serve a tiny UTF-8 HTML page with a retry button
# instead; API/fetch callers and auth redirects (3xx with Location) keep the
# default JSON behaviour.
@app.exception_handler(HTTPException)
async def _proxy_error_page(request: Request, exc: HTTPException):
    path = request.scope.get("path", "")
    wants_page = (
        request.method == "GET"
        and (path.startswith("/p/") or path.startswith("/pp/"))
        and "text/html" in request.headers.get("accept", "")
        and not (exc.headers or {}).get("Location")
    )
    if not wants_page:
        return await http_exception_handler(request, exc)
    msg = _html.escape(str(exc.detail or "요청을 처리할 수 없습니다."))
    body = f"""<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LILAK</title></head>
<body style="margin:0;display:grid;place-items:center;height:100dvh;background:#f5f7f8;
  font-family:ui-sans-serif,system-ui,sans-serif;color:#182026">
<div style="text-align:center;padding:24px;max-width:420px">
  <p style="font-size:15px;line-height:1.5">{msg}</p>
  <p style="display:flex;gap:8px;justify-content:center">
    <a href="javascript:location.reload()" style="padding:10px 18px;border-radius:8px;
      background:#3d5a80;color:#fff;text-decoration:none">다시 시도</a>
    <a href="/projects" style="padding:10px 18px;border-radius:8px;
      border:1px solid #3d5a80;color:#3d5a80;text-decoration:none">포털로</a>
  </p>
</div></body></html>"""
    return HTMLResponse(body, status_code=exc.status_code)


# Order matters: auth + specific service routes, then lifecycle, then proxy.
app.include_router(auth.router)
app.include_router(accounts.router)
app.include_router(services.router)
app.include_router(scaffold.router)        # /api/admin/services/scaffold (+ job status)
app.include_router(home.router)            # /api/admin/home (builtin overrides + card order)
app.include_router(iconlab.router)
app.include_router(reports.router)         # /api/reports + /api/admin/reports (feedback)
app.include_router(system.router)          # /api/admin/system/ports (managed-service port window)
app.include_router(project_mgmt.router)   # /api/services/{svc}/projects… + /pp/…
app.include_router(projects.router)
app.include_router(proxy.router)


@app.on_event("startup")
async def _security_preflight():
    """Log a loud checklist of dev-only settings still active, so an operator who
    exposes the portal publicly sees exactly what to lock down (see DEPLOYMENT.md).
    Warnings only — never blocks startup — but makes an insecure deploy impossible
    to miss in the logs."""
    warns = []
    if config.SECRET_KEY_IS_INSECURE:
        warns.append("PORTAL_SECRET_KEY is unset — using the public dev secret; JWTs can be forged. Set a strong random value.")
    if config.EMAIL_VERIFY_DEV_ECHO:
        warns.append("EMAIL_VERIFY_DEV_ECHO is ON — verification codes / reset passwords are returned in HTTP responses. Do not expose publicly.")
    if config.CORS_ORIGINS == ["*"]:
        warns.append("CORS is open to any origin (*). Set PORTAL_ALLOWED_ORIGINS for production.")
    if not config.BASE_URL.startswith("https://"):
        warns.append(f"PORTAL_BASE_URL is not https ({config.BASE_URL}). Serve the portal over TLS in production.")
    if warns:
        bar = "!" * 72
        print(f"\n{bar}\n[SECURITY] Portal is running with dev-only settings:", flush=True)
        for w in warns:
            print(f"[SECURITY]   • {w}", flush=True)
        print(f"[SECURITY] See service_manager/DEPLOYMENT.md before public deployment.\n{bar}\n", flush=True)


@app.on_event("shutdown")
async def _close_proxy_client():
    """Release the pooled reverse-proxy httpx client (see proxy_util)."""
    from .proxy_util import close_client
    await close_client()


@app.get("/api/health")
def health():
    from . import gitinfo
    return {"ok": True, "service": "service_manager",
            "port": config.PORTAL_PORT, "data_root": str(config.DATA_ROOT),
            "host": gitinfo.hostname(), "version": gitinfo.portal_version()}


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
