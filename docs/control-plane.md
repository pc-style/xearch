# Application control plane

Convex owns identity, jobs, dashboard stats, and the _receipt_ of indexer
publication updates. The indexer, corpus, and ranked search stay on the
search side ([indexer operations](search-indexer.md),
[publication contract](publication-contract.md),
[integration contract](integration-contract.md)).

This page is the developer/operator map for the control-plane behaviour that
is on `main` today. It does not replace those contracts.

## Account identity

**A provider account id is the identity. A handle is not.**

On X a handle can be released and claimed by someone else. Resolving or
patching `accounts` by handle alone splices one person's posts onto another
person's row. Every write and read now goes through
`convex/lib/accounts.ts`:

| Situation                                              | Result                                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Known `userId`                                         | Canonical row = oldest `accounts` row with that id (`by_user_id`.first(); Convex already orders by `_creationTime`) |
| Same `userId`, new handle                              | Rename: patch that row, append `accountHandles`                                                                     |
| Unknown `userId` on a handle another row already holds | Reassignment: **insert a new row**. Nothing merges                                                                  |
| Handle lookup, exactly one row                         | Fallback only when no provider id is known                                                                          |
| Handle lookup, two rows                                | Unresolved (`null`). Never pick one. `.unique()` is not used — it throws                                            |

Two `accounts` rows can share one handle. That is deliberate: we do not
invent a new handle for the previous holder just to keep `by_handle`
unique. Convex has no unique indexes, so the rule lives in this module
rather than the schema.

`jobs.finish` → `upsertAccount` is the only path that creates an account
row. A publication update that cannot resolve to an existing account is
rejected (`422 rejected_invalid`), never used to invent one.

`accountHandles` is never pruned (`recordHandle` in `convex/jobs.ts` inserts
a new row with `firstSeenAt`/`lastSeenAt`, or touches `lastSeenAt` on one it
already has, reading up to 50 rows per account) so "who held `@x` when" is
answerable from data.

**Pitfall:** `jobs.start` still looks an account up by handle to reuse a
pinned `expectedUserId`. An ambiguous handle (two identities) is treated as
unresolved rather than guessed.

## Jobs, dismissal, and live search

Only `kind: "bulk"` is an account-history import (`ACCOUNT_JOB_KIND`). Live
search, a single post, profile, followers, following, and archive stay out
of the account library ("Other imports" on the dashboard).

`jobs.list`, `jobs.cancel`, `jobs.retry`, `jobs.dismiss`, and `jobs.restore`
require authentication but not ownership: any signed-in caller can see and
act on any job, since imports are shared infrastructure. `job.owner` still
records who started the run.

### Clearing finished runs

`jobs.dismiss` / `jobs.restore` (`src/Dashboard.tsx` "Clear from list" /
"Bring back"):

- Hides a **terminal** run from the feeds and from `failedRetryable`.
- Deletes nothing. The job document and its `receipts` stay.
- Does **not** reduce `savedCapturesAwaitingIndexing` — those captures are
  still stored and still unconfirmed.
- Refuses queued/running work. Stop first, then dismiss. Hiding a run that
  is still spending provider allowance would leave no way to stop it.

`jobs.list` applies kind and dismissed filters **while scanning**, then
stops at 20 rows (scan bound 2,000). Filtering after a fixed page used to
hide older eligible rows behind twenty newer ones of the wrong sort.

### Live-search spelling

`from:theo`, `from:@theo`, `@Theo` and `@theo` are one author filter
(`parseQuery` in `convex/lib/search.ts`) but used to store different
`jobs.input` strings, and each slipped past the already-active guard, which
matches on the stored string. `canonicalQuery` in the same file stores
`@handle rest` with a lowercased handle. `from:handle` is a real author
filter, not an unsupported operator — it is the spelling the app's own
"Find on X" button generates (`src/ResultsSection.tsx`).

Existing rows keep their old strings; the feed may show both spellings
until they age out. Searches stay under 300 characters; other `operator:`
forms are still rejected.

## Dashboard stats

Indexed posts, indexed people, and the queue are **shared, not
owner-scoped**: every signed-in caller reads the same totals across every
owner's jobs. The imported corpus is shared infrastructure, not personal
data — `jobs.owner` still records who started each run (an audit trail) but
is no longer a visibility boundary. `convex/summary.ts` reports
`scope: { kind: "global" }` accordingly. (Saved searches, bookmarks,
sessions, and email deliveries remain per-owner and are unaffected.)

Both totals are built from the same bounded account-job set as
`library.rows` (`allAccountJobs`, cap 500 newest bulk jobs across every
owner). The "Indexed people" tile is the length of the list it links to.

**Bounded reads are not complete counts.** Past the cap the library sets
`truncated: true` and the overview reports `unknown` rather than a partial
total as if it were the whole corpus. Queue counts similarly report
unknown when the deployment's recent 1,000 jobs are not its full history.

Account **history** is a targeted lookup (`jobsForAccount` in
`convex/lib/accounts.ts`, scan cap 20,000 jobs / 1,000 matching runs across
every owner), not a slice of that library page. It returns the runs it
found plus `exhausted`, and `library.history` checks `exhausted` **before**
it looks at what was found — not only when nothing was:

- Incomplete scan → `ConvexError("Could not read this account's full
  history — there are too many imports to search in one request.")`,
  whatever it collected. The scan walks the index's `_creationTime` order
  while history is presented newest-by-`updatedAt`, so a run it never
  reached can belong in the fifty rows (`MAX_HISTORY_JOBS`) it would
  return. Handing those back would present a partial scan as the account's
  history — the same lie as presenting a partial count as a total.
- Completed scan, nothing found → `ConvexError("Account not found.")`.

Counts:

- Indexed posts = sum of `accountPublications.searchablePostCount` only.
- A `Count` is `{ kind: "known", unit, value }` or `{ kind: "unknown", unit }`.
  Zero means "looked and found nothing"; unknown means "did not finish
  looking / upstream never said". They never collapse into each other.
- `savedCapturesAwaitingIndexing` counts receipts (across every owner's bulk
  jobs) that no publication update has confirmed. `confirmedCaptureIds`
  (`convex/summary.ts`) treats an update as confirming its `captureIds`
  only when it was `applied` **and** its `reportedState` is not `"failed"`.
  An applied `failed` update says the indexer could **not** index those
  captures; counting them as confirmed made a capture that failed to index
  disappear from the one number meant to show outstanding work.

### Acquisition runs to completion on its own

There is no "Continue remaining history", "Get next page", or manual retry
button anywhere: typing a handle indexes everything obtainable for it.
`convex/jobs.ts` `finish` requeues the **same** job when the provider says
there is more — bulk history via `nextUntil` (an ever-older time window),
every other kind via `nextCursor` — and backs off and requeues a transient
failure on its own (`30s * 2^pageAttempt`, capped at 15 minutes, up to 10
attempts before it becomes a `partial`/`failed` a person can retry).
`readyAt` is set whenever a job will run again on its own, and the UI reads
it to say "retrying automatically" rather than offering a button that does
nothing until then. A repeated identical cursor, or a `nextUntil` that does
not move the window forward, is treated as a stall and paused rather than
looped on forever.

`pendingWork` from the indexer is stored but has no dashboard field yet.

## Provider limits

The Provider limits panel reads `providerThrottleEvents` only. It never
reads `jobs.error` (that column can hold a stale "Paused at today's import
limit" string from a removed application cap).

Writes:

| Path                                                          | When it runs                                                            |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `convex/importer.ts`                                          | Local/receiver mode: Convex talks to x.md                               |
| `scripts/production-worker.ts` → `worker.report` `"throttle"` | Production: `COLLECTOR_MODE=outbound`, the VM worker is the only caller |

Recording is best-effort: a failed throttle write must not strand the job
in `running` until the ten-minute expiry. A throttle report with no payload
is rejected so a sender cannot believe an empty report landed.

A response counts as throttling only when it is a **refusal that says so**:
HTTP 429, a usable `Retry-After`, or a problem body whose `code`/`type`
names a rate limit. x.md sends `RateLimit-*` headers on successes and
ordinary 404s too; those headers enrich a fact that already qualified, they
do not qualify it. Otherwise the first mistyped handle would fill the panel
forever.

`{ kind: "none" }` means **nothing observed**, never "not throttled".
Facts are captured on error responses only, so remaining allowance on a
successful call is invisible. Absent remaining/reset stay absent (dashboard
says "unknown", never 0). Nothing reads these rows to decide whether to
make a request — this is not a usage budget.

## Connections and worker liveness

`COLLECTOR_MODE` changes what "stores imported posts" means:

| Mode                    | Meaning                                    | What to set                                                                |
| ----------------------- | ------------------------------------------ | -------------------------------------------------------------------------- |
| `receiver` (local)      | Env var: `RAW_CAPTURE_URL` is set          | `RAW_CAPTURE_URL`, `RAW_CAPTURE_TOKEN`                                     |
| `outbound` (production) | Live heartbeat from the VM download worker | Nothing on Convex. The worker reads capture credentials on **its** machine |

Setting `RAW_CAPTURE_URL` on the production Convex deployment does not
connect a receiver: `convex/importer.ts` returns before reading either
variable. The Connections modal says so: `receiverConnection` and the
`Connection` row type live in `src/integrationStatus.ts` and are rendered by
`src/App.tsx`. Env-var rows say **Configured**; the download worker says
**Connected** because its readiness is a heartbeat.

Liveness is **not** `Date.now() - lastSeen` inside a Convex query. A query
re-runs when a document it read changes, never because time passed, so that
check froze at the last write and kept a dead worker looking live.

Instead:

1. `worker.heartbeat` writes `collector.online` and schedules
   `worker.expire` 45 seconds later.
2. `expire` flips `online` to false if no newer heartbeat arrived — a real
   write, so `integrations.configured` re-runs.
3. `lastSeenAt` is disclosed only to a signed-in caller — `configured` is
   part of the public bootstrap, and worker timing is not public. Signed-out
   bootstrap gets the `handoff` flag and no timestamp, and an **absent**
   timestamp means "not disclosed", which is not the claim "down"
   (`handoffReady` returns `undefined` for it, `false` only for an explicit
   `null`). Nothing in the test suite asserts the signed-out case today; it
   is enforced in `convex/integrations.ts` alone.

`src/integrationStatus.ts` `WORKER_LIVE_WINDOW_MS` (45s) is the client-side
freshness window, and `handoffReady` there is what turns a timestamp into
live/not-live against the caller's own clock.

`jobs.start` **does** read the clock — `!worker?.online || Date.now() -
worker.lastSeen > 45_000` — and that is not the same mistake. It is a
mutation, evaluated once at the instant someone asks to start an import, so
there is no cached result to go stale. The rule is about queries: a query
result is pushed reactively and only re-computed when a document it read
changes, so a query may not decide liveness from `Date.now()`.

The dashboard sidebar Connections list is a compact checklist; it shows
"Checking…" while `integrations.configured` is in flight rather than
asserting "Not connected".

## Publication loop

```
x.md → capture receiver → indexer (Tantivy) → POST /publication/update →
accountPublications → dashboard "Indexed posts/people"
```

Without the sender, every account sat at "waiting for indexing" forever.
The sender is in this repo (`search/crates/indexer/src/publish.rs`), off
unless both `PUBLICATION_UPDATE_URL` and a token are set. systemd loads
them from `~/xearch-data/search/publication.env` (mode 0600). See
[indexer operations](search-indexer.md).

**A cleartext endpoint is refused, not sent to.** Every update carries the
token in an `Authorization: Bearer` header, so `PublishConfig::new` rejects
any `http://` URL whose host is not loopback — before a configuration, let
alone a request, exists. `https://` is always accepted; plain `http://` to
`127.0.0.1`, `::1` or `localhost` stays accepted because those bytes never
leave the machine, which is what the crate's own tests point at. A name
that merely _resolves_ to loopback is not accepted. An operator who
misconfigures this gets publication disabled and one log line naming the
variable and the host — never the token:

```
indexer publish: disabled. PUBLICATION_UPDATE_URL points at http:// host
"example.com", which would send PUBLICATION_SERVICE_TOKEN over the network in
cleartext. Use https://, or a loopback host (127.0.0.1, ::1, localhost) for a
local test endpoint.
```

**An outage no longer loses what an import reported.** A send that never
got a response does not spend its generation: the update itself is stored
(`publications.<handle>.pending` in `users.json`) and replayed byte for
byte until some response arrives. While that is owed, a later import for
the same account must not publish at the same generation, so it stands
down — but what it _would_ have reported (`captureIds`, `runId`,
`providerAccountId`, its state) is retained against the account under
`publications.<handle>.deferred`, and several stood-down imports coalesce
into one entry. As soon as the owed update is answered, that entry goes out
as a follow-on update at the next generation, recounted and freshly
stamped, naming the real capture ids. This matters because the importer
skips an already-recorded capture on every later pass: dropped ids would
leave that capture indexed and invisible in the product forever. Mechanics:
[indexer operations](search-indexer.md) "Publishing to Convex".

Verified against production over TLS, mutating no state: unknown handle →
HTTP 422 `rejected_invalid`; wrong bearer → HTTP 401
`rejected_unauthorized`. No real account has been published yet, so the
product journey import → searchable is reachable in code and unproven
end-to-end.

## Import size

Bulk JSON requests `max_posts=5000` (x.md's documented ceiling),
`concurrency=8`. The old 500 clamp was this app's. A page that does not
fit in one 4 MB capture is split by measured serialized bytes; receivers
must concatenate `part.index` 0..`of-1`. Details:
[integration contract](integration-contract.md) "Split history pages".

Only provider-reported limits should pause acquisition. This app has no
daily import budget.

## Tests that lock the rules

| File                                         | What it proves                                                                                                                                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/account-identity.test.ts`             | Reassignment forks; rename stays one row; library does not throw on a duplicated handle                                                                                                             |
| `tests/job-feed.test.ts`                     | Dismiss/restore; a dismissed run's captures still count as awaiting indexing; live-search canonicalisation                                                                                          |
| `tests/provider-limits-writepath.test.ts`    | Real 429 body reaches the panel; absent allowance is unknown; stale `jobs.error` is not current                                                                                                     |
| `tests/ownership-lookup.test.ts`             | `ownerJobsForAccount` collects every run for one account and reports whether the scan finished                                                                                                      |
| `tests/review-fixes.test.ts`                 | Filters apply before the page limit; history opens past the library page but is refused when the scan was incomplete; an applied `failed` update confirms no captures; bounded reads report unknown |
| `tests/worker-liveness.test.ts`              | Liveness is decided client-side: it goes stale with no new write, and a timestamp that was not disclosed is not "down"                                                                              |
| `tests/convex.test.ts`                       | An offline worker makes `integrations.configured` report `handoff: false` and `jobs.start` refuse                                                                                                   |
| `tests/connections-ui.test.ts`               | Outbound mode labels the download worker, not capture env vars                                                                                                                                      |
| `search/crates/indexer/tests/publication.rs` | Sender envelope, generation spend, owed-update replay, stood-down capture ids folded into a follow-on, and a non-loopback `http://` endpoint refused before any request is built                    |
