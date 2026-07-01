#!/usr/bin/env bash
# Standalone dev runner (outside the portal). Uses the shared portal venv so the
# deps match what the managed adapter will spawn. The portal sets $PORT itself;
# here we default to 8050 (PLAN §3) and a dev secret matching the portal default.
set -euo pipefail
cd "$(dirname "$0")"

VENV="${G4TOY_VENV:-$HOME/web_service/service_manager/.venv}"
PORT="${PORT:-8050}"

exec "$VENV/bin/python" -m uvicorn main:app \
  --host 0.0.0.0 --port "$PORT" --reload
