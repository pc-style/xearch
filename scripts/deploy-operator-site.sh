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

cd "$REPO"
VITE_XEARCH_OPERATOR=1 \
VITE_CONVEX_URL="$CONVEX_URL" \
VITE_CONVEX_SITE_URL="$CONVEX_SITE_URL" \
  bunx vite build --outDir dist-operator --emptyOutDir

grep -rqF "Dependency health" dist-operator/assets || {
  echo "deploy-operator-site: built tree has no dashboard in it — refusing to publish." >&2
  exit 1
}

rm -rf "$ROOT/dist.staging"
mkdir -p "$ROOT"
cp -r dist-operator "$ROOT/dist.staging"
rm -rf "$ROOT/dist.previous"
[ -d "$ROOT/dist" ] && mv "$ROOT/dist" "$ROOT/dist.previous"
mv "$ROOT/dist.staging" "$ROOT/dist"

echo "deploy-operator-site: published to $ROOT/dist against $CONVEX_URL"
echo "deploy-operator-site: https://$(hostname).exe.xyz:8080/"
