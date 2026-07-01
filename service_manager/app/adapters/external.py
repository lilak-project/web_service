"""
External adapter — a service running elsewhere (another host/process).

The portal owns no lifecycle here: it only gates visibility/permission and
proxies to the manifest's `url`, attaching the configured bearer `token`. This is
how one portal fronts services across many hosts (Phase B).
"""
from __future__ import annotations

import urllib.error
import urllib.request
from typing import Optional

from .base import Adapter


class ExternalAdapter(Adapter):
    mode = "external"

    def _reachable(self, manifest: dict) -> bool:
        url = manifest.get("url")
        if not url:
            return False
        health = manifest.get("health") or "/"
        probe = url.rstrip("/") + "/" + health.lstrip("/")
        req = urllib.request.Request(probe, method="GET")
        token = manifest.get("token")
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(req, timeout=4) as r:
                return r.status < 500
        except urllib.error.HTTPError as e:
            return e.code < 500           # 401/403 still means "it's up"
        except Exception:
            return False

    def status(self, name: str, manifest: dict) -> dict:
        url = manifest.get("url")
        return {"running": self._reachable(manifest), "port": None, "url": url}

    def start(self, name: str, manifest: dict) -> dict:
        return {"running": self._reachable(manifest), "port": None,
                "url": manifest.get("url"), "external": True}

    def stop(self, name: str, manifest: dict) -> dict:
        return {"stopped": False, "reason": "external service (not managed)"}

    def target_base(self, name: str, manifest: dict) -> Optional[str]:
        url = manifest.get("url")
        return url.rstrip("/") if url else None

    def proxy_headers(self, manifest: dict) -> dict:
        token = manifest.get("token")
        return {"Authorization": f"Bearer {token}"} if token else {}
