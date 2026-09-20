#!/usr/bin/env bash
# Explicit offline import of raw captures without receipts. Stop the watcher
# first; idempotent imports are not safe concurrent writers.
set -euo pipefail
BIN=${XEARCH_SEARCH_BIN:-/home/exedev/xearch-worker/search/target/release/xearch-search}
DATA=${XEARCH_DATA:-/home/exedev/xearch-data}
RAW="$DATA/.local-captures/raw"
INDEX="$DATA/search/index"
ARCHIVE="$DATA/search/archive"
# Fail closed if systemd is unreachable, including while the watcher is
# starting/stopping. This script must never stop the watcher on its own.
if ! state=$(systemctl --user show --property=ActiveState --value xearch-search-indexer.service); then
  echo "reindex: cannot verify watcher state; refusing imports" >&2
  exit 1
fi
case "$state" in
  inactive|failed) ;;
  *) echo "reindex: watcher is $state; stop it before importing" >&2; exit 1 ;;
esac
# search-index-ctl.sh can also run a watcher outside systemd.
if pgrep -f '(^|/)xearch-search .*watch([[:space:]]|$)' >/dev/null; then
  echo "reindex: watcher process is running; stop it before importing" >&2
  exit 1
else
  status=$?
  [ "$status" -eq 1 ] || exit "$status"
fi
mkdir -p "$INDEX" "$ARCHIVE"
imported=0
for file in "$RAW"/*.json; do
  [ -e "$file" ] || continue
  digest=$(sha256sum "$file" | cut -c1-64)
  [ -f "$ARCHIVE/$digest.receipt.json" ] && continue
  "$BIN" --index "$INDEX" import --input "$file" --archive "$ARCHIVE" >/dev/null
  imported=$((imported + 1))
done
echo "reindex: $imported new capture(s) imported"
