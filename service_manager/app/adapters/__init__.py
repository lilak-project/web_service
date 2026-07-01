"""Adapter selection by manifest `mode`."""
from __future__ import annotations

from .base import Adapter
from .external import ExternalAdapter
from .managed import ManagedAdapter

_ADAPTERS: dict[str, Adapter] = {
    "managed": ManagedAdapter(),
    "external": ExternalAdapter(),
}


def get_adapter(manifest: dict) -> Adapter:
    mode = (manifest or {}).get("mode", "managed")
    adapter = _ADAPTERS.get(mode)
    if adapter is None:
        raise ValueError(f"unknown service mode: {mode!r}")
    return adapter
