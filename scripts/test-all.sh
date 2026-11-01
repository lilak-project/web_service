#!/bin/zsh
# Every automated check in the stack, in one go. Run before a commit/deploy:
#
#   ~/web_service/scripts/test-all.sh          # all of it
#   ~/web_service/scripts/test-all.sh --quick  # skip the frontend build
#
# Exit code is non-zero when anything fails. Nothing here touches live data:
# the backend tests use a throwaway data root.
set -u
ROOT=${0:A:h:h}
PY=$ROOT/service_manager/.venv/bin/python
fail=0
step() {
  print -P "%B── $1%b"
  shift
  if "$@"; then print -P "%F{green}   ok%f"; else print -P "%F{red}   FAILED%f"; fail=1; fi
}

# Run python from a neutral directory: from $ROOT the folder `lilak_portal_auth/`
# would shadow the installed package of the same name.
cd /tmp
step "backend imports"            $PY -c "import sys; sys.path.insert(0, '$ROOT/service_manager'); from app import main"
step "portal security tests"      $PY -W ignore $ROOT/service_manager/tests/test_security.py
step "rack store security tests"  $PY -W ignore $ROOT/lilak_rack/tests/test_store_security.py
step "rack store folder tests"    $PY -W ignore $ROOT/lilak_rack/tests/test_store_folders.py
step "rack store tag tests"       $PY -W ignore $ROOT/lilak_rack/tests/test_store_tags.py
step "project inbox tests"       $PY -W ignore $ROOT/lilak_rack/project_manager/backend/test_inbox.py
step "sync merge self-test"       $PY $ROOT/service_manager/app/sync_merge.py
step "ui kit tests (vitest)"      zsh -c "cd $ROOT/lilak_ui && npx vitest run --reporter=dot"
step "racklist tests (vitest)"    zsh -c "cd $ROOT/lilak_rack && npx vitest run --reporter=dot"
if [[ ${1:-} != --quick ]]; then
  step "portal frontend builds"   zsh -c "cd $ROOT/service_manager/frontend && LILAK_UI_PATH=$ROOT/lilak_ui npm run build --silent >/dev/null"
fi

(( fail )) && print -P "%F{red}%Bsome checks failed%b%f" || print -P "%F{green}%Ball checks passed%b%f"
exit $fail
