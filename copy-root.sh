#!/usr/bin/env bash
# Copy one of your .root outputs out of the portal container to /tmp (world-readable)
# so it can be inspected locally. Finds the file wherever nptoy stores it.
#   ~/web_service/copy-root.sh                       # default GasCF4_2.jungwoo.sim.root
#   ~/web_service/copy-root.sh SomeOther.sim.root
set -u

#FILE="${1:-GasCF4_2.jungwoo.sim.root}"
FILE="${1:-HPGe_2.jungwoo.sim.root}"

DOCKER="docker"; SUDO=""
if ! docker ps >/dev/null 2>&1; then DOCKER="sudo docker"; SUDO="sudo"; fi

C=$($DOCKER ps --format '{{.Names}}' | grep portal | head -1)
[ -z "$C" ] && { echo "portal container not running"; exit 1; }

echo "locating $FILE in $C ..."
SRC=$($DOCKER exec "$C" sh -c "find /app -name '$FILE' 2>/dev/null | head -1")
if [ -z "$SRC" ]; then
  echo "could not find '$FILE'. .sim.root / .root files present in the container:"
  $DOCKER exec "$C" sh -c "find /app -name '*.root' 2>/dev/null | head -40"
  exit 1
fi

DST="/tmp/$(basename "$SRC")"
echo "copying  $C:$SRC  ->  $DST"
$DOCKER cp "$C:$SRC" "$DST" || exit 1
$SUDO chmod a+r "$DST"
ls -l "$DST"
echo "done — tell Claude it's at $DST"
