#!/usr/bin/env bash
# Fleet gate for lilak_ui kit changes.
#
# The kit is source-aliased into ~6 frontends, so editing it is an INSTANT
# fleet-wide deploy with no CI to catch a break — the failure otherwise only
# surfaces when some consumer's dev server crashes, possibly weeks later. Run this
# before calling a kit change done: it runs the kit smoke test, then does a STRICT
# production build of every consumer against the current kit. Unlike build-all.sh
# (which tolerates a dirty submodule failing), ANY failure here exits non-zero.
#
# Assumes each consumer already has node_modules (run build-all.sh once first).
# Override the kit location with LILAK_UI_DIR.
set -uo pipefail

PORTAL=$(cd "$(dirname "$0")" && pwd)
STACK=$(dirname "$PORTAL")
UI=${LILAK_UI_DIR:-$STACK/lilak_ui}

fail=0

echo "── kit smoke test ──"
if ( cd "$UI" && npm test --silent ); then
  echo "✓ kit smoke test"
else
  echo "✗ kit smoke test FAILED"; fail=1
fi

# Every consumer that source-aliases the kit. Portal-owned first, then submodules.
consumers=(
  "$PORTAL/frontend"
  "$STACK/lilak_elog/frontend"
  "$STACK/nptoy/frontend"
  "$STACK/g4toy/frontend"
  "$STACK/lilak_gui/frontend"
  "$STACK/asset_manager"
)
for c in "${consumers[@]}"; do
  [ -f "$c/package.json" ] || { echo "⚠ skip (no package.json): $c"; continue; }
  echo "── build: ${c#$STACK/} ──"
  if ( cd "$c" && LILAK_UI_PATH="$UI" npm run build >/dev/null 2>&1 ); then
    echo "✓ ${c#$STACK/}"
  else
    echo "✗ BUILD FAILED: ${c#$STACK/}"; fail=1
  fi
done

echo
if [ "$fail" -eq 0 ]; then
  echo "✓ fleet gate passed — kit change is safe across all consumers"
else
  echo "✗ fleet gate FAILED — fix the above before shipping the kit change"
fi
exit $fail
