"""
Shared reverse-proxy plumbing for `/p/…` (service) and `/pp/…` (project) proxies.

Both proxies used to buffer the ENTIRE request body and the ENTIRE upstream
response in memory (`request.body()` + `urllib …read()`), on a threadpool worker
per request. That meant a single large elog attachment or nptoy ROOT download
ballooned the portal process (the >11 GB incident), ~40 slow requests exhausted
the threadpool and froze the whole portal, and a streaming/SSE upstream never
returned (its buffer grew without bound).

This module replaces that with one pooled async `httpx` client that streams both
directions: request bodies flow upstream chunk-by-chunk and responses stream back
via `StreamingResponse`, so memory stays flat regardless of payload size and no
worker thread is held for the lifetime of a slow transfer. HTML from a self-UI
service is the one case we must buffer — it's small and needs `<base>` injection.
"""
from __future__ import annotations

from typing import Optional

import httpx
from fastapi import Request, Response
from fastapi.responses import StreamingResponse

# Hop-by-hop headers must not be forwarded across a proxy (RFC 7230 §6.1).
_HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade",
}
# Methods that carry a request body worth streaming upstream.
_BODY_METHODS = {"POST", "PUT", "PATCH"}

# One pooled client for all proxied traffic. read=None so SSE, long downloads and
# slow simulation streams aren't cut mid-flight; a short connect timeout still
# fails fast when a backend is down. A client disconnect cancels the response
# generator, which closes the upstream connection — the real backstop against a
# wedged backend (far cheaper now than a held threadpool thread).
_client: Optional[httpx.AsyncClient] = None


def get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=5.0, read=None, write=None, pool=10.0),
            follow_redirects=False,
            limits=httpx.Limits(max_connections=200, max_keepalive_connections=50),
        )
    return _client


async def close_client() -> None:
    """Close the shared client on shutdown (wired from main.py)."""
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def inject_base(html: bytes, base_path: str) -> bytes:
    """Make a self-UI service work under a `<base_path>/` prefix: inject a
    `<base href>` (so relative assets resolve under the prefix) + `__PORTAL_BASE__`
    (so a base-path-aware app routes its API/router through the proxy). See
    AI_SERVICE_GUIDE Q5."""
    inject = (f'<base href="{base_path}/">'
              f'<script>window.__PORTAL_BASE__="{base_path}";</script>').encode()
    low = html.lower()
    i = low.find(b"<head>")
    if i != -1:
        at = i + len(b"<head>")
        return html[:at] + inject + html[at:]
    i = low.find(b"<head")            # <head ...>
    if i != -1:
        end = low.find(b">", i)
        if end != -1:
            return html[:end + 1] + inject + html[end + 1:]
    return inject + html              # no <head> → prepend


def _copy_headers(upstream: httpx.Response, *, body_rewritten: bool):
    """Return (headers_dict, set_cookies) to relay downstream. Drops hop-by-hop,
    content-length (Starlette re-frames), and content-type (passed via media_type).
    When we rewrote the body (HTML injection) we also drop content-encoding, since
    `aread()` handed us the DECODED bytes. Set-Cookie is returned separately so
    multiple cookies survive (a dict would collapse them)."""
    headers: dict[str, str] = {}
    set_cookies: list[str] = []
    for k, v in upstream.headers.multi_items():
        kl = k.lower()
        if kl in _HOP_BY_HOP or kl in ("content-length", "content-type"):
            continue
        if kl == "set-cookie":
            set_cookies.append(v)
            continue
        if body_rewritten and kl == "content-encoding":
            continue
        headers[k] = v
    return headers, set_cookies


def _error_response(exc: Exception) -> Response:
    return Response(
        content=f'{{"detail":"proxy error: {exc}"}}'.encode(),
        status_code=502,
        media_type="application/json",
    )


async def stream_proxy(
    request: Request,
    target: str,
    fwd_headers: dict,
    *,
    html_base: Optional[str] = None,
) -> Response:
    """Proxy `request` to `target`, streaming both directions.

    `fwd_headers` is the caller-curated header set (the routers decide auth
    forwarding). `html_base`, when given, enables `<base>` injection for an HTML
    response under that prefix (e.g. "/p/elog") — the only buffered path.
    """
    client = get_client()
    method = request.method
    content = request.stream() if method in _BODY_METHODS else None
    req = client.build_request(method, target, headers=fwd_headers, content=content)
    try:
        upstream = await client.send(req, stream=True)
    except Exception as exc:                       # ConnectError/timeout/DNS/…
        return _error_response(exc)

    ctype = upstream.headers.get("content-type", "application/octet-stream")

    # Self-UI HTML needs <base> injection → buffer (small) then rewrite.
    if html_base is not None and "text/html" in ctype.lower() and upstream.status_code < 400:
        try:
            body = await upstream.aread()
        except Exception as exc:
            await upstream.aclose()
            return _error_response(exc)
        finally:
            await upstream.aclose()
        body = inject_base(body, html_base)
        headers, set_cookies = _copy_headers(upstream, body_rewritten=True)
        resp = Response(content=body, status_code=upstream.status_code,
                        headers=headers, media_type=ctype)
        for c in set_cookies:
            resp.headers.append("set-cookie", c)
        return resp

    # Everything else streams straight through as raw bytes (content-encoding and
    # framing preserved). aclose() runs when the generator is exhausted OR when
    # the client disconnects and Starlette cancels it.
    headers, set_cookies = _copy_headers(upstream, body_rewritten=False)

    async def body_iter():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()

    resp = StreamingResponse(body_iter(), status_code=upstream.status_code,
                             headers=headers, media_type=ctype)
    for c in set_cookies:
        resp.headers.append("set-cookie", c)
    return resp
