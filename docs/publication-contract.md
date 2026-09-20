# Publication contract

Status: this is the contract adam sends Pronsh to agree on the sender/indexer side.
The receiving side below is now implemented and tested against a local convex-test
deployment only, ahead of that agreement — not because agreement stopped mattering,
but because the app-side receiver, dashboard queries, and their tests do not require
Pronsh's sender to exist. `convex/schema.ts` has the tables, `convex/lib/contracts.ts`
has the validators and TypeScript types, `convex/publication.ts` plus the
`POST /publication/update` route in `convex/http.ts` are the receiver, and
`convex/summary.ts` / `convex/library.ts` / `convex/limits.ts` are the dashboard
queries built on them (`tests/publication.test.ts`, `tests/summary.test.ts`,
`tests/library.test.ts`, `tests/limits.test.ts`,
`tests/scenario-publication-lifecycle.test.ts`, `tests/queued-posts.test.ts`).
Service-health writers now exist separately (`convex/health.ts`
`POST /service/health`, the search probe cron, and the production worker's
receiver forward; `tests/service-health.test.ts`) — that is liveness, not
publication. No real indexer has ever called `/publication/update`, the URL
has not been shared with Pronsh, and nothing in "Open assumptions" below has
been confirmed — to-do.md P0 ("Agree the summary/publication contract with
the collaborator before parallel implementation") is still unchecked. None of
this changes the existing raw-capture or search contracts in
`docs/integration-contract.md`.

Scope: this covers the boundary between "a raw capture has been durably received" and
"an account's posts are confirmed searchable." It does not implement, and does not ask
Pronsh to implement, anything about how the indexer discovers or processes captures —
watcher, registry, retry loop, ranking, or cursor signing all stay entirely on that side.
It also does not touch the existing raw-capture receiver or search-query contracts;
see `docs/integration-contract.md` for those.

## The one thing to agree first

**Publication updates must carry the provider account id, not just the handle.**
Per the collaborator-dependency reader's findings, the indexer's registry is keyed by
normalized handle (`<handle>.json`), the same shape PR #13 uses. If a publication
update can only ever carry `handle`, this contract's whole point — resolving identity
by a stable provider id so a handle reassignment can't merge two different accounts —
cannot be honored on our end no matter what we build. The provider account id (x.md's
numeric id) is already visible to the indexer inside each capture's embedded `profile`
object (see `docs/integration-contract.md`'s raw-capture envelope), so we are assuming
it can thread that id through to the publication update even though its own registry
does not key by it. If that turns out to be false, say so and we'll rework identity
resolution before either side writes code against this document.

## Account identity

- Identity is keyed on the provider account id (x.md's numeric account id). Convex
  stores this today as `accounts.userId` (a pre-existing field; not renamed here) and
  now also indexes it directly (`accounts.by_user_id`) so identity lookups do not have
  to go through the handle.
- The normalized handle (`accounts.handle`) is a fallback lookup only, used when a
  provider id is not yet known (for example, the very first profile fetch for a brand
  new account has not completed). Once a provider id is on record for an account, a
  publication update — or any other write — must never use a handle match to overwrite
  a different account's identity.
- `accountHandles` records every handle an account has ever been known by
  (`accountId`, `handle`, `firstSeenAt`, `lastSeenAt`). When the same provider id keeps
  its existing account row and simply renames, this is an ordinary update: patch
  `accounts.handle` and add a row here. When a handle used to resolve to one provider
  id and a fresh capture now shows a _different_ provider id under the same handle,
  that is a reassignment, not a rename: the existing account row (and its publication
  state and search history) must be left alone, and a new account row is created for
  the new identity. Nothing merges. This resolution logic is not implemented anywhere
  yet; this document fixes the rule so whoever implements it does not have to re-derive
  it, and so it matches what a publication update is allowed to assert.
- This app does not create an account row purely from a publication update. Accounts
  are created only from our own acquisition flow (`jobs.finish`, unchanged by this
  document). A publication update that cannot resolve to an existing account is
  rejected (`outcome: "rejected_invalid"`, logged, not applied) rather than used to
  invent one.

## Publication states

Five states, held on the new `accountPublications` table (one row per account),
`state: "downloaded" | "waiting_for_indexing" | "indexing" | "searchable" | "failed"`:

| State                  | Who asserts it                           | Meaning                                                                                                                                                                 |
| ---------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `downloaded`           | This app, from its own acquisition facts | At least one raw-capture receipt exists for this account and no publication update has ever arrived for it.                                                             |
| `waiting_for_indexing` | This app                                 | The capture is available for the indexer to pick up; no publication update has arrived yet. In practice this follows `downloaded` immediately — see "Assumption" below. |
| `indexing`             | The indexer, via a publication update    | The indexer has started processing and is telling us so before it has a result.                                                                                         |
| `searchable`           | The indexer, via a publication update    | A confirmed commit: the reported `uniquePostCount` posts for this account are live in the index and queryable now.                                                      |
| `failed`               | The indexer, via a publication update    | Publication failed for this account. Acquisition may have succeeded; only the indexing/publication step failed.                                                         |

A publication update itself can only ever assert `reportedState: "indexing" |
"searchable" | "failed"` (`reportedPublicationStateValidator` in `convex/schema.ts`).
This app assigns `downloaded` and `waiting_for_indexing` on its own from the acquisition
side; the indexer is never asked to distinguish them, since it cannot see the raw
capture before it has picked it up.

**Assumption:** we collapse `downloaded` and `waiting_for_indexing` into effectively
the same instant — the moment our own acquisition side records a durable receipt, we
consider the capture both downloaded and waiting for indexing, since we cannot
independently confirm the indexer has "picked it up" versus merely "could." If Pronsh's
indexer can report a real pickup/start event, that would let `indexing` start earlier
and more accurately; until then it starts only once a `reportedState: "indexing"`
update actually arrives.

## The non-regression guarantee

**A failed refresh must never erase a previously searchable account's visible state.**
This is why `accountPublications` splits "what's happening right now" from "the last
confirmed good snapshot" into fields that a failed update is never allowed to touch:

- `state` and `lastError` track the latest attempt and can regress to `failed`.
- `committedGeneration` advances on **every** accepted update, whatever its
  `reportedState`. It is the idempotency watermark, not a success marker: if an
  accepted `"indexing"` or `"failed"` update left it behind, a resend of that same
  generation would be applied a second time instead of recognised as a duplicate.
- `searchablePostCount`, `searchablePostCountAsOf`, and `lastPublishedAt` are written
  **only** when an accepted update's `reportedState` is `"searchable"`. A later
  `"failed"` or `"indexing"` update changes `state`, `lastError` and the watermark,
  and nothing else on this row.

So: an account that was searchable with 4,000 posts, whose next refresh fails, keeps
showing 4,000 searchable posts and a `lastPublishedAt` from the earlier success, with
`state: "failed"` and `lastError` describing the new failure alongside it. The account
library row (`convex/lib/contracts.ts` `AccountLibraryRow`) is built to expose exactly
this: `publicationState` can be `"failed"` while `searchablePostCount` still reports
the last good number instead of flipping to unknown or zero.

## The envelope

`publicationUpdateEnvelope` (`convex/lib/contracts.ts`), built from
`publicationUpdateFields` (`convex/schema.ts`) plus a version tag:

| Field                 | Type                                                       | Required                                | Meaning                                                                                                                                                                                                                                                    |
| --------------------- | ---------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`             | `1`                                                        | yes                                     | For future evolution of this envelope.                                                                                                                                                                                                                     |
| `providerAccountId`   | string                                                     | no                                      | The provider (x.md) numeric account id. Send this whenever the indexer can determine it — see "The one thing to agree first" above.                                                                                                                        |
| `handle`              | string                                                     | yes                                     | Normalized handle, always sent, used as the fallback identity lookup.                                                                                                                                                                                      |
| `runId`               | string                                                     | no                                      | The Convex `jobs._id` (as a string) of the acquisition run this update reflects, when it traces to one run. Same `runId` already used in the raw-capture envelope (`docs/integration-contract.md`).                                                        |
| `captureIds`          | string[]                                                   | yes (may be empty)                      | The content-addressed capture ids (same id space as `Capture`/`Receipt.captureId` in `convex/lib/handoff.ts`) this update confirms were processed.                                                                                                         |
| `generation`          | number                                                     | yes                                     | Monotonic per account, assigned by the sender. See "Idempotency and staleness" below — every ordering and dedup rule in this contract pivots on this one number.                                                                                           |
| `reportedState`       | `"indexing" \| "searchable" \| "failed"`                   | yes                                     | See "Publication states" above.                                                                                                                                                                                                                            |
| `uniquePostCount`     | number                                                     | no                                      | Unique, currently-searchable post count for this account as of this update. See "What unique means" below. Send it on a `searchable` update; omit rather than guess on `indexing`/`failed`.                                                                |
| `uniquePostCountAsOf` | number (epoch ms)                                          | no                                      | When the indexer computed `uniquePostCount`. Required whenever `uniquePostCount` is present.                                                                                                                                                               |
| `pendingWork`         | `{ unit: "jobs" \| "captures" \| "posts", count: number }` | no                                      | Outstanding work for this account in the unit that is natural to report. Omit when unknown — never send a guessed count. Sticky on apply; dashboard aggregates per unit (see "Dashboard-facing shapes"). The current Rust sender does not emit this field. |
| `error`               | `{ message: string, code?: string }`                       | required when `reportedState: "failed"` | The indexer's own reason. Verbatim, not reworded by us.                                                                                                                                                                                                    |
| `observedAt`          | number (epoch ms)                                          | yes                                     | When the indexer observed/computed this update. Distinct from `receivedAt`, which this app assigns on acceptance.                                                                                                                                          |

Fields not listed here (an account-level "generation" the indexer wants to track that
isn't a publication concern, ranking internals, per-post detail) do not belong in this
envelope; this is a summary/state contract, not a corpus sync channel.

## What "unique" means

`uniquePostCount` is the count of distinct posts for this account that are live in the
committed search index, deduplicated across every capture and every acquisition run
ever ingested for that account — not:

- **Not** `jobs.count` — a running total of accepted raw records per capture batch,
  unbounded and not deduplicated across retries or overlapping page ranges.
- **Not** `jobs.postsReceived` — a per-page download counter (bulk/JSON kind only),
  capped at 500 per page, reset in ways that track acquisition, not the index.
- **Not** the Rust indexer's own registry `accepted`/`rejected` fields — per the
  collaborator-dependency reader's findings, those count records accepted by the _last
  successful import only_, overwritten every pass, not a running or unique-lifetime
  total, and not deduplicated across captures.
- **Not** a count of files, receipts, or jobs. A count of files is not a count of posts.

`accountPublications.searchablePostCount` exists specifically so nothing else in this
codebase can be mistaken for it: it is written only from an accepted `searchable`
update's `uniquePostCount`, never derived from any acquisition-side counter.

## Idempotency and staleness

Ordering and deduplication are entirely generation-based, per account:

- Incoming `generation` **less than** the stored `accountPublications.committedGeneration`
  → **stale**. Reject without applying; log to `publicationUpdates` with
  `outcome: "stale_ignored"`. This is what makes an out-of-order delivery (a slow
  retry of an old update arriving after a newer one already landed) harmless.
- Incoming `generation` **equal to** the stored value → **duplicate**. Treat as an
  idempotent replay: do not reapply, log with `outcome: "duplicate_ignored"`, and
  return the same acceptance response as the original. This holds even if the resent
  payload's other fields differ from what is on record — a generation number must
  never be reused for two different pieces of content; if the log shows a duplicate
  generation with different content, that is a sender-side bug to raise, not something
  the receiver reinterprets.
- Incoming `generation` **greater than** the stored value → **apply**. Set `state` to
  `reportedState`; set `committedGeneration` to the incoming `generation`; on
  `"searchable"`, additionally set `searchablePostCount`, `searchablePostCountAsOf`,
  and `lastPublishedAt`; on `"failed"`, additionally set `lastError` — and nothing else.
  Log with `outcome: "applied"`.

Two more layers, matching the existing raw-capture handoff's own conventions
(`docs/integration-contract.md`):

- **Transport-level idempotency:** the HTTP delivery should carry an `Idempotency-Key`
  header (a hash of the exact request body, same pattern as the capture receiver) so a
  lost response and a retried send with identical bytes cannot double-apply before the
  generation check even runs.
- **Every publication update is logged**, accepted or not, to `publicationUpdates`
  (`accountId` when resolved, `handle`, `generation`, `outcome`, and — when rejected —
  `rejectionReason`). This is what makes "duplicate updates are idempotent" and "stale
  updates cannot regress displayed state" checkable from evidence instead of merely
  asserted.

Authentication failures are rejected at the transport layer (401) before any of the
above runs; whether to also log the attempt is an implementation choice for whoever
builds the receiver, not fixed by this document.

## Delivery

- **Direction:** push. The indexer calls an authenticated Convex HTTP endpoint,
  mirroring the existing raw-capture handoff's push model
  (`RAW_CAPTURE_URL`/`RAW_CAPTURE_TOKEN` in `docs/integration-contract.md`), rather
  than Convex polling the indexer for status. **Assumption, still unconfirmed** — if
  Pronsh's side can only support us polling, the envelope shape above is unaffected
  but this section needs to flip.
- **Auth:** implemented in `convex/publication.ts` as `publicationServiceToken()` — a
  local, narrower copy of the `serviceToken` capability pattern in
  `convex/lib/serviceAuth.ts` (which isolates `"search"` and `"capture"` and never
  falls one back to the other): reads `PUBLICATION_SERVICE_TOKEN`, falling back to
  `DATA_SERVICE_TOKEN` only, the same legacy-fallback convention the other two use.
  `convex/lib/serviceAuth.ts` itself is unchanged — this capability was deliberately
  kept as a local copy in `convex/publication.ts` rather than folded in there (see
  that file's own header comment).
- **The route exists.** `convex/http.ts` registers `POST /publication/update`
  (`convex/publication.ts`'s `receiveUpdate`), built against
  `publicationUpdateEnvelope` exactly as specified above. It has only ever been
  called by `t.fetch(...)` in `tests/publication.test.ts` and `tests/
scenario-publication-lifecycle.test.ts`, against an in-memory convex-test
  deployment; no real indexer has called it and the URL has not been given to
  Pronsh.
- **Response:** implemented as `{ outcome, committedGeneration?, rejectionReason? }`
  — HTTP 200 for `applied`/`stale_ignored`/`duplicate_ignored`, 422 for
  `rejected_invalid`, 401 for `rejected_unauthorized` — so the sender can tell a
  genuine acceptance from a stale/duplicate no-op or a rejection. The 200/401 cases
  and the underlying `rejected_invalid`/`applied`/etc. outcomes are exercised by
  `tests/publication.test.ts` (its HTTP-transport tests cover 401/400/200; the 422
  mapping itself is only reached through `applyUpdate`'s direct mutation tests, not
  a `t.fetch` call asserting status 422). Not yet confirmed with Pronsh.

## Provider throttle facts

`providerThrottleEvents` (`convex/schema.ts`) is a new, append-only table for
provider-reported throttling, one row per observation, attached to the job/attempt and
operation that observed it (`jobId`, `attempt`, `provider`, `operation`, `reason`,
`remaining`, `resetAt`, `retryAfterMs`, `observedAt`). It exists specifically to be
distinguishable from `jobs.error`, which is free text and can hold stale historical
messages — for example, a pre-PR#12 "Paused at today's import limit" string left on an
old job row is indistinguishable from a live message in that column alone. The
dashboard should read the most recent row (by `observedAt`) for a given `provider` as
"the current limit," never a `jobs.error` string.

`remaining` and `resetAt` are populated **only when the provider actually supplied
them** in its response. If x.md (or the receiver, or the search service) returns a 429
with a `Retry-After` header but no remaining-allowance figure, `remaining` stays unset
— the dashboard must say "unknown," never estimate or default to a number. This
directly matches to-do.md: "If remaining allowance is unavailable, say so."

This table only records observations; nothing in this task adds the code that writes
to it (that is acquisition-side implementation, out of scope here).

## Worker/indexer/service health

`serviceHealth` (`convex/schema.ts`) is one row per external dependency
(`service: "indexer" | "receiver" | "search"`), holding observed facts:
`healthy`, `observedAt`, `lastHeartbeatAt`, `lastSuccessAt`, and `lastError`.
This exists because `integrations.configured` answers only "is an env var set".
The dashboard Dependency health panel (`convex/summary.ts` `health`, rendered by
`src/library/OverviewStats.tsx`) reads these rows and never derives liveness
from configuration. A service that has never reported stays
`{ kind: "unknown" }` ("No health report received yet") — nothing is seeded at
deploy time. Readings older than five minutes (`SERVICE_STALE_AFTER_MS`) are
`stale: true` and must not render as a fresh Healthy.

Three writers, none of which invent a row from configuration:

| Service    | Writer                                                                                                                      | Observation                                                 |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `indexer`  | Pronsh's watcher, once per poll pass (`search/crates/indexer/src/health.rs` via `POST /service/health` in `convex/http.ts`) | the pass completed, or failed with its verbatim error       |
| `search`   | Convex cron every 2 minutes (`convex/crons.ts` → `health.probeSearch`)                                                      | `GET <SEARCH_API_URL origin>/health` answered the body `ok` |
| `receiver` | production download worker on every poll (`scripts/production-worker.ts` → `worker:poll`)                                   | `http://127.0.0.1:4319/health` answered                     |

Auth for the HTTP report route is `SERVICE_HEALTH_TOKEN` with a legacy fallback
to `DATA_SERVICE_TOKEN`, isolated from search/capture/publication credentials.
Missing token configuration fails closed (401). Unhealthy reports without
`error.message` are 400; extra keys are 400. `lastSuccessAt` moves only on an
observed success and is never cleared by a later failure; `lastError` keeps the
last real failure text through a later success.

Indexer heartbeats and the worker's receiver report are side observations: a
heartbeat failure never fails an import pass, and a failed health write never
fails a worker poll or moves a job. One-shot `import`/`publish` CLI commands
do not heartbeat; only `watch` (`run_pass`) does. The local `bun run capture`
receiver answers `/health` but does not forward it to Convex. Search is not
probed if `SEARCH_API_URL` is unset (stays unknown, not unhealthy).

x.md itself is not tracked here — it is a per-call third-party dependency,
covered by `providerThrottleEvents`. Production token/setup and the "not yet
observed on the live deployment" caveat live in `docs/production.md`.

## Dashboard-facing shapes

Three more shapes exist purely as query/mutation return types (not stored tables):
`dashboardSummaryValidator`, `accountLibraryRowValidator`, and `queueBreakdownValidator`
in `convex/lib/contracts.ts`. Every count in all three is a `Count` — `{ kind: "known",
unit, value }` or `{ kind: "unknown", unit }`, where `unit` is `"jobs" | "captures" |
"posts" | "accounts"` — so a query can never collapse "I don't know" into 0, and no
consumer can read a bare number without also knowing what it counts. See the field
comments in `convex/lib/contracts.ts` for exactly what each count means and how it is
scoped; this document does not repeat them to avoid the two drifting apart.

`queueBreakdownValidator` is work **this app can see**: waiting/active download
jobs, failed/partial jobs a person can retry, and saved captures awaiting
indexing. `dashboardSummaryValidator.providerQueuedWork` is **not** a fifth
queue bucket. It is the indexer's own `pendingWork` for the caller's accounts,
one `Count` per unit (`posts` / `captures` / `jobs`) so a file count is never
labelled as posts. A unit is known only when at least one in-scope account
reported that unit; silence is unknown, a reported 0 is known 0
(`tests/queued-posts.test.ts`). `pendingWork` is sticky on apply: a later
update that omits the field leaves the stored value (same rule as `lastError`
in `convex/publication.ts`). `src/library/OverviewStats.tsx` renders those
three tiles separately and never adds them together. The current Rust sender
does not emit `pendingWork`, so the tiles stay unknown until it does.

`queueBreakdownValidator.savedCapturesAwaitingIndexing` (unit `"captures"`) is the one
bucket without a stored counter behind it: `convex/summary.ts`'s
`computeSavedCapturesAwaitingIndexing` derives it exactly as guided here — receipts
whose `captureId` has not appeared in any accepted `publicationUpdates.captureIds` for
that account, deduped per account across all of an owner's bulk jobs (`tests/
summary.test.ts`). If that join proves too expensive at real production scale, a
denormalized per-capture status table is a reasonable future addition — not built,
since the join has not been measured against real volume yet.

## Explicitly out of scope here

- Any indexer, watcher, registry, retry loop, ranking, or cursor-signing
  implementation — Pronsh's side, per to-do.md ownership rules.
- The raw-capture receiver and search-query contracts in
  `docs/integration-contract.md` — unchanged by this document.
- Single-use nonce/replay protection for `/ticket-search` tickets — a search-query
  concern the collaborator-dependency reader flagged as deferred to "the integration
  layer," separate from publication updates. Still open; not addressed here.
- Authorized/scoped collection access (to-do.md P1) — `summaryScopeValidator` reserves
  a shape for it (`{ kind: "account", accountId }`) but nothing computes or enforces it
  yet; only `{ kind: "global" }` is meaningful today.
- Confirming any "Open assumption" below with Pronsh, and anything on the
  sender/indexer side that would actually call `POST /publication/update` — the
  receiver, schema, and dashboard queries are implemented and tested against
  convex-test only (see "Status" above); a real indexer has never called this route.

## Open assumptions, listed together

For a reviewer checking this against the collaborator-dependency reader's findings:

1. **Identity:** the indexer will thread the provider account id through to publication
   updates even though its own registry keys by handle. Unconfirmed — see "The one
   thing to agree first."
2. **Unique count:** the indexer will compute and report a per-account deduplicated
   live-document count (`uniquePostCount`). This does not exist in the registry today
   (`accepted`/`rejected` are per-last-import-attempt only); treat it as a build item on
   Pronsh's side, not an existing capability being wired up.
3. **Delivery direction:** push (indexer calls us), not poll (we call the indexer).
4. **State granularity:** handle collisions and index-reset recovery surface to us as
   ordinary publication updates (a `failed` state with a descriptive error, or a fresh
   `searchable` update at a new generation) rather than needing a distinct event shape.
5. **`downloaded` vs. `waiting_for_indexing`:** treated as effectively simultaneous on
   our side until the indexer can report a real pickup/start event.

## For implementers: what to import

- `convex/schema.ts`: `publicationStateValidator`, `reportedPublicationStateValidator`,
  `pendingWorkUnitValidator`, `countUnitValidator`, `throttleProviderValidator`,
  `serviceValidator`, `publicationUpdateOutcomeValidator`, `publicationUpdateFields`,
  `jobStatusValidator`, plus the new tables `accountHandles`, `accountPublications`,
  `publicationUpdates`, `providerThrottleEvents`, `serviceHealth`, and the new
  `accounts.by_user_id` index.
- `convex/lib/contracts.ts`: `publicationUpdateEnvelope` (+ `PublicationUpdateEnvelope`),
  `countValidator` (+ `Count`), `summaryScopeValidator` (+ `SummaryScope`),
  `queueBreakdownValidator` (+ `QueueBreakdown`),
  `providerQueuedWorkValidator` (+ `ProviderQueuedWork`),
  `dashboardSummaryValidator` (+ `DashboardSummary`), `nextActionValidator`
  (+ `NextAction`), `accountLibraryRowValidator` (+ `AccountLibraryRow`), and
  the convenience aliases `PublicationState`, `ReportedPublicationState`,
  `JobStatus`.
