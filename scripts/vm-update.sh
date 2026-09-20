#!/usr/bin/env bash
# Fast-forward the VM checkout and update already-running search services.
# Worker/capture cutover, unit changes, and cloud deployments are manual.
# Skip only successfully applied revisions unless --force is given.
set -euo pipefail
CODE=${XEARCH_CODE:-/home/exedev/xearch-worker}
DATA=${XEARCH_DATA:-/home/exedev/xearch-data}
APPLIED="$DATA/update-applied-sha"
BIN="$HOME/.local/bin/xearch-search"
umask 077
# One updater at a time: the timer and a manual run must never restart
# services underneath each other.
exec 9>"$DATA/update.lock"
if ! flock -n 9; then
  echo "another update is running; skipping"
  exit 0
fi
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin"
cd "$CODE"
before=$(git rev-parse HEAD)
git fetch -q origin main
git merge -q --ff-only origin/main
after=$(git rev-parse HEAD)
applied=""
if [ -f "$APPLIED" ]; then
  applied=$(cat "$APPLIED")
fi
if [ "$applied" = "$after" ] && [ "${1:-}" != "--force" ]; then
  echo "up to date at ${after:0:7}"
  exit 0
fi
# Compare with the last successful application, not HEAD: a failed update
# has already advanced the checkout and must still rebuild/restart on retry.
search_changed=false
if [ "${1:-}" = "--force" ] || [ -z "$applied" ] || \
   ! git diff --quiet "$applied" "$after" -- search; then
  search_changed=true
fi
bun install --frozen-lockfile
if "$search_changed"; then
  (cd search && cargo build --release --locked -p xearch-search)
  built="$CODE/search/target/release/xearch-search"
  [ -x "$built" ]
  "$built" --help | grep -q -- '--base-dir'
  "$built" watch --help >/dev/null
  "$built" serve --help >/dev/null
fi

# Retire both triggers before draining any in-flight legacy import. Never
# reinstall committed units over the operator's runtime units or drop-ins.
triggers=()
for unit in xearch-reindex.timer xearch-reindex.path; do
  state=$(systemctl --user show --property=LoadState --value "$unit")
  if [ "$state" != "not-found" ]; then
    triggers+=("$unit")
  fi
done
if [ "${#triggers[@]}" -gt 0 ]; then
  systemctl --user disable --now "${triggers[@]}"
fi
state=$(systemctl --user show --property=LoadState --value xearch-reindex.service)
if [ "$state" != "not-found" ]; then
  systemctl --user stop xearch-reindex.service
fi

if "$search_changed"; then
  mkdir -p "$(dirname "$BIN")"
  staged=$(mktemp "$BIN.XXXXXX")
  trap 'rm -f "$staged"' EXIT
  install -m 755 "$built" "$staged"
  mv -f "$staged" "$BIN"

  # try-restart cannot start an inactive service, even if it stops between
  # the state check and restart. An intentional shutdown stays shut down.
  if systemctl --user is-active -q xearch-search-indexer.service; then
    systemctl --user try-restart xearch-search-indexer.service
    systemctl --user is-active -q xearch-search-indexer.service
  fi
  if systemctl --user is-active -q xearch-search.service; then
    systemctl --user try-restart xearch-search.service
    for _ in {1..30}; do
      curl -fsS --max-time 2 http://127.0.0.1:4320/health >/dev/null 2>&1 && break
      sleep 1
    done
    curl -fsS --max-time 2 http://127.0.0.1:4320/health >/dev/null || { echo "search health failed on :4320"; exit 1; }
  fi
fi
# Atomic success marker: partial failures remain retryable without imports.
printf '%s\n' "$after" > "$APPLIED.tmp"
mv -f "$APPLIED.tmp" "$APPLIED"
echo "applied ${after:0:7} (checkout ${before:0:7} -> ${after:0:7}); worker/capture and cloud deployments untouched"
