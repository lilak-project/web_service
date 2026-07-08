#!/usr/bin/env bash
# Update this checkout from GitHub and sync submodules. Does not build or restart.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE="${REMOTE:-origin}"
BRANCH="${BRANCH:-main}"

usage() {
  cat <<'EOF'
Usage: ./update.sh

Environment:
  REMOTE=origin     Git remote to fetch from.
  BRANCH=main       Branch to fast-forward to.

This script refuses to run when tracked or untracked files are present, so local
edits are not overwritten accidentally. Ignored files such as .env are fine.
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

cd "$ROOT"

if [ ! -d .git ]; then
  echo "error: $ROOT is not a git checkout" >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "error: tracked files have uncommitted changes; commit or stash before updating." >&2
  git status --short
  exit 1
fi

if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
  echo "error: untracked files are present; commit, remove, or stash before updating." >&2
  git status --short
  exit 1
fi

echo "==> Fetching $REMOTE/$BRANCH"
git fetch "$REMOTE" --recurse-submodules=no

echo "==> Fast-forwarding"
git merge --ff-only "$REMOTE/$BRANCH"

echo "==> Updating submodules"
git submodule update --init --recursive

echo "✓ updated $ROOT to $(git rev-parse --short HEAD)"
