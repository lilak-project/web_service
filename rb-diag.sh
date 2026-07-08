#!/usr/bin/env bash
# RBrowser / sci-runner diagnostic.
# Tells us (1) whether the key-race fix is actually running in the sci-runner
# container, and (2) the recent sci-runner + portal logs around an RBrowser open.
#
# Usage:  ~/web_service/rb-diag.sh      (click "RBrowser 열기" first, then run this)
set -u

# Use docker directly if we can; otherwise fall back to sudo (asks once, then caches).
DOCKER="docker"
if ! docker ps >/dev/null 2>&1; then
  DOCKER="sudo docker"
fi

S=$($DOCKER ps --format '{{.Names}}' | grep sci-runner | head -1)
P=$($DOCKER ps --format '{{.Names}}' | grep portal    | head -1)

echo "sci-runner container = ${S:-<none running>}"
echo "portal container     = ${P:-<none running>}"
echo

if [ -n "$S" ]; then
  keyfix=$($DOCKER exec "$S" grep -c 'wait for BOTH' /opt/runner.py 2>/dev/null || echo 0)
  drainer=$($DOCKER exec "$S" grep -c '_drain_stream' /opt/runner.py 2>/dev/null || echo 0)
  maxsize=$($DOCKER exec "$S" grep -c 'max_size=None' /opt/runner.py 2>/dev/null || echo 0)
  echo "deployed in sci-runner:  key-race-fix=$keyfix  stdout-drainer=$drainer  ws-max_size=$maxsize   (each should be >=1)"
  alive=$($DOCKER exec "$S" sh -c 'pgrep -fc "web=server" 2>/dev/null || echo 0')
  echo "ROOT (root --web=server) processes alive = $alive   (0 after a double-click => backend CRASH; >=1 => client-side)"
  echo
  echo "===== full ROOT output, newest session (/tmp/rb-*.log) ====="
  $DOCKER exec "$S" sh -c 'f=$(ls -t /tmp/rb-*.log 2>/dev/null | head -1); [ -n "$f" ] && echo "($f)" && tail -60 "$f"' 2>/dev/null || echo "(no rb-*.log yet — rebuild + reopen RBrowser first)"
  echo
  echo "===== ROOT crash lines echoed to docker log (if any) ====="
  $DOCKER logs --tail=400 "$S" 2>&1 | grep -F '[rbrowser:' | tail -25 || true
  echo
  echo "===== sci-runner log (last 60 lines) ====="
  $DOCKER logs --tail=60 "$S" 2>&1 | tail -50
fi

if [ -n "$P" ]; then
  echo
  echo "===== portal log (rbrowser / win1 / websocket / errors) ====="
  $DOCKER logs --tail=200 "$P" 2>&1 \
    | grep -Ei 'rbrowser|win1|websocket|403|500|error|traceback' | tail -40
fi
