# Search indexer: how it works

The Rust search engine lives in `search/` as a Cargo workspace (“postings”
=a Tantivy index; “search” = the served query pipeline). This document
explains the running pieces end to end. Nothing here calls a provider;
imports only read local dump files.

## Crates

| Crate            | Role                                                                   |
| ---------------- | ---------------------------------------------------------------------- |
| `search-model`   | Wire types: `Post`, `SearchRequest`/`SearchResponse`, `Sort`           |
| `search-query`   | Google-style grammar → `Expr` AST; rejects conflicting author filters  |
| `search-ranking` | Engagement + blend math used for sort keys                             |
| `search-backend` | Traits only: `SearchBackend` (search) and `IndexSink` (upsert+commit)  |
| `search-tantivy` | The index. mmap Tantivy store, cursors, five sorts                     |
| `search-ingest`  | Retain-import: archive, quarantine, receipt, idempotent upserts        |
| `search-indexer` | Drop-dir watcher + per-user retry registry (`users.json`)              |
| `search-api`     | Loopback HTTP: bearer `/search`, HMAC `/ticket-search`, signed cursors |
| `xearch-search`  | The binary: `import`, `query`, `serve`, `watch`, `users`               |

## Where postings actually live

Everything sits under one data root (`SEARCH_BASE_DIR`, default
`~/xearch-search`):

```
$BASE/index/    Tantivy mmap store:
                meta.json                  segment list + schema
                <seg>.term                 term dictionary
                <seg>.idx                  posting lists (the inverted index)
                <seg>.pos                  positions (phrase adjacency)
                <seg>.fast                 id/created/likes/engagement columns
                <seg>.fieldnorm            BM25 field lengths
                <seg>.store                post JSON bodies (source of rows)
$BASE/archive/  Content-addressed originals:
                <sha256>.json              exact retained input bytes
                <sha256>.receipt.json      {sha256, accepted, rejected}
                <sha256>.rejected.jsonl    quarantined records + reasons
$BASE/drop/     Intake: <handle>.json dumps or <sha256>.json capture batches
$BASE/state/    users.json — the per-user retry registry
```

Raw input is never mutated; re-importing the same bytes converges to the
same documents (upserts delete-then-add by tweet ID).

## The per-user state file (`state/users.json`)

Every intake account is one record, keyed by normalized handle
(lowercase, `@` stripped, `1–15` ASCII alnum/`_`):

```json
{
  "version": 1,
  "users": {
    "hero": {
      "status": "complete",
      "attempts": 1,
      "accepted": 2,
      "rejected": 0,
      "sha256": "f39540…",
      "fileSig": "f39540…", // sha256 of file bytes (== sha256 for first import)
      "fileName": "hero.json",
      "updatedAtMs": 1789826880797
    }
  },
  "captures": {
    "f39540…": {
      "handle": "hero",
      "accepted": 40,
      "rejected": 0,
      "updatedAtMs": 1789826880797
    }
  }
}
```

Status machine, applied by every pass:

| Situation | Result |
|---|---|
| New file seen | record starts `incomplete` |
| Import accepts ≥1 post | `complete` with receipt facts |
| Import accepts 0 posts (or all quarantined) | `error` — "No posts accepted; N quarantined" |
| Import fails (malformed/IO) | `error` with reason, attempts+1 |
| `error`/`incomplete` user | retried on every subsequent pass |
| `complete` user, unchanged bytes | skipped (content-hash signature) |
| File bytes changed | reimported even if `complete` |
| Two files map to one handle | the second file is skipped with a warning while the recorded file exists; removing or renaming the recorded file lets the survivor take over |
| Index empty but registry non-empty | recorded users and capture batches are reimported (index reset recovery, logged loudly) |
| Registry file corrupt or unreadable | quarantined as `users.json.bad-<unix-ms>` and recreated empty; ingestion continues |

Safety properties:

- Signatures are **content hashes**, not `size:mtime`, so same-size edits
  with restored clocks cannot be skipped silently.
- `users.json` writes are atomic (temp file + rename + fsync); a crash
  mid-save never leaves a half registry.
- Each imported file is saved with its new registry entry in the same
  pass, so a killed watcher continues where the last file completed.
- Manual `users mark incomplete` clears the signature and file binding →
  next pass reimports that file even if unchanged.
- A single-instance lock (`state/indexer.lock`, `"<pid> <kind>"`) keeps one
  watcher per data root. Holders are identity-checked by `/proc/<pid>/cmdline`
  (not just pid existence), stale locks are reclaimed atomically, and the
  lock releases on Ctrl-C/SIGTERM. `users mark` takes the same lock for its
  short section: it fails when a watcher runs, and a watcher starting at the
  same instant waits rather than losing the change.
- Stale `.tmp*` files from a SIGKILLed run are swept at startup.

## Capture batches (raw-capture receiver output)

`scripts/capture-server.mjs` writes each received capture as
`<sha256>.json` under `.local-captures/raw/`. The watcher imports that
shape directly — one batch per content hash, exactly once:

```sh
# Point the indexer's drop dir at the receiver's raw directory:
xearch-search --base-dir "$BASE" watch --drop-dir /path/to/.local-captures/raw
# or copy batches in:
cp .local-captures/raw/<sha256>.json "$BASE/drop/"
```

Each batch is a `{version, runId, source, request, records, terminal}`
envelope; posts inside `records[].payload.posts`/`payload.post` are
normalized, profile records are skipped, malformed records are quarantined.
The handle in `captures.<sha>.handle` is reporting metadata taken from the
payload. Batches accumulate: many batches for one handle all import, unlike
per-user dump files where one file is the handle's source of truth.

Capture files are read from the drop directory: keep the receiver's
`raw/` directory as the drop dir, or copy batches in. Unlike per-user
dumps, batches are content-addressed and immutable, so deleting the index
reimports every recorded batch from the still-present files (see below).

Batch semantics: each capture is imported exactly once per content hash, in
filename order. Re-dropping an *older* per-user dump after a newer one is
last-writer-wins (upserts replace by tweet ID), so re-import the newest file
if a restore ever moves backwards.

## Index corruption recovery

If the index directory is damaged the watcher keeps running but every pass
fails with a clear error. The raw inputs are safe in `$BASE/archive/<sha>.json`.
Rebuild:

```sh
systemctl --user stop xearch-search-indexer    # or: search-index-ctl.sh stop
rm -rf "$BASE/index"                            # archive + state are untouched
# re-drop the retained inputs (or leave them in drop/ and let the registry
# reimport: an empty index forces reimport of every recorded user)
scripts/search-index-ctl.sh start
```

Deleting `index/` alone is enough: on the next pass the watcher detects an
empty index with a populated registry and reimports from `drop/`.

## Retry + error operation

```sh
# What needs attention right now
xearch-search --base-dir "$BASE" users list --status error
# Force a re-import of an account
xearch-search --base-dir "$BASE" users mark <handle> incomplete
# Manual completion requires an explanatory note
xearch-search --base-dir "$BASE" users mark <handle> complete --note "verified by hand"
```

## Running it

Install for systemd (portable — the unit carries no checkout path):

```sh
scripts/search-index-ctl.sh install   # builds release, installs ~/.local/bin/xearch-search
cp deploy/systemd/xearch-search-indexer.service ~/.config/systemd/user/
mkdir -p ~/xearch-search/{index,archive,drop,state,logs}
systemctl --user daemon-reload
# then: systemctl --user start xearch-search-indexer.service  (needs operator approval)
```

The unit defaults `SEARCH_BASE_DIR` to `~/xearch-search`. Override it with a
systemd drop-in (for example, `systemctl --user edit xearch-search-indexer`)
and set `Environment=SEARCH_BASE_DIR=/absolute/path`. Indexer output goes to
the user journal; inspect it with
`journalctl --user -u xearch-search-indexer.service`.

Local/manual control (no systemd needed):

```sh
search-index-ctl.sh start | stop | restart | continue | status | logs | users …
```

`start`/`continue` are idempotent; `restart` waits for the old process to
exit before spawning the replacement (no pidfile race); a stale PID of an
unrelated process is never killed (cmdline identity check). If the systemd
unit `xearch-search-indexer.service` is installed it takes priority; the
script refuses to let a manual watcher run beside the unit.

The systemd unit runs the release binary; build it first:

```sh
cd <repo>/search && cargo build --release -p xearch-search
```

## CLI surface (`xearch-search`)

Precedence is flag > env > derived-from-`--base-dir`. All `SEARCH_*` env
names mirror the flags, so a systemd unit or shell profile can carry the
whole configuration.

| Command                                                | Flags/env                                                 |
| ------------------------------------------------------ | --------------------------------------------------------- |
| `--index`/`SEARCH_INDEX`                               | overrides `"$BASE/index"`                                 |
| `import --input --archive`                             | one-shot retained import                                  |
| `query <q> [--sort …]`                                 | prints version-1 response JSON                            |
| `serve [--listen 127.0.0.1:4320]`                      | needs `SEARCH_LOCAL_SIGNING_KEY` + `SEARCH_SERVICE_TOKEN` |
| `watch [--archive --drop-dir --state-dir --poll-secs]` | background indexer; resolves and logs its dirs at startup |
| `users list [--status …]` / `users mark …`             | registry ops                                              |

## Serving the app contract

`serve` exposes `/health` (open), `/search` (bearer) and `/ticket-search`
(HMAC ticket, 60 s max TTL) on loopback. Continuing cursors are
**HMAC-signed with the server key** before leaving the API, so page depth
and TTL can only be advanced by the server: a tampered cursor is rejected.
`/ticket-search` returns a signed receipt binding session, owner, expiry
and results. Tickets are replayable within their ≤60 s lifetime by design
(attacker value is bounded and each replay burns a search permit); a
single-use nonce requires a ticket issuer (Convex) and is intentionally
left to the integration layer.

## Operator workflow summary

1. Drop `<handle>.json` intake dumps into `$BASE/drop/`.
2. Keep `search-index-ctl.sh continue` (or the systemd unit) running.
3. Watch `users list --status error` and `search-index-ctl.sh logs`.
4. Postings grow in `$BASE/index`; the app fetches results from `serve`.
