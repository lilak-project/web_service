#!/usr/bin/env bash
# Consistent backup of the portal data root.
#
# The deploy docs' plain `rsync` of a LIVE data tree can copy a SQLite DB and its
# `-wal` sidecar at different instants → a torn, sometimes unopenable restore. This
# snapshots every *.db with `sqlite3 .backup` (safe to run against a DB that's in
# use) and rsyncs everything else (uploads, outputs, manifests). Runtime `.port`/
# `.pid` and the WAL/SHM sidecars are skipped — the .backup already captures a
# consistent DB.
#
#   ./backup.sh /path/to/backup           # PORTAL_DATA_ROOT or ../data by default
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DATA="${PORTAL_DATA_ROOT:-$(cd "$HERE/.." && pwd)/data}"
DEST="${1:?usage: backup.sh <dest-dir>}"

[ -d "$DATA" ] || { echo "✗ data root not found: $DATA" >&2; exit 1; }
mkdir -p "$DEST"
echo "▶ data: $DATA"
echo "▶ dest: $DEST"

# 1) Everything EXCEPT the DBs and volatile files. --delete keeps the mirror tight;
#    excluded files are protected on the receiving side, so the DB snapshots written
#    in step 2 are never removed.
rsync -a --delete \
  --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' \
  --exclude='.port' --exclude='.pid' \
  "$DATA/" "$DEST/"

# 2) Each SQLite DB → a consistent snapshot. `.backup` copies a transactionally
#    consistent image even while writers are active (unlike cp of a live file).
have_sqlite=0; command -v sqlite3 >/dev/null && have_sqlite=1
fail=0
while IFS= read -r db; do
  rel="${db#"$DATA"/}"
  out="$DEST/$rel"
  mkdir -p "$(dirname "$out")"
  if [ "$have_sqlite" = 1 ]; then
    if ! sqlite3 "$db" ".backup '$out'" 2>/dev/null; then
      echo "⚠ sqlite .backup failed for $rel — falling back to cp" >&2
      cp "$db" "$out" || fail=1
    fi
  else
    cp "$db" "$out" || fail=1     # sqlite3 missing → best-effort copy (less safe live)
  fi
done < <(find "$DATA" -name '*.db' -type f)

[ "$have_sqlite" = 1 ] || echo "⚠ sqlite3 not installed — DBs copied, not snapshotted" >&2
if [ "$fail" = 0 ]; then echo "✓ backup complete → $DEST"; else echo "✗ backup finished with errors" >&2; fi
exit $fail
