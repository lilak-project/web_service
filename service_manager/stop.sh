#!/usr/bin/env bash
# Stop the Service Manager portal (and only this one — matched by app.main:app).
set -uo pipefail
PORT="${PORTAL_PORT:-8025}"
pids=$(lsof -ti ":$PORT" -sTCP:LISTEN 2>/dev/null || true)
if [ -z "$pids" ]; then
  echo "Nothing listening on :$PORT"
  exit 0
fi
echo "Stopping portal on :$PORT (pids: $pids)"
kill $pids 2>/dev/null || true
sleep 1
for p in $pids; do kill -9 "$p" 2>/dev/null || true; done
