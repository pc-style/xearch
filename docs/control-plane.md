# Application control plane

Convex owns identity, jobs, dashboard stats, and the _receipt_ of indexer
publication updates. The indexer, corpus, and ranked search stay on the
search side ([indexer operations](search-indexer.md),
[publication contract](publication-contract.md),
[integration contract](integration-contract.md)).

This page is the developer/operator map for the control-plane work on
`adam/known-open-issues`. It does not replace those contracts.

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

`accountHandles` is append-only (`firstSeenAt` / `lastSeenAt`, cap 50
handles per account) so "who held `@x` when" is answerable from data.

**Pitfall:** `jobs.start` still looks an account up by handle to reuse a
pinned `expectedUserId`. An ambiguous handle (two identities) is treated as
unresolved rather than guessed.

## Jobs, dismissal, and live search

Only `kind: "bulk"` is an account-history import (`ACCOUNT_JOB_KIND`). Live
search, a single post, profile, followers, following, and archive stay out
of the account library ("Other imports" on the dashboard).

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

`from:theo`, `@Theo`, and `theo` (with an author filter) used to store three
different `jobs.input` strings and each slipped past the already-active
guard. `canonicalQuery` in `convex/lib/search.ts` stores `@handle rest`
with a lowercased handle. `from:handle` is a real author filter — it is the
spelling the app's own "Find on X" button generates.

Existing rows keep their old strings; the feed may show both spellings
until they age out. Searches stay under 300 characters; other `operator:`
forms are still rejected.

## Dashboard stats

Indexed posts, indexed people, and the queue are **owner-scoped**: only
accounts this signed-in person has imported. They used to scan every
`accountPublications` row, so a user with no imports still read someone
else's totals.

Both totals are built from the same bounded account-job set as
`library.rows` (`ownedAccountJobs`, cap 500 newest bulk jobs). The
"Indexed people" tile is the length of the list it links to.

**Bounded reads are not complete counts.** Past the cap the library sets
`truncated: true` and the overview reports `unknown` rather than a partial
total as if it were the whole corpus. Queue counts similarly report
unknown when the owner's recent 1,000 jobs are not their full history.

Account **history** is a targeted ownership lookup (`ownerJobsForAccount`,
scan cap 20,000 / 1,000 matching runs), not a slice of that library page.
Stopping early is **not** "Account not found" — that message is only
returned after the owner's imports were actually exhausted. Hitting a
bound returns "Could not check this account against your imports…".

Counts:

- Indexed posts = sum of `accountPublications.searchablePostCount` only.
- A `Count` is `{ kind: "known", unit, value }` or `{ kind: "unknown", unit }`.
  Zero means "looked and found nothing"; unknown means "did not finish
  looking / upstream never said". They never collapse into each other.

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
variable. The Connections modal (`src/App.tsx` `receiverConnection`) says
so. Env-var rows say **Configured**; the download worker says **Connected**
because its readiness is a heartbeat.

Liveness is **not** `Date.now() - lastSeen` inside a Convex query. A query
re-runs when a document it read changes, never because time passed, so that
check froze at the last write and kept a dead worker looking live.

Instead:

1. `worker.heartbeat` writes `collector.online` and schedules
   `worker.expire` 45 seconds later.
2. `expire` flips `online` to false if no newer heartbeat arrived — a real
   write, so `integrations.configured` re-runs.
3. `lastSeenAt` is disclosed only to a signed-in caller. Signed-out
   bootstrap gets the public `handoff` flag and must not treat a missing
   timestamp as "down".

`src/integrationStatus.ts` `WORKER_LIVE_WINDOW_MS` (45s) is the client-side
freshness window for the timestamp. `jobs.start` also refuses outbound
imports when `worker.online` is false or `lastSeen` is older than 45s.

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

| File                                         | What it proves                                                                                  |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `tests/account-identity.test.ts`             | Reassignment forks; rename stays one row; library does not throw on a duplicated handle         |
| `tests/job-feed.test.ts`                     | Dismiss/restore; live-search canonicalisation; filters apply before the page limit              |
| `tests/provider-limits-writepath.test.ts`    | Real 429 body reaches the panel; absent allowance is unknown; stale `jobs.error` is not current |
| `tests/ownership-lookup.test.ts`             | History is not "not found" just because the library page is full                                |
| `tests/worker-liveness.test.ts`              | Expiry-driven `online`; timestamp withheld when signed out                                      |
| `tests/connections-ui.test.ts`               | Outbound mode labels the download worker, not capture env vars                                  |
| `search/crates/indexer/tests/publication.rs` | Sender envelope, generation spend, owed-update replay                                           |
