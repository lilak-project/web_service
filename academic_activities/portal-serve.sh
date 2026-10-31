#!/usr/bin/env sh
# Portal entry: build the app (non-fatal), then run the backend on the shared venv.
set -u
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PORT="${1:-8050}"
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
export PATH
# Build only when the app's sources — or the kit's — are newer than the last
# build: a start with nothing changed skips Vite's ~2 s (the portal starts
# several of these at once, and each waited on its own build).
KIT="${LILAK_UI_PATH:-$ROOT_DIR/../lilak_ui}"
stale() {
  [ ! -f "$ROOT_DIR/dist/index.html" ] && return 0
  [ -n "$(find "$ROOT_DIR/src-lilak" "$ROOT_DIR/index.html" "$ROOT_DIR/vite.config.js" "$ROOT_DIR/package.json" \
    "$KIT/src" -newer "$ROOT_DIR/dist/index.html" -print 2>/dev/null | head -n 1)" ]
}
if command -v npm >/dev/null 2>&1 && stale; then
  LILAK_UI_PATH="${LILAK_UI_PATH:-$ROOT_DIR/../lilak_ui}" npm --prefix "$ROOT_DIR" run build \
    || echo "[portal-serve] build failed; serving existing dist/" >&2
fi
cd "$ROOT_DIR/backend"
ACADEMIC_ACTIVITIES_DATA_DIR="${PORTAL_PROJECT_DATA:-$ROOT_DIR/data}" ACADEMIC_ACTIVITIES_DIST_DIR="$ROOT_DIR/dist" \
  exec "$ROOT_DIR/../service_manager/.venv/bin/python" -m uvicorn main:app --host 127.0.0.1 --port "$PORT"
