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

# Publish as a dated release directory and move a symlink onto it. nginx
# resolves `root dist` per request, so the swap is one rename and there is no
# instant where the document root is missing — two renames would leave
# `try_files $uri =404` serving 404s in between, and a failure between them
# would leave the site down with nothing restored.
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$ROOT/releases"
rm -rf "$ROOT/releases/$STAMP"
cp -r dist-operator "$ROOT/releases/$STAMP"

# One-time migration off the plain directory this used to publish into. Only
# reachable on the first run after this script changed shape.
if [ -d "$ROOT/dist" ] && [ ! -L "$ROOT/dist" ]; then
  mv "$ROOT/dist" "$ROOT/releases/legacy-$STAMP"
fi

PREVIOUS="$(readlink "$ROOT/dist" 2>/dev/null || true)"
ln -sfn "releases/$STAMP" "$ROOT/dist.incoming"
mv -T "$ROOT/dist.incoming" "$ROOT/dist"

# Keep the three newest releases; the rest are rollback material nobody wants.
(cd "$ROOT/releases" && ls -1d */ 2>/dev/null | sort -r | tail -n +4 | xargs -r rm -rf)

echo "deploy-operator-site: published $STAMP against $CONVEX_URL"
[ -n "$PREVIOUS" ] && echo "deploy-operator-site: roll back with  ln -sfn '$PREVIOUS' '$ROOT/dist.incoming' && mv -T '$ROOT/dist.incoming' '$ROOT/dist'"
echo "deploy-operator-site: https://$(hostname).exe.xyz:8080/"
