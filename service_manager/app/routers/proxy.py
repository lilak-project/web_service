"""
Reverse proxy — `/p/{name}/...` → that service's backend.

A single stable entry point (this portal's port): external systems save
`http://<host>/p/<service>` and the service's real location (local port or remote
URL) can change freely. Managed services are booted on demand; the target and any
auth headers come from the service's adapter.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request

from fastapi import APIRouter, HTTPException, Request, Response
from starlette.concurrency import run_in_threadpool

from .. import permissions, registry, security
from ..adapters import get_adapter
from ..db import SessionLocal

router = APIRouter()


def _guard(request: Request, name: str) -> None:
    """Enter-permission on a single service (project=''). Token from header or the
    `lilak_portal_token` cookie (top-level navigations carry no auth header)."""
    token = security.bearer(request.headers.get("authorization")) or request.cookies.get("lilak_portal_token")
    db = SessionLocal()
    try:
        user = permissions.user_from_request(db, token)
        if not user:
            raise HTTPException(401, "로그인이 필요합니다.")
        if not permissions.can_enter_project(db, user, name, ""):
            if not permissions.verification_current(user):
                raise HTTPException(403, "이메일 재인증이 필요합니다 (연 1회).")
            raise HTTPException(403, "이 서비스에 대한 권한이 없습니다.")
    finally:
        db.close()


def _inject_base(html: bytes, base_path: str) -> bytes:
    """Make a self-UI service work under the `/p/<name>/` prefix: inject a <base>
    (relative assets resolve under the prefix) + `__PORTAL_BASE__`. See guide Q5."""
    inject = (f'<base href="{base_path}/">'
              f'<script>window.__PORTAL_BASE__="{base_path}";</script>').encode()
    low = html.lower()
    i = low.find(b"<head>")
    if i != -1:
        at = i + len(b"<head>")
        return html[:at] + inject + html[at:]
    i = low.find(b"<head")
    if i != -1:
        end = low.find(b">", i)
        if end != -1:
            return html[:end + 1] + inject + html[end + 1:]
    return inject + html


def _do_proxy(method: str, url: str, headers: dict, body: bytes):
    req = urllib.request.Request(url, data=body if body else None, method=method)
    for k, v in headers.items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read(), r.headers.get("Content-Type", "application/json")
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers.get("Content-Type", "application/json")
    except Exception as e:
        return 502, json.dumps({"detail": f"proxy error: {e}"}).encode(), "application/json"


@router.api_route("/p/{name}/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def service_proxy(name: str, path: str, request: Request):
    if not registry.service_dir(name).exists():
        raise HTTPException(404, f"'{name}' not found")
    _guard(request, name)
    manifest = registry.read_manifest(name)
    adapter = get_adapter(manifest)
    base = await run_in_threadpool(adapter.target_base, name, manifest)
    if not base:
        raise HTTPException(502, f"'{name}' is not reachable")

    body = await request.body()
    qs = request.url.query
    target = f"{base}/{path}" + (f"?{qs}" if qs else "")

    fwd = {}
    for h in ("content-type", "accept"):
        if h in request.headers:
            fwd[h] = request.headers[h]

    # Auth handoff per the service contract (§7): a service that accepts the
    # portal token (SSO) gets the caller's Authorization forwarded; otherwise the
    # user's token is NOT leaked — the service's own token (if any) is attached.
    identity = manifest.get("identity") or {}
    accepts_portal = identity.get("accepts_portal_token", manifest.get("mode") == "managed")
    if accepts_portal:
        if "authorization" in request.headers:
            fwd["authorization"] = request.headers["authorization"]
    else:
        fwd.update(adapter.proxy_headers(manifest))

    status, content, ctype = await run_in_threadpool(_do_proxy, request.method, target, fwd, body)
    if "text/html" in (ctype or "") and status < 400:
        content = _inject_base(content, f"/p/{name}")
    return Response(content=content, status_code=status, media_type=ctype)
