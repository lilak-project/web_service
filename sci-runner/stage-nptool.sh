#!/usr/bin/env bash
#
# Snapshot the LOCAL nptool_cens working tree into the sci-runner build context, so
# the container's nptool is IDENTICAL to what runs on this machine — including
# uncommitted changes AND untracked custom detectors (CSSU / Coaxial_Germanium /
# ATOMX …). The Dockerfile then COPYs this snapshot and builds nptool from it,
# instead of cloning a (stale) remote branch.
#
# Usage (from web_service/):   ./sci-runner/stage-nptool.sh
#   NPTOOL_SRC=/path/to/nptool_cens  ./sci-runner/stage-nptool.sh   # override source
#
# Output: sci-runner/nptool-src/  (git-ignored; only a build input) + a provenance
# file recording the exact commit + diff hash the image was built from.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRC="${NPTOOL_SRC:-$ROOT/nptool_cens}"
DST="$HERE/nptool-src"

[ -d "$SRC" ] || { echo "✗ nptool source not found: $SRC   (set NPTOOL_SRC=…)"; exit 1; }
command -v rsync >/dev/null || { echo "✗ rsync is required"; exit 1; }

echo "→ staging nptool   $SRC  →  $DST"
rm -rf "$DST"; mkdir -p "$DST"

# Keep the build + run source; drop VCS, prebuilt binaries (rebuilt in the image),
# and each project's heavy ROOT run-outputs (the runner only needs SOURCE files).
rsync -a \
  --exclude='.git/' \
  --exclude='*/lib/' --exclude='build/' --exclude='*/build/' \
  --exclude='CMakeFiles/' --exclude='*/CMakeFiles/' --exclude='CMakeCache.txt' --exclude='cmake_install.cmake' \
  --exclude='*.o' --exclude='*.d' --exclude='*.so' --exclude='*.dylib' --exclude='*.pcm' \
  --exclude='*.root' --exclude='__pycache__/' --exclude='.DS_Store' \
  --exclude='Outputs/' --exclude='Benchmarks/' \
  --exclude='Projects/*/root/' --exclude='Projects/*/data/' \
  --exclude='Projects/*/generated/' --exclude='Projects/*/figures/' \
  "$SRC/" "$DST/"

# Provenance — the image (and verify.sh) prove exactly what it was built from.
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
{
  echo "staged_at_utc:    $STAMP"
  echo "source_host_path: $SRC"
  echo "git_branch:       $(git -C "$SRC" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  echo "git_commit:       $(git -C "$SRC" rev-parse HEAD 2>/dev/null || echo '?')"
  echo "git_dirty_count:  $(git -C "$SRC" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  echo "git_diff_sha256:  $(git -C "$SRC" diff HEAD 2>/dev/null | shasum -a 256 2>/dev/null | cut -d' ' -f1)"
  echo "--- uncommitted + untracked (git status --porcelain) ---"
  git -C "$SRC" status --porcelain 2>/dev/null || true
} > "$DST/NPTOOL_PROVENANCE.txt"

echo "✓ staged size: $(du -sh "$DST" | cut -f1)"
echo "✓ provenance : $DST/NPTOOL_PROVENANCE.txt"
grep -E 'git_(branch|commit|dirty_count|diff_sha256)' "$DST/NPTOOL_PROVENANCE.txt" | sed 's/^/    /'
