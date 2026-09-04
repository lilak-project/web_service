#!/usr/bin/env bash
# Run the portal NATIVELY (no Docker) — the deployment this lab actually needs.
#
# Why native: every managed service here drives hardware on THIS host (serial
# /dev/ttyUSB*, libcaenhvwrapper.so, EtherNet/IP actuators). In a container each
# of those needs a device mount, a vendored .so and an image rebuild per code
# edit; natively they are simply there. `/app` being an image layer also meant a
# service's code could only change by rebuilding — the whole reason this exists.
#
# What Docker gave that this does NOT: a memory ceiling. A single portal python
# once passed 11 GB and took the desktop down with it (see proxy_util.py). The
# systemd unit is where that ceiling comes back — MemoryMax=3G. Do not run this
# unsupervised in place of the unit.
set -euo pipefail
cd "$(dirname "$0")"

# The compose env file is the ONE source of secrets/config for both deployments,
# so native and Docker can never drift apart.
set -a; . ./.env; set +a

# compose speaks PORTAL_DATA_DIR (a bind-mount source, possibly relative);
# the app speaks PORTAL_DATA_ROOT (an absolute path). Translate, don't duplicate.
export PORTAL_DATA_ROOT="$(cd "${PORTAL_DATA_DIR:-./portal-data}" && pwd)"

PY="${PORTAL_PYTHON:-/usr/bin/python3}"
PORT="${PORTAL_PORT:-8025}"
BIND="${PORTAL_BIND:-0.0.0.0}"

echo "→ portal   http://${BIND}:${PORT}"
echo "  data     $PORTAL_DATA_ROOT"
echo "  python   $PY"

cd service_manager
# No --reload: the portal SPAWNS service backends as children, and a reloader
# restart orphans them (a second elog fighting for the same data dir).
exec "$PY" -m uvicorn app.main:app --host "$BIND" --port "$PORT" --workers 1
