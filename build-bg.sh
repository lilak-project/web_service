#!/usr/bin/env bash
# Run build.sh in a detached tmux session and capture its output to a log file.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION="${BUILD_SESSION:-web-service-build}"
LOG_DIR="${BUILD_LOG_DIR:-$ROOT/logs}"
LOG="$LOG_DIR/build-$(date +%Y%m%d-%H%M%S).log"

usage() {
  cat <<'EOF'
Usage: ./build-bg.sh [build.sh options]

Starts ./build.sh in a detached tmux session so the build survives SSH disconnects.
All arguments are passed through to build.sh, for example:

  ./build-bg.sh --sci
  ./build-bg.sh --sci --prune

If this user can't reach the Docker daemon directly, the build runs under sudo
(you're prompted for a password once, at launch); the detached session then runs
as root. Use `sudo tmux attach -t web-service-build` to attach in that case.

Useful commands:
  ./build-log.sh         Show recent output from the latest build log.
  ./build-log.sh -f      Follow the latest build log live.
  tmux attach -t web-service-build          (add sudo if the build runs elevated)
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

command -v tmux >/dev/null || { echo "error: tmux is required" >&2; exit 1; }

# build.sh needs Docker. A detached tmux session has no tty, so build.sh's own
# `sudo docker` fallback can't prompt for a password there. Instead, if this user
# can't reach the Docker daemon directly, run the WHOLE thing (tmux + build.sh)
# under sudo — authenticate ONCE here, interactively, at launch; the detached
# session then runs as root (direct Docker access) and survives disconnects.
SUDO=""
if ! docker compose version >/dev/null 2>&1; then
  if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null; then
    echo "==> Docker needs elevation — you may be prompted for your password now"
    sudo -v
    SUDO="sudo"
  fi
fi

if $SUDO tmux has-session -t "$SESSION" >/dev/null 2>&1; then
  echo "error: build session already running: $SESSION" >&2
  echo "attach: ${SUDO:+$SUDO }tmux attach -t $SESSION" >&2
  echo "log:    ./build-log.sh" >&2
  exit 1
fi

mkdir -p "$LOG_DIR"
ln -sfn "$LOG" "$LOG_DIR/latest.log"

quoted_args=""
if [ "$#" -gt 0 ]; then
  printf -v quoted_args ' %q' "$@"
fi
cmd="cd $(printf %q "$ROOT"); ./build.sh$quoted_args 2>&1 | tee $(printf %q "$LOG"); rc=\${PIPESTATUS[0]}; echo; echo \"==> build exited with status \$rc\" | tee -a $(printf %q "$LOG"); exit \$rc"

$SUDO tmux new-session -d -s "$SESSION" "bash -lc $(printf %q "$cmd")"

echo "started build session: $SESSION${SUDO:+ (as root via sudo)}"
echo "log: $LOG"
echo
echo "Recent output:"
sleep 1
tail -n 40 "$LOG" || true
