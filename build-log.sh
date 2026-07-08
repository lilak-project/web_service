#!/usr/bin/env bash
# Show or follow the latest background build log.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION="${BUILD_SESSION:-web-service-build}"
LOG_DIR="${BUILD_LOG_DIR:-$ROOT/logs}"
LOG="$LOG_DIR/latest.log"
FOLLOW=0
WATCH=0
INTERVAL=2.0
LINES=80

usage() {
  cat <<'EOF'
Usage: ./build-log.sh [options]

Options:
  -f, --follow      Follow the latest build log.
  -w, --watch       Refresh the latest build log view every 0.5 seconds.
  -n N              Number of lines to show. Default: 80.
  -h, --help        Show this help.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -f|--follow) FOLLOW=1 ;;
    -w|--watch) WATCH=1 ;;
    -n) shift; LINES="${1:?missing line count}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [ ! -e "$LOG" ]; then
  echo "error: no build log found at $LOG" >&2
  exit 1
fi

REAL_LOG="$(readlink -f "$LOG" 2>/dev/null || echo "$LOG")"

show_log() {
  REAL_LOG="$(readlink -f "$LOG" 2>/dev/null || echo "$LOG")"
  echo "log: $REAL_LOG"
  if [ -e "$REAL_LOG" ]; then
    echo "updated: $(stat -c '%y' "$REAL_LOG")"
    echo "size: $(stat -c '%s bytes' "$REAL_LOG")"
  fi
  echo
  tail -n "$LINES" "$LOG"
}

if [ "$WATCH" -eq 1 ]; then
  while true; do
    printf '\033[H\033[2J'
    show_log
    sleep "$INTERVAL"
  done
fi

echo "log: $REAL_LOG"
if [ -e "$REAL_LOG" ]; then
  echo "updated: $(stat -c '%y' "$REAL_LOG")"
  echo "size: $(stat -c '%s bytes' "$REAL_LOG")"
fi
echo

if [ "$FOLLOW" -eq 1 ]; then
  tail -n "$LINES" -F "$LOG"
else
  tail -n "$LINES" "$LOG"
fi
