#!/bin/sh
# Seed the data volume with the pre-registered services baked into the image.
#
# Runs EVERY start, but only adds services that aren't in the volume yet — so a
# fresh volume gets them all, and a redeploy that introduces a NEW service (e.g.
# nptoy added after the first deploy) makes it appear WITHOUT touching existing
# data. Existing service dirs are never overwritten (their live data/config wins).
set -e

mkdir -p "$PORTAL_DATA_ROOT"
if [ -d /app/data-seed ]; then
  for seed in /app/data-seed/*/; do
    [ -d "$seed" ] || continue
    name=$(basename "$seed")
    if [ -d "$PORTAL_DATA_ROOT/$name" ]; then
      continue                                   # already present — keep live data
    fi
    if [ -e "$PORTAL_DATA_ROOT/_deleted/$name" ]; then
      echo "→ skipping seed '$name' (deleted by an admin)"
      continue                                   # tombstoned — don't resurrect it
    fi
    echo "→ seeding service '$name'"
    cp -a "${seed%/}" "$PORTAL_DATA_ROOT/$name"
  done
fi

exec python3 -m uvicorn app.main:app --host 0.0.0.0 --port "${PORTAL_PORT:-8025}"
