#!/usr/bin/env bash
# Build everything the LILAK Web Portal needs, in one go — for moving to another
# server. The three source repos stay SEPARATE; this just builds them together.
#
#   service_manager (this repo) : the portal — runs it + serves its built frontend
#   lilak_elog                  : the elog service — backend the portal spawns + built frontend
#   lilak_ui                    : the shared UI kit — source, aliased by BOTH frontends
#
# Override locations via env: LILAK_UI_DIR, LILAK_ELOG_DIR, PORTAL_VENV.
set -euo pipefail

PORTAL=$(cd "$(dirname "$0")" && pwd)
STACK=$(dirname "$PORTAL")                       # the 3 repos sit side by side here
UI=${LILAK_UI_DIR:-$STACK/lilak_ui}
ELOG=${LILAK_ELOG_DIR:-$STACK/lilak_elog}
VENV=${PORTAL_VENV:-$PORTAL/.venv}

echo "▶ portal : $PORTAL"
echo "▶ elog   : $ELOG"
echo "▶ ui     : $UI"
echo "▶ venv   : $VENV"

for d in "$UI" "$ELOG"; do
  [ -d "$d" ] || { echo "✗ missing: $d  (set LILAK_UI_DIR / LILAK_ELOG_DIR)" >&2; exit 1; }
done

# 1) Shared Python venv — has BOTH portal and elog deps, because the portal
#    SPAWNS the elog backend with its own interpreter.
echo "── venv + python deps ──"
[ -d "$VENV" ] || python3 -m venv "$VENV"
"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q -r "$PORTAL/requirements.txt"
[ -f "$ELOG/requirements.txt" ] && "$VENV/bin/pip" install -q -r "$ELOG/requirements.txt"
# Shared portal-SSO package (HS256 verify + identity + introspect) that every
# managed service imports as `lilak_portal_auth` instead of pasting its own copy.
[ -d "$STACK/lilak_portal_auth" ] && "$VENV/bin/pip" install -q -e "$STACK/lilak_portal_auth"

# 2) Frontends — both alias the kit at $UI (passed via LILAK_UI_PATH). Built dists
#    are served by the portal (its own) and by the elog backend (elog's own).
build_front () {  # <frontend-dir>
  echo "── frontend: $1 ──"
  ( cd "$1" && LILAK_UI_PATH="$UI" npm install --no-audit --no-fund \
            && LILAK_UI_PATH="$UI" npm run build )
}
build_front "$ELOG/frontend"
build_front "$PORTAL/frontend"
# Other registered managed services that ship a frontend (built to their dist/).
[ -d "$STACK/asset_manager" ] && build_front "$STACK/asset_manager"
# Submodule services with a <name>/frontend (nptoy, lilak_gui, …). A dirty
# one that fails to build shouldn't abort the whole run, so don't `set -e` these.
for svc in nptoy lilak_gui; do
  [ -f "$STACK/$svc/frontend/package.json" ] || continue
  ( build_front "$STACK/$svc/frontend" ) || echo "⚠ $svc frontend build failed (skipped)"
done

echo
echo "✓ build complete."
echo "  start the portal:  PORTAL_PYTHON=$VENV/bin/python LILAK_ELOG_DIR=$ELOG $PORTAL/run.sh"
echo "  (the elog service manifest's start.cwd must point at $ELOG/backend on this host)"
