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
| `search-indexer` | Drop-dir watcher, per-user retry registry (`users.json`), publication sender to Convex |
| `search-api`     | Loopback HTTP: bearer `/search`, HMAC `/ticket-search`, signed cursors |
| `xearch-search`  | The binary: `import`, `query`, `serve`, `watch`, `users`, `publish`    |

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
  },
  "publications": {
    "hero": {
      "generation": 3,
      "lastUniquePostCount": 42,
      "lastPublishedAtMs": 1789826880797,
      "transportRetryPending": false
      // when an update is owed, this is true and a "pending" object holds
      // that exact update; imports that stood down behind it leave their
      // captureIds in a "deferred" object — see "Publishing to Convex" below
    }
  }
}
```

`publications` is new (see "Publishing to Convex" below) and absent from any
`users.json` written before that feature existed; it loads as an empty map
either way, so an old registry file is never quarantined for lacking it.

Status machine, applied by every pass:

| Situation                                   | Result                                                                                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| New file seen                               | record starts `incomplete`                                                                                                                   |
| Import accepts ≥1 post                      | `complete` with receipt facts                                                                                                                |
| Import accepts 0 posts (or all quarantined) | `error` — "No posts accepted; N quarantined"                                                                                                 |
| Import fails (malformed/IO)                 | `error` with reason, attempts+1                                                                                                              |
| `error`/`incomplete` user                   | retried on every subsequent pass                                                                                                             |
| `complete` user, unchanged bytes            | skipped (content-hash signature)                                                                                                             |
| File bytes changed                          | reimported even if `complete`                                                                                                                |
| Two files map to one handle                 | the second file is skipped with a warning while the recorded file exists; removing or renaming the recorded file lets the survivor take over |
| Index empty but registry non-empty          | recorded users and capture batches are reimported (index reset recovery, logged loudly)                                                      |
| Registry file corrupt or unreadable         | quarantined as `users.json.bad-<unix-ms>` and recreated empty; ingestion continues                                                           |

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
  lock releases on Ctrl-C/SIGTERM. `users mark` and `publish` take the same
  lock for their short sections: each fails when a watcher runs, and a
  watcher starting at the same instant waits rather than losing the change.
  Without that, a watcher pass could save a registry it loaded before a
  manual `publish` and put the generation watermark back — the receiver
  ignores any update that reuses a generation it has already committed.
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
filename order. Re-dropping an _older_ per-user dump after a newer one is
last-writer-wins (upserts replace by tweet ID), so re-import the newest file
if a restore ever moves backwards.

## Publishing to Convex (`/publication/update`)

The indexer can tell the app when an account's posts are actually
searchable, closing the loop described in `docs/publication-contract.md`.
This is what makes `accountPublications`, the dashboard's "Indexed
posts"/"Indexed people", and an account's "waiting for indexing" state ever
move past zero — before this, nothing called that route at all.

**Disabled by default.** Set both env vars to turn it on; either being
absent leaves `run_once` behaving exactly as it always has:

| Env var | Meaning |
| --- | --- |
| `PUBLICATION_UPDATE_URL` | Full URL of Convex's `POST /publication/update` route. Must be `https://`; plain `http://` is accepted only for a loopback host (see below). |
| `PUBLICATION_SERVICE_TOKEN` | Bearer token; falls back to `DATA_SERVICE_TOKEN` if unset (same convention as `convex/publication.ts`). |

**`http://` to anything but loopback is refused, not sent to.** Every update
carries the token in an `Authorization: Bearer` header, so a cleartext
endpoint would put a live credential on the wire. The sender checks this
where the configuration is built — before any request exists — and an
endpoint it refuses disables publication with a log line naming the
variable and the host:

```
indexer publish: disabled. PUBLICATION_UPDATE_URL points at http:// host
"example.com", which would send PUBLICATION_SERVICE_TOKEN over the network in
cleartext. Use https://, or a loopback host (127.0.0.1, ::1, localhost) for a
local test endpoint.
```

Plain `http://` to `127.0.0.1`, `::1` or `localhost` keeps working, because
those bytes never leave the machine — that is what this crate's own tests
point at. A hostname that merely *resolves* to loopback is not accepted;
what DNS answers is not something the sender can rely on.

**Under systemd these go in exactly one file:
`~/xearch-data/search/publication.env`, mode `0600`.** That is the path
`deploy/systemd/xearch-search-indexer.service` loads
(`EnvironmentFile=-%h/xearch-data/search/publication.env`), and the leading
`-` means a missing file is not an error: the service starts anyway and
publication simply stays disabled. Putting the file anywhere else — under
`~/xearch-search` with the index and registry, for instance — looks like a
working setup and silently publishes nothing.

```sh
install -d -m 700 ~/xearch-data/search
touch ~/xearch-data/search/publication.env     # never truncates an existing file
chmod 600 ~/xearch-data/search/publication.env
# then edit it; one KEY=value per line, no quotes, no `export`:
#   PUBLICATION_UPDATE_URL=https://<deployment>.convex.site/publication/update
#   PUBLICATION_SERVICE_TOKEN=<the service token>
systemctl --user restart xearch-search-indexer.service
```

The file holds a live bearer token. Keep it at mode `0600`, keep it outside
any checkout, never commit it or paste it into an issue or a PR, and never
write the token itself into this repository. Confirm which end the indexer
picked up without ever reading the file back: the watcher logs
`publish=enabled` or `publish=disabled` on startup.

```sh
journalctl --user -u xearch-search-indexer.service | grep 'indexer resolved'
```

When enabled, every import attempt (per-user dump or capture batch) is
followed by one publish attempt for that handle:

- **On success**, `search_tantivy::Engine::count_author` is reloaded and
  counted fresh — the live, deduplicated document count for that author —
  and sent as `reportedState: "searchable"` with `uniquePostCount` and
  `uniquePostCountAsOf`. This is the only count used; the registry's own
  `accepted`/`rejected` fields (per-last-import-only, not deduplicated) are
  never sent, per `docs/publication-contract.md` "What unique means".
- **On failure**, `reportedState: "failed"` is sent with the import's
  verbatim error message and no count at all — never a guessed or stale
  number.
- A capture batch also carries `captureIds: [<sha>]`, and `providerAccountId`
  / `runId` when the capture's own payload carries a `profile` record or a
  post's `author.id`, and a top-level `runId`, respectively (extending the
  existing capture-handle walker rather than adding a second one). A
  per-handle `<handle>.json` dump has none of these — the contract's own
  words are "no runId/captureId/profile id; send handle-only" — so it sends
  only `handle`.
- A publish problem of any kind — transport failure or an outright
  rejection — is only ever logged and recorded in `publications.<handle>`;
  it never fails or rolls back the import. The posts are already in the
  index; publication is just reporting that fact.
- `generation` is a durable, monotonically increasing per-account counter
  (`publications.<handle>.generation` in `users.json`) that only advances
  when an HTTP response — of any status — was actually received. A
  transport failure (no response at all) leaves it untouched, sets
  `transportRetryPending: true`, and stores the update itself under
  `publications.<handle>.pending`: reported state, `captureIds`, `runId`,
  `providerAccountId`, the count with its as-of stamp, any error text, and
  the original `observedAt`. A later pass resends *those* fields at that
  same reserved generation, so the body — and therefore the
  `Idempotency-Key` — is identical to the attempt that never got an answer.
  Storing the update rather than just the fact of one is what makes the
  resend honest: `captureIds` is what marks captures confirmed on the
  Convex side, and one handle can have several capture batches and a
  per-handle dump in the drop directory at once, so an update rebuilt from
  whichever file the pass reaches first would confirm captures that update
  never processed (or, for a dump, confirm none at all).
- Retry dispatch is per publication record, not per candidate file, and
  runs at the top of a pass before any import: an outage costs at most one
  resend attempt per affected account per pass, and content that has not
  changed is never imported, archived or indexed again to carry a resend.
- While an update is owed, a later import for the same account does not
  publish its own update. The reserved generation belongs to the owed
  update, and `docs/publication-contract.md` ("Idempotency and staleness")
  is explicit that a generation resent with different content is a
  sender-side bug. So the import stands down — but it does not vanish:
  what it would have reported (`captureIds`, `runId`,
  `providerAccountId`, its state) is kept against the account under
  `publications.<handle>.deferred`, and several stood-down imports
  coalesce into one entry there.
- As soon as the owed update is answered, that deferred entry goes out as
  a **follow-on update** at the next generation, in the same pass. It is
  a new update, not a replay: `uniquePostCount` is recounted live and
  `observedAt` is fresh. What it carries from the registry is the
  identity — so it names the captures it confirms rather than going out
  handle-only. Once delivered, the entry is cleared and never sent again;
  this is not a retry loop.
- That matters because an import that stands down is already recorded:
  the importer skips its file on every later pass, so no future import
  will ever carry its capture id. Dropping it would leave a capture in
  the index that Convex is never told about — searchable in the engine,
  invisible in the product, permanently. A capture imported during an
  outage is confirmed by the follow-on update, not left waiting for the
  account to import something new.
- If a later import for the account does publish before the follow-on
  went out (which only happens if the follow-on's post count failed), it
  folds the deferred capture ids into its own update. Its own state wins;
  the ids accumulate. Either way a deferred capture id is confirmed by
  the first update that actually goes out after it.
- A permanent rejection (401/422/400) still advances the generation (a
  request *was* delivered) but is not retried automatically — that would
  spin on identical content, which `AGENTS.md` rules out.
- A `users.json` written by a build that stored only
  `transportRetryPending` (no `pending` object) still loads, but nothing is
  invented for it: the flag is cleared with a log line saying so, and the
  account reports again on its next import, at the generation that was
  never spent.
- A `users.json` written by a build that had no `deferred` entry loads the
  same way: the key is simply absent, which reads as nothing deferred. So
  does one written before `publications` existed at all. Neither is
  quarantined.

**Transport and verification.** Delivery goes over
[`ureq`](https://docs.rs/ureq) with its `rustls` TLS backend
(`search/Cargo.toml`'s `ureq = { features = ["rustls"] }`), so both
`http://` (accepted only for the loopback endpoints this crate's own tests
use, `search/crates/indexer/tests/publication.rs` and
`search/crates/indexer/src/publish/transport.rs`) and `https://` work. This
has been confirmed end to end against the real production deployment's
HTTP-actions host — **`https://utmost-kudu-321.convex.site`, not
`.convex.cloud`** — through this exact sender code, sending only a
deliberately nonexistent handle so nothing could ever apply:

- Correct token, nonexistent handle → HTTP 422
  `{"outcome":"rejected_invalid","rejectionReason":"No known account
  matches this update's providerAccountId/handle."}`
- Deliberately wrong bearer token, same handle → HTTP 401
  `{"outcome":"rejected_unauthorized"}`

That proves TLS, auth, envelope shape, routing, and the receiver's own
contract logic all work over the real network path, with zero state
mutated (no account was ever resolved, so nothing was written to
`accountPublications`). See this repository's task history for the exact
probe; no token or other secret is written anywhere in this repository or
logged by this sender.

Inspect or replay this by hand:

```sh
# See generation/count/error per account alongside the usual ingestion state
xearch-search --base-dir "$BASE" users list
# Republish one handle's current live count without reimporting anything.
# Any update still owed for that handle is resent first, exactly as it was
# built, followed by anything imports stood down behind it; if the endpoint
# is still down, the fresh send stands down rather than reusing that
# update's generation.
# Takes the indexer lock, so stop the watcher first if one is running.
xearch-search --base-dir "$BASE" publish <handle>
```

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
| `query <q> [--sort …] [--stats]`                       | prints version-1 response JSON; `--stats` adds timings    |
| `serve [--listen 127.0.0.1:4320]`                      | needs `SEARCH_LOCAL_SIGNING_KEY` + `SEARCH_SERVICE_TOKEN` |
| `watch [--archive --drop-dir --state-dir --poll-secs]` | background indexer; resolves and logs its dirs at startup |
| `users list [--status …]` / `users mark …`             | registry ops; `list` now also shows each account's publication state |
| `publish <handle>`                                     | republish one handle's current live count by hand (sends any owed update first, unchanged, then anything deferred behind it); needs `PUBLICATION_UPDATE_URL` + `PUBLICATION_SERVICE_TOKEN`/`DATA_SERVICE_TOKEN` |

## Serving the app contract

`serve` exposes `/health` (open), `/search` (bearer) and `/ticket-search`
(HMAC ticket, 60 s max TTL) on loopback. Send `includeStats: true` when
backend/API timings are needed; ordinary responses omit the stats object.
Continuing cursors are
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
