"""
Reverse proxy — `/p/{name}/...` → that service's backend.

A single stable entry point (this portal's port): external systems save
`http://<host>/p/<service>` and the service's real location (local port or remote
URL) can change freely. Managed services are booted on demand; the target and any
auth headers come from the service's adapter.
"""
from __future__ import annotations

import asyncio

import websockets
from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from starlette.concurrency import run_in_threadpool

from .. import permissions, registry, security
from ..adapters import get_adapter
from ..db import SessionLocal
from ..proxy_util import login_redirect_or_401, stream_proxy

router = APIRouter()


def _block_if_mirror(request: Request, svc: str) -> None:
    """A synced sub holds a MIRROR: anything written here is silently discarded by
    the next pull, so refuse writes outright rather than lose the user's work.
    Method-based because the portal proxies opaque services — GET/HEAD/OPTIONS read,
    everything else writes."""
    if request.method in ("GET", "HEAD", "OPTIONS"):
        return
    from .. import sync
    if sync.is_read_only(svc):
        raise HTTPException(403, "이 서비스는 다른 서버(main)를 미러링 중이라 읽기 전용입니다.")


def _guard(request: Request, name: str) -> None:
    """Enter-permission on a single service (project=''). Token from header or the
    `lilak_portal_token` cookie (top-level navigations carry no auth header)."""
    _block_if_mirror(request, name)
    token = security.bearer(request.headers.get("authorization")) or request.cookies.get("lilak_portal_token")
    db = SessionLocal()
    try:
        user = permissions.user_from_request(db, token)
        if not user:
            raise login_redirect_or_401(request)
        if not permissions.can_enter_project(db, user, name, ""):
            if not permissions.verification_current(user):
                raise HTTPException(403, "이메일 재인증이 필요합니다 (연 1회).")
            raise HTTPException(403, "이 서비스에 대한 권한이 없습니다.")
    finally:
        db.close()


@router.api_route("/p/{name}/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def service_proxy(name: str, path: str, request: Request):
    if not registry.service_dir(name).exists():
        raise HTTPException(404, f"'{name}' not found")
    # The guard hits SQLite synchronously — run it off the event loop so DB
    # contention can't freeze the whole portal's async proxy path.
    await run_in_threadpool(_guard, request, name)
    manifest = registry.read_manifest(name)
    adapter = get_adapter(manifest)
    base = await run_in_threadpool(adapter.target_base, name, manifest)
    if not base:
        raise HTTPException(502, f"'{name}' is not reachable")

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

    return await stream_proxy(request, target, fwd, html_base=f"/p/{name}")


@router.websocket("/p/{name}/{path:path}")
async def service_proxy_ws(name: str, path: str, websocket: WebSocket):
    """WebSocket sibling of `service_proxy`. HTTP-only proxying breaks any service
    that needs a live socket under `/p/<name>/` (e.g. nptoy's RBrowser, whose JSROOT
    UI opens `…/root.websocket`). We bridge the browser socket to the service's own
    socket; the service proxies onward from there. Guard via the portal cookie —
    browser WebSocket handshakes carry cookies but no Authorization header."""
    if not registry.service_dir(name).exists():
        await websocket.close(code=1008)
        return
    try:
        _guard(websocket, name)                      # reads .headers/.cookies — WS has both
    except HTTPException:
        await websocket.close(code=1008)
        return
    manifest = registry.read_manifest(name)
    adapter = get_adapter(manifest)
    base = await run_in_threadpool(adapter.target_base, name, manifest)
    if not base:
        await websocket.close(code=1011)
        return

    # http(s)://host:port → ws(s)://host:port, keeping the path + query intact.
    ws_base = ("wss://" + base[len("https://"):]) if base.startswith("https://") \
        else ("ws://" + base[len("http://"):])
    qs = websocket.url.query
    target = f"{ws_base}/{path}" + (f"?{qs}" if qs else "")

    await websocket.accept()
    try:
        async with websockets.connect(target, max_size=None) as upstream:
            async def client_to_upstream():
                try:
                    while True:
                        msg = await websocket.receive()
                        if msg.get("text") is not None:
                            await upstream.send(msg["text"])
                        elif msg.get("bytes") is not None:
                            await upstream.send(msg["bytes"])
                        elif msg.get("type") == "websocket.disconnect":
                            break
                except WebSocketDisconnect:
                    pass
                finally:
                    await upstream.close()

            async def upstream_to_client():
                try:
                    async for m in upstream:
                        if isinstance(m, (bytes, bytearray)):
                            await websocket.send_bytes(m)
                        else:
                            await websocket.send_text(m)
                except Exception:
                    pass

            done, pending = await asyncio.wait(
                [asyncio.create_task(client_to_upstream()),
                 asyncio.create_task(upstream_to_client())],
                return_when=asyncio.FIRST_COMPLETED,
            )
            for t in pending:
                t.cancel()
    except Exception:
        pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass
