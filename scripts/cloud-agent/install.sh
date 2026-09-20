#!/usr/bin/env bash
# Cloud Agent install: bootstrap a self-contained local development environment.
#
# Runs after the repository is checked out. Idempotent: safe to re-run and safe
# to run against cached state or a partially prepared machine. It installs the
# Bun toolchain, project dependencies, and configures the isolated anonymous
# Convex deployment used for local development (docs/development.md).
#
# It must NOT start long-running servers; those belong in the environment's
# terminals. The one-time Convex bootstrap here starts the local backend only
# transiently so its deployment, keys, and downloaded binary are captured in the
# environment snapshot, then stops it before returning.
set -euo pipefail
cd "$(dirname "$0")/../.."

log() { printf '[cloud-agent install] %s\n' "$*"; }

# 1. Bun toolchain (the repository pins Bun via bun.lock).
if ! command -v bun >/dev/null 2>&1; then
  log "Installing Bun"
  curl -fsSL https://bun.sh/install | bash
fi
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"
log "Bun $(bun --version)"

# 2. Project dependencies (runs the pinned `prepare` Oxlint/tsgolint patch).
log "Installing dependencies (bun install --frozen-lockfile)"
bun install --frozen-lockfile

# 3. One-time bootstrap of the isolated anonymous Convex deployment.
#    Best-effort: dependency install and static checks must not depend on it, so
#    a network/egress failure here degrades to "app not pre-configured" rather
#    than failing the whole environment build.
has_env_var() {
  # `convex env get` exits 0 even when a variable is missing, so match the
  # `NAME=` line from `convex env list` instead.
  bunx convex env list 2>/dev/null | grep -q "^$1="
}

bootstrap_convex() {
  local log_file; log_file="$(mktemp /tmp/convex-bootstrap.XXXXXX.log)"
  local pgid=""

  if ! curl -sf http://127.0.0.1:3210/version >/dev/null 2>&1; then
    log "Starting local Convex backend (transient bootstrap)"
    # setsid puts the backend in its own process group so the whole tree
    # (CLI + convex-local-backend) can be signalled together afterwards.
    setsid env CONVEX_AGENT_MODE=anonymous bun run backend >"$log_file" 2>&1 &
    pgid=$!
  fi

  # Wait for the local backend to accept connections.
  local up=""
  for _ in $(seq 1 90); do
    if curl -sf http://127.0.0.1:3210/version >/dev/null 2>&1; then up=1; break; fi
    sleep 1
  done
  if [ -z "$up" ]; then
    log "WARN: local Convex backend did not come up; skipping app bootstrap"
    [ -n "$pgid" ] && kill -TERM -"$pgid" 2>/dev/null || true
    rm -f "$log_file"
    return 0
  fi

  # The Firecrawl component refuses to push unless the variable exists; an empty
  # value keeps Firecrawl disabled while every other feature runs.
  if ! has_env_var FIRECRAWL_API_KEY; then
    bunx convex env set FIRECRAWL_API_KEY '' >/dev/null 2>&1 || true
  fi

  # Backend auth signing keys for local guest/email sessions (values not printed).
  if ! has_env_var JWKS; then
    log "Generating local auth keys"
    node scripts/setup-auth.mjs --local || log "WARN: auth key setup failed"
  fi

  # Wait for the first successful push so _generated + components are ready.
  for _ in $(seq 1 90); do
    grep -q "Convex functions ready" "$log_file" 2>/dev/null && break
    sleep 1
  done

  # Stop the transient bootstrap backend; its deployment state persists on disk.
  # A running server must not survive install: the per-boot terminals start their
  # own backend and would otherwise hit "port 3210 already in use".
  if [ -n "$pgid" ]; then
    kill -TERM -"$pgid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      curl -sf http://127.0.0.1:3210/version >/dev/null 2>&1 || break
      sleep 1
    done
  fi
  rm -f "$log_file"
  log "Local Convex deployment bootstrapped"
}

if ! bootstrap_convex; then
  log "WARN: Convex bootstrap did not complete; run 'bun run backend' manually"
fi

log "Done"
