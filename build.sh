#!/usr/bin/env bash
# Build and restart the local Docker Compose deployment. Does not pull code.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKER=(docker)
BUILD_ONLY=0
FORCE_RECREATE=1
PRUNE=0
PROFILE_ARGS=()
SCI=0

usage() {
  cat <<'EOF'
Usage: ./build.sh [options]

Options:
  --build-only      Build the image but do not restart containers.
  --sci             Include the sci-runner profile required by nptoy.
  --no-force        Do not force-recreate containers on restart.
  --prune           Run docker image prune -f after a successful build.
  -h, --help        Show this help.

Environment:
  SUDO=sudo         Docker sudo command when direct Docker access is unavailable.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --build-only) BUILD_ONLY=1 ;;
    --sci) SCI=1; PROFILE_ARGS=(--profile sci) ;;
    --no-force) FORCE_RECREATE=0 ;;
    --prune) PRUNE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

cd "$ROOT"

# Always refresh the nptool snapshot for a --sci build so local nptool_cens edits
# (e.g. SteppingAction changes) actually reach the image. stage-nptool.sh is an
# idempotent rsync, so re-running it when nptool-src already exists is cheap and, more
# importantly, keeps the built binary in sync with the source. Set NPTOOL_NO_STAGE=1
# to skip (e.g. when you intentionally hand-edited sci-runner/nptool-src directly).
if [ "$SCI" -eq 1 ] && [ "${NPTOOL_NO_STAGE:-0}" != "1" ]; then
  echo "==> Staging nptool_cens for sci-runner"
  "$ROOT/sci-runner/stage-nptool.sh"
fi

if ! "${DOCKER[@]}" compose version >/dev/null 2>&1; then
  DOCKER=("${SUDO:-sudo}" docker)
fi

echo "==> Validating Compose config"
"${DOCKER[@]}" compose config >/dev/null

if [ "$BUILD_ONLY" -eq 1 ]; then
  echo "==> Building image"
  "${DOCKER[@]}" compose "${PROFILE_ARGS[@]}" build
else
  echo "==> Building and restarting deployment"
  UP_ARGS=(up -d --build)
  if [ "$FORCE_RECREATE" -eq 1 ]; then
    UP_ARGS+=(--force-recreate)
  fi
  "${DOCKER[@]}" compose "${PROFILE_ARGS[@]}" "${UP_ARGS[@]}"
fi

if [ "$PRUNE" -eq 1 ]; then
  echo "==> Pruning dangling images"
  "${DOCKER[@]}" image prune -f
fi

echo "==> Current status"
"${DOCKER[@]}" compose "${PROFILE_ARGS[@]}" ps

echo "✓ build complete for $ROOT at $(git rev-parse --short HEAD)"
