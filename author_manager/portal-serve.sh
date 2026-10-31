#!/usr/bin/env sh
# Portal entry point for the author_manager managed service.
#
# Rebuilds the Vite app (src-lilak/ -> dist/) on a start when its sources
# changed since the last build (stale(), below), then runs the
# FastAPI backend (backend/main.py: shared per-project storage + static dist),
# so a portal "stop & start" picks up source changes without a manual build.
# Both steps are NON-FATAL: a failed build serves the existing dist/, and a
# missing venv/uvicorn falls back to the plain static server (no /api/data,
# but a stale UI beats a dead service).
#
# Invoked by data/author_manager/service.json as: sh portal-serve.sh {port}
# The portal also injects PORTAL_PROJECT / PORTAL_PROJECT_DATA into the env.
set -u

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PORT="${1:-${PORT:-8040}}"

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
  LILAK_UI_PATH="${LILAK_UI_PATH:-$ROOT_DIR/../lilak_ui}" \
    npm --prefix "$ROOT_DIR" run build \
    || echo "[portal-serve] build failed; serving existing dist/" >&2
else
  echo "[portal-serve] npm not on PATH; serving existing dist/" >&2
fi

# The shared portal venv has fastapi/uvicorn + lilak_portal_auth.
VENV_PY="${AUTHOR_PYTHON:-$ROOT_DIR/../service_manager/.venv/bin/python}"
if [ -x "$VENV_PY" ] && [ -f "$ROOT_DIR/backend/main.py" ]; then
  cd "$ROOT_DIR/backend"
  AUTHOR_DATA_DIR="${PORTAL_PROJECT_DATA:-$ROOT_DIR/data}" \
  AUTHOR_DIST_DIR="$ROOT_DIR/dist" \
    exec "$VENV_PY" -m uvicorn main:app --host 127.0.0.1 --port "$PORT"
fi

echo "[portal-serve] backend venv not found; falling back to static dist/" >&2
exec python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$ROOT_DIR/dist"
