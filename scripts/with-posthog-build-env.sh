#!/usr/bin/env bash
set -euo pipefail

POSTHOG_BUILD_ENV_FILE="${XEARCH_POSTHOG_BUILD_ENV_FILE:-$HOME/xearch-data/posthog-build.env}"

if [ -f "$POSTHOG_BUILD_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$POSTHOG_BUILD_ENV_FILE"
  set +a
fi

if [ -n "${POSTHOG_CLI_API_KEY:-}" ]; then
  export POSTHOG_CLI_PROJECT_ID=283153
  export POSTHOG_CLI_HOST=https://eu.posthog.com
fi

exec "$@"
