#!/usr/bin/env bash
# Start the Service Manager portal. Uses, in order: $PORTAL_PYTHON, this repo's
# ./.venv (created by build-all.sh), else the lilak_elog venv. Override PORTAL_PORT.
set -euo pipefail
cd "$(dirname "$0")"

if [ -n "${PORTAL_PYTHON:-}" ]; then PY="$PORTAL_PYTHON"
elif [ -x "./.venv/bin/python" ]; then PY="$PWD/.venv/bin/python"
else PY="$HOME/web_service/lilak_elog/.venv/bin/python"; fi
PORT="${PORTAL_PORT:-8025}"

if [ ! -x "$PY" ]; then
  echo "Python not found at $PY — set PORTAL_PYTHON to a venv with fastapi/uvicorn/jose." >&2
  exit 1
fi

echo "→ Service Manager on http://localhost:$PORT"
# Watch ONLY app/ — so building frontends or the venv (which write thousands of
# files under this repo) doesn't flood the reloader and crash the server.
exec "$PY" -m uvicorn app.main:app --host 0.0.0.0 --port "$PORT" --reload --reload-dir app
