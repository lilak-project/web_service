#!/usr/bin/env bash
# Assemble a Docker BUILD CONTEXT from the (split) source repos on this machine.
# Copies the three repos as siblings into one dir (excluding build artifacts), so
# `docker compose build` has them in one context. On a fresh server you'd instead
# just clone the three side by side and skip this.
set -euo pipefail

SM=${SM_DIR:-$HOME/web_service/service_manager}
PARENT=$(dirname "$SM")                          # the 3 repos sit side by side here
UI=${LILAK_UI_DIR:-$PARENT/lilak_ui}
ELOG=${LILAK_ELOG_DIR:-$PARENT/lilak_elog}
STACK=${STACK_DIR:-$HOME/web_service/_stack}

for d in "$UI" "$ELOG" "$SM"; do
  [ -d "$d" ] || { echo "✗ missing: $d" >&2; exit 1; }
done

echo "→ staging into $STACK"
mkdir -p "$STACK"
EXCL=(--exclude node_modules --exclude .venv --exclude dist --exclude .git
      --exclude __pycache__ --exclude data --exclude _stack)
rsync -a --delete "${EXCL[@]}" "$UI/"   "$STACK/lilak_ui/"
rsync -a --delete "${EXCL[@]}" "$ELOG/" "$STACK/lilak_elog/"
rsync -a --delete "${EXCL[@]}" "$SM/"   "$STACK/service_manager/"
# .dockerignore must sit at the build-context root to take effect.
cp "$SM/deploy/.dockerignore" "$STACK/.dockerignore"

echo "✓ staged. Now build with:"
echo "    STACK_DIR=$STACK docker compose -f $SM/deploy/docker-compose.yml up -d --build"
