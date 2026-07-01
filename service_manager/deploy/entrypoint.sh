#!/bin/sh
# Seed the data volume on FIRST run (when it's empty) with the pre-registered
# services baked into the image — so a fresh container comes up "knowing" them.
# On later runs the existing volume data is kept untouched.
set -e

mkdir -p "$PORTAL_DATA_ROOT"
if [ -z "$(ls -A "$PORTAL_DATA_ROOT" 2>/dev/null)" ] && [ -d /app/data-seed ]; then
  echo "→ seeding $PORTAL_DATA_ROOT from baked /app/data-seed"
  cp -a /app/data-seed/. "$PORTAL_DATA_ROOT"/
fi

exec python3 -m uvicorn app.main:app --host 0.0.0.0 --port "${PORTAL_PORT:-8025}"
