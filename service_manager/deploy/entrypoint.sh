#!/bin/sh
# Portal container entrypoint.
#
# Services are NOT pre-registered any more: a fresh install starts empty and an
# admin installs what they want from the Service Manager card (git clone → build →
# register). The manifests under /app/data-seed are kept as TEMPLATES for that
# installer (PORTAL_SEED_ROOT), not as things to copy into the data volume.
#
# Existing deployments are unaffected — their services already live in the volume.
set -e

mkdir -p "$PORTAL_DATA_ROOT"

exec python3 -m uvicorn app.main:app --host 0.0.0.0 --port "${PORTAL_PORT:-8025}"
