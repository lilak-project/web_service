#!/usr/bin/env bash
# Open an interactive shell in the sci-runner container with the full ROOT + Geant4 +
# nptool environment ready (auto-sourced via /root/.bashrc). You land in /work, which
# is the host folder ./sci-work (override with SCI_WORK_DIR). The portal's shared data
# is at /data (read-write); user data is at /portal-data (read-only).
set -u
DOCKER="docker"
docker ps >/dev/null 2>&1 || DOCKER="sudo docker"
C=$($DOCKER ps --format '{{.Names}}' | grep sci-runner | head -1)
if [ -z "$C" ]; then
  echo "sci-runner container isn't running."
  echo "start it with:  ./build.sh --sci   (or: docker compose --profile sci up -d)"
  exit 1
fi
echo "entering $C  (root/geant4/nptool ready; /work ↔ host ./sci-work, /data = shared)"
exec $DOCKER exec -it "$C" bash
