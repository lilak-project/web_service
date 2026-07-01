#!/usr/bin/env bash
# Update the deployed LILAK Web Portal on a server — git + build-on-server, over SSH.
# The server keeps its own data (host folder / $PORTAL_DATA_DIR); this only ships code.
#
# One-time server setup: see DEPLOY.md. Then every update is just:
#   ./deploy.sh user@server                 # remote dir defaults to /opt/web_service
#   ./deploy.sh user@server /srv/web_service
set -euo pipefail
HOST="${1:?usage: ./deploy.sh user@host [remote_dir]}"
DIR="${2:-/opt/web_service}"

echo "▶ bump submodules to their latest pushed commit…"
git submodule update --remote --recursive
if ! git diff --quiet || ! git diff --cached --quiet; then
  git add -A
  git commit -m "deploy: bump submodules + local changes"
fi

echo "▶ push superrepo (+ any submodule commits)…"
git push --recurse-submodules=on-demand origin HEAD

echo "▶ pull + rebuild on $HOST:$DIR (data untouched)…"
ssh "$HOST" "set -e; cd '$DIR'; \
  git pull --recurse-submodules; \
  git submodule update --init --recursive; \
  docker compose up -d --build; \
  docker image prune -f"

echo "✓ deployed to $HOST:$DIR — portal on :8025, data folder untouched."
