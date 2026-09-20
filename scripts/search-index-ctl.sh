#!/usr/bin/env bash
# xearch-search control: start, stop, restart, continue, status, logs, users.
#
# Thin process wrapper around the Rust binary — all indexing logic lives in
# the search-indexer crate (crates/indexer: drop-dir poll, content-hash
# signatures, per-user complete/incomplete/error registry in state/users.json,
# idempotent content-addressed imports).
#
# Config precedence (flag > env > default, mirroring the CLI):
#   SEARCH_BIN       default: <repo>/search/target/release/xearch-search
#                    (falls back to debug and builds it) or built on demand
#   SEARCH_BASE_DIR  default: ~/xearch-search  (matches the systemd unit)
#
# Where the postings actually live under $SEARCH_BASE_DIR:
#   index/    Tantivy mmap store: meta.json + per-segment
#             .term (term dictionary), .idx (posting lists — the inverted
#             index), .pos (phrase positions), .fast (id/created/likes/
#             engagement columns), .fieldnorm, .store (post JSON bodies)
#   archive/  content-addressed raw dumps <sha256>.json + <sha256>.receipt.json
#   drop/     per-user intake files <handle>.json (watched)
#   state/    users.json registry (complete/incomplete/error per handle)
#   logs/     indexer.log
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT="xearch-search-indexer.service"

default_bin() {
  if [[ -x "$HOME/.local/bin/xearch-search" ]]; then
    echo "$HOME/.local/bin/xearch-search"
  elif [[ -x "$REPO/search/target/release/xearch-search" ]]; then
    echo "$REPO/search/target/release/xearch-search"
  else
    echo "$REPO/search/target/debug/xearch-search"
  fi
}
BIN="${SEARCH_BIN:-$(default_bin)}"
BIN_DIR="${SEARCH_BIN_DIR:-$HOME/.local/bin}"
BASE="${SEARCH_BASE_DIR:-$HOME/xearch-search}"
PIDFILE="$BASE/indexer.pid"

build() {
  local dir="debug"
  local -a profile=()
  if [[ "$BIN" == *"/release/"* ]]; then
    dir="release"
    profile=(--release)
  fi
  if [[ ! -x "$BIN" ]] || ! "$BIN" --help 2>/dev/null | grep -q "base-dir"; then
    echo "building xearch-search ($dir)..." >&2
    (cd "$REPO/search" && cargo build -q -p xearch-search "${profile[@]}")
  fi
}

# Build the release binary and install it where the systemd unit looks:
# ~/.local/bin/xearch-search. This is what makes the committed unit portable
# to a machine whose checkout lives anywhere.
do_install() {
  echo "building release..." >&2
  (cd "$REPO/search" && cargo build --release -p xearch-search)
  install -Dm755 "$REPO/search/target/release/xearch-search" "$BIN_DIR/xearch-search"
  echo "installed $BIN_DIR/xearch-search"
}

unit_active() {
  systemctl --user is-active -q "$UNIT" 2>/dev/null
}
unit_installed() {
  systemctl --user list-unit-files "$UNIT" 2>/dev/null | grep -q "$UNIT"
}

# Trust a pidfile only if it points at our own binary (guards against stale
# pids and pid reuse killing an unrelated process).
running_pid() {
  if [[ -f "$PIDFILE" ]]; then
    local pid
    pid="$(cat "$PIDFILE" 2>/dev/null)" || return 1
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
      if grep -qa "xearch-search" "/proc/$pid/cmdline" 2>/dev/null; then
        echo "$pid"
        return 0
      fi
    fi
  fi
  return 1
}

do_start() {
  mkdir -p "$BASE"/{index,archive,drop,state,logs}
  if [[ "$BASE" == "$HOME/xearch-search" ]]; then
    mkdir -p "$HOME/xearch-search"/{index,archive,drop,state,logs}
  fi
  build
  # The unit has priority, but never let a manual watcher keep running
  # beside it: two writers fight over the Tantivy lock and the registry.
  if unit_active; then
    echo "already running via systemd ($UNIT)"
    return
  fi
  if unit_installed; then
    if [[ ! -x "$HOME/.local/bin/xearch-search" ]]; then
      echo "unit needs $HOME/.local/bin/xearch-search; run: $0 install" >&2
      return 1
    fi
    if pid="$(running_pid)"; then
      echo "stopping manual watcher (pid $pid) before systemd start" >&2
      kill "$pid"; rm -f "$PIDFILE"
      for _ in 1 2 3 4; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.5
      done
    fi
    systemctl --user start "$UNIT"
    echo "started via systemd ($UNIT)"
    return
  fi
  if pid="$(running_pid)"; then
    echo "already running (pid $pid)"; return
  fi
  nohup "$BIN" --base-dir "$BASE" watch >>"$BASE/logs/indexer.log" 2>&1 &
  echo "$!" >"$PIDFILE"
  echo "started (pid $!)"
}

do_stop() {
  local stopped=0
  if unit_active; then
    systemctl --user stop "$UNIT"
    echo "stopped systemd unit"; stopped=1
  fi
  local pid
  if pid="$(running_pid)"; then
    kill "$pid"; stopped=1
  fi
  # Evict the pidfile immediately so a racing start cannot mistake the
  # dying process for a live one, then wait for the real exit.
  rm -f "$PIDFILE"
  if [[ -n "${pid:-}" ]]; then
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    echo "stopped manual watcher (pid $pid)"
  fi
  if [[ "$stopped" == 0 ]]; then
    echo "not running"
  fi
}

do_status() {
  echo "bin:  $BIN"
  echo "base: $BASE"
  if unit_installed; then systemctl --user is-active "$UNIT" || true; fi
  if pid="$(running_pid)"; then echo "pid:  $pid (running)"; else echo "pid:  not running"; fi
  echo "drop files:  $(find "$BASE/drop" -maxdepth 1 -name '*.json*' 2>/dev/null | wc -l)"
  echo "index size:  $(du -sh "$BASE/index" 2>/dev/null | cut -f1 || echo '-')"
  if [[ -x "$BIN" ]]; then
    "$BIN" --base-dir "$BASE" users list 2>/dev/null | python3 -c "
import json,sys
try: users=json.load(sys.stdin)
except Exception: users={}
from collections import Counter
c=Counter(r['status'] for r in users.values())
print('users:', dict(c) or 'none yet', 'total:', len(users))
" || echo "users: registry unreadable"
  fi
}

case "${1:-status}" in
  install) do_install ;;
  start) do_start ;;
  stop) do_stop ;;
  restart) do_stop; sleep 1; do_start ;;
  continue) do_start ;; # keep running while things move; no-op if up
  status) do_status ;;
  logs)
    if unit_installed; then
      exec journalctl --user -fu "$UNIT"
    fi
    mkdir -p "$BASE/logs"
    exec tail -f "$BASE/logs/indexer.log"
    ;;
  users) shift; build; exec "$BIN" --base-dir "$BASE" users "$@" ;;
  *) echo "usage: $0 {install|start|stop|restart|continue|status|logs|users ...}" >&2; exit 1 ;;
esac
