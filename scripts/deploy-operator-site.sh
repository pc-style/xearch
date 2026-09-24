#!/usr/bin/env bash
# Build the operator site and publish it to the nginx root on this VM.
#
# This is the private half of the deployment: the dashboard and Connections
# panel, pointed at the production Convex deployment, served on :8080 behind
# the exe.dev proxy's login. The public half — the client-facing search app,
# with none of this in it — is what `bun run deploy:prod` sends to Convex
# static hosting.
#
# nginx serves whatever is on disk, so publishing is a directory swap and
# needs no restart. The swap is done through a staging directory and `mv` so
# a request can never land on a half-copied tree.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${XEARCH_HOSTING_ROOT:-$HOME/xearch-data/hosting}"
CONVEX_URL="${XEARCH_PROD_CONVEX_URL:-https://utmost-kudu-321.convex.cloud}"
CONVEX_SITE_URL="${XEARCH_PROD_CONVEX_SITE_URL:-https://utmost-kudu-321.convex.site}"
OPERATOR_ENV_FILE="${XEARCH_OPERATOR_ENV_FILE:-$HOME/xearch-data/operator.env}"

cd "$REPO"

# The build-time token that lets the operator build skip email sign-in
# entirely (src/operatorToken.ts, convex/access.ts `requireOperator`): the
# operator site is already restricted to exe.dev accounts with VM access, so
# being on it is the operator proof. Sourced the same way the indexer unit
# reads publication.env (deploy/systemd/xearch-search-indexer.service) — a
# plain KEY=VALUE file, never committed, never echoed. There is no email
# sign-in UI any more, so a build without the token publishes a dashboard
# whose every gated action fails: refuse instead, the same way a build with
# no dashboard is refused below.
if [ -f "$OPERATOR_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$OPERATOR_ENV_FILE"
  set +a
fi

if [ -z "${VITE_OPERATOR_TOKEN:-}" ]; then
  echo "deploy-operator-site: no VITE_OPERATOR_TOKEN in $OPERATOR_ENV_FILE — refusing to publish an operator site whose gated actions cannot work." >&2
  exit 1
fi

# A wrong or unreachable endpoint publishes an operator site that loads and
# then cannot talk to anything, which looks like a backend outage rather than
# a bad deploy. Cheaper to refuse here.
case "$CONVEX_URL" in
  https://*) ;;
  *)
    echo "deploy-operator-site: XEARCH_PROD_CONVEX_URL must be an https URL, got '$CONVEX_URL'." >&2
    exit 1
    ;;
esac

# One publication at a time, and the lock is taken before the build, not
# after: every run builds into the same dist-operator, so two of them would
# otherwise have one emptying that directory while the other copied out of it.
mkdir -p "$ROOT/releases"
exec 9>"$ROOT/.publish.lock"
flock 9

# `bun run build:operator`, not a bare `vite build`: the repository's operator
# build runs `tsc --noEmit` first, and Vite will happily emit a tree that does
# not typecheck.
VITE_XEARCH_OPERATOR=1 \
VITE_CONVEX_URL="$CONVEX_URL" \
VITE_CONVEX_SITE_URL="$CONVEX_SITE_URL" \
VITE_OPERATOR_TOKEN="${VITE_OPERATOR_TOKEN:-}" \
  bash scripts/with-posthog-build-env.sh bun run build:operator

grep -rqF "Needs attention" dist-operator/assets || {
  echo "deploy-operator-site: built tree has no dashboard in it — refusing to publish." >&2
  exit 1
}

# Publish as a dated release directory and move a symlink onto it. nginx
# resolves `root dist` per request, so the swap is one rename and there is no
# instant where the document root is missing — two renames would leave
# `try_files $uri =404` serving 404s in between, and a failure between them
# would leave the site down with nothing restored.
# A name no release already has. The lock serialises publications but does
# not advance the clock, so two of them a second apart still collide — and
# clearing the colliding name would delete the tree `dist` is pointing at
# while nginx is serving out of it. Nothing here ever removes an existing
# release; `mkdir` without -p is what enforces that.
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ATTEMPT=0
while ! mkdir "$ROOT/releases/$STAMP" 2>/dev/null; do
  ATTEMPT=$((ATTEMPT + 1))
  if [ "$ATTEMPT" -gt 50 ]; then
    echo "deploy-operator-site: could not find an unused release name." >&2
    exit 1
  fi
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$ATTEMPT"
done
cp -r dist-operator/. "$ROOT/releases/$STAMP/"

# One-time migration off the plain directory this used to publish into, for
# any host still on the old layout. This is the one step that cannot be a
# single rename — a directory cannot be replaced by a symlink atomically — so
# it is the one step that gets an unwind: if anything after it fails, the
# original document root goes back where nginx expects it.
LEGACY=""
if [ -d "$ROOT/dist" ] && [ ! -L "$ROOT/dist" ]; then
  LEGACY="$ROOT/releases/legacy-$STAMP"
  trap 'if [ -n "$LEGACY" ] && [ -d "$LEGACY" ] && [ ! -e "$ROOT/dist" ]; then mv "$LEGACY" "$ROOT/dist"; fi' EXIT
  mv "$ROOT/dist" "$LEGACY"
fi

PREVIOUS="$(readlink "$ROOT/dist" 2>/dev/null || true)"
ln -sfn "releases/$STAMP" "$ROOT/dist.incoming"
mv -T "$ROOT/dist.incoming" "$ROOT/dist"
trap - EXIT

# Keep the three newest releases, and never the one `dist` points at
# whatever its age — pruning the live target would empty the site.
# Sorted by modification time, not by name: after a migration `legacy-<stamp>`
# sorts ahead of every plain timestamp and would permanently hold one of the
# three slots, leaving only two real releases to roll back to.
LIVE="$(basename "$(readlink "$ROOT/dist")")"
(
  cd "$ROOT/releases"
  ls -1dt */ 2>/dev/null | sed 's:/$::' | tail -n +4 |
    while read -r old; do
      [ "$old" = "$LIVE" ] || rm -rf -- "$old"
    done
)

echo "deploy-operator-site: published $STAMP against $CONVEX_URL"
if [ -n "$PREVIOUS" ]; then
  echo "deploy-operator-site: roll back with  ln -sfn '$PREVIOUS' '$ROOT/dist.incoming' && mv -T '$ROOT/dist.incoming' '$ROOT/dist'"
fi
echo "deploy-operator-site: https://$(hostname).exe.xyz:8080/"
