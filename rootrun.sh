#!/usr/bin/env bash
# rootrun.sh — run a ROOT macro inside the sci-runner container via the shared inbox
# folder (./sci-work/root-inbox ↔ /work/root-inbox), no docker access needed.
#
#   ./rootrun.sh mymacro.C            # run a macro file (defines a fn named like the file)
#   ./rootrun.sh -e 'printf("hi\n");' # run an inline snippet
#
# The macro can read the read-only user data at /portal-data/nptoy/user/... and the
# shared volume at /data. Requires the sci-runner to be running with the /work mount
# and the inbox watcher (deploy: ./build-bg.sh --sci).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
INBOX="$HERE/sci-work/root-inbox"
mkdir -p "$INBOX"

STEM="rr_$$_$(date +%s 2>/dev/null || echo x)"
MACRO="$INBOX/$STEM.C"
OUT="$INBOX/$STEM.out"

if [ "${1:-}" = "-e" ]; then
  printf 'void %s(){\n%s\n}\n' "$STEM" "$2" > "$MACRO"
else
  [ -f "${1:-}" ] || { echo "usage: $0 <macro.C> | -e '<snippet>'" >&2; exit 2; }
  # wrap-agnostic: if the file already defines a function, ROOT runs it; else it's an
  # unnamed macro. We copy under a unique name and rename the entry fn if it's `void <base>()`.
  BASE="$(basename "${1%.C}")"
  sed "s/void[[:space:]]\+$BASE[[:space:]]*(/void $STEM(/" "$1" > "$MACRO"
fi

# wait for the watcher to produce output newer than the macro (≤ ~190s)
for _ in $(seq 1 95); do
  if [ -f "$OUT" ] && [ "$OUT" -nt "$MACRO" ]; then
    cat "$OUT"
    rm -f "$MACRO" "$OUT" 2>/dev/null || true
    exit 0
  fi
  sleep 2
done
echo "rootrun: timed out waiting for $OUT (is sci-runner up with the inbox watcher?)" >&2
exit 1
