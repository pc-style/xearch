# Publication contract

Status: this is the wire contract between the indexer and Convex. The envelope,
generation rules, and HTTP mapping below are what both sides implement.

The **receiver** is implemented (`convex/publication.ts`, `POST /publication/update`
in `convex/http.ts`) and tested against convex-test (`tests/publication.test.ts`,
`tests/scenario-publication-lifecycle.test.ts`). The **sender** now also lives in
this repository (`search/crates/indexer/src/publish.rs`); operator setup is
[search indexer](search-indexer.md) "Publishing to Convex". Identity resolution,
owner-scoped dashboard totals, and provider-throttle _writes_ that earlier drafts
left unimplemented are in the tree — see [the control plane](control-plane.md).

Pronsh has not signed off. to-do.md P0 ("Agree the summary/publication contract
with the collaborator before parallel implementation") is still unchecked. Live
proof so far is a TLS probe against production that mutated **no** state: an
unknown handle returns HTTP 422 `rejected_invalid`; a wrong bearer returns HTTP 401
`rejected_unauthorized`. No real account has been published yet. None of this
changes the raw-capture or search contracts in [the integration contract](integration-contract.md).

Scope: this covers the boundary between "a raw capture has been durably received" and
"an account's posts are confirmed searchable." Watcher, registry, retry loop, ranking,
and cursor signing stay on the indexer side. It does not touch the existing
raw-capture receiver or search-query contracts.

## The one thing to agree first

**Publication updates must carry the provider account id, not just the handle.**
The indexer's registry is still keyed by normalized handle. Capture batches already
embed x.md's numeric id in `profile` / `author.id`; the in-repo sender threads that
through when present and sends handle-only for per-handle dump files. The Convex
receiver resolves identity through `convex/lib/accounts.ts` and rejects an update
that matches no known account. If a later sender can only ever supply a handle,
reassignment protection on that path degrades to the handle-ambiguity rule
(two matches → unresolved → `rejected_invalid`) instead of a stable id match.

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
  the new identity. Nothing merges. Implemented in `convex/lib/accounts.ts`
  (`resolveAccount` / `canonicalAccountForUserId`) and `convex/jobs.ts`
  `upsertAccount`. Two rows sharing a handle is a legitimate state; handle
  lookups that find two matches resolve to nothing rather than guessing.
  Publication applies the same resolver (`convex/publication.ts`), so an
  account visible in the library is the account an update can attach to.
- This app does not create an account row purely from a publication update. Accounts
  are created only from our own acquisition flow (`jobs.finish`). A publication
  update that cannot resolve to an existing account is rejected
  (`outcome: "rejected_invalid"`, logged, not applied) rather than used to invent one.

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

| Field                 | Type                                                       | Required                                | Meaning                                                                                                                                                                                             |
| --------------------- | ---------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`             | `1`                                                        | yes                                     | For future evolution of this envelope.                                                                                                                                                              |
| `providerAccountId`   | string                                                     | no                                      | The provider (x.md) numeric account id. Send this whenever the indexer can determine it — see "The one thing to agree first" above.                                                                 |
| `handle`              | string                                                     | yes                                     | Normalized handle, always sent, used as the fallback identity lookup.                                                                                                                               |
| `runId`               | string                                                     | no                                      | The Convex `jobs._id` (as a string) of the acquisition run this update reflects, when it traces to one run. Same `runId` already used in the raw-capture envelope (`docs/integration-contract.md`). |
| `captureIds`          | string[]                                                   | yes (may be empty)                      | The content-addressed capture ids (same id space as `Capture`/`Receipt.captureId` in `convex/lib/handoff.ts`) this update confirms were processed.                                                  |
| `generation`          | number                                                     | yes                                     | Monotonic per account, assigned by the sender. See "Idempotency and staleness" below — every ordering and dedup rule in this contract pivots on this one number.                                    |
| `reportedState`       | `"indexing" \| "searchable" \| "failed"`                   | yes                                     | See "Publication states" above.                                                                                                                                                                     |
| `uniquePostCount`     | number                                                     | no                                      | Unique, currently-searchable post count for this account as of this update. See "What unique means" below. Send it on a `searchable` update; omit rather than guess on `indexing`/`failed`.         |
| `uniquePostCountAsOf` | number (epoch ms)                                          | no                                      | When the indexer computed `uniquePostCount`. Required whenever `uniquePostCount` is present.                                                                                                        |
| `pendingWork`         | `{ unit: "jobs" \| "captures" \| "posts", count: number }` | no                                      | Work the indexer knows is still outstanding for this account, in whatever unit is natural to report. Omit when unknown — never send a guessed count.                                                |
| `error`               | `{ message: string, code?: string }`                       | required when `reportedState: "failed"` | The indexer's own reason. Verbatim, not reworded by us.                                                                                                                                             |
| `observedAt`          | number (epoch ms)                                          | yes                                     | When the indexer observed/computed this update. Distinct from `receivedAt`, which this app assigns on acceptance.                                                                                   |

Fields not listed here (an account-level "generation" the indexer wants to track that
isn't a publication concern, ranking internals, per-post detail) do not belong in this
envelope; this is a summary/state contract, not a corpus sync channel. The receiver
rejects any key it was not told about (`parseEnvelope` in
`convex/publication.ts`), so adding one is a 400, not a silently ignored field.

Two optional fields nothing currently exercises end to end: the in-repo sender
never sends `pendingWork` (the receiver stores it, and no dashboard field
carries it out yet), and it only sends `providerAccountId`/`runId` for capture
batches whose payload actually carries them — a per-handle dump sends neither.

## What "unique" means

`uniquePostCount` is the count of distinct posts for this account that are live in the
committed search index, deduplicated across every capture and every acquisition run
ever ingested for that account — not:

- **Not** `jobs.count` — a running total of accepted raw records per capture batch,
  unbounded and not deduplicated across retries or overlapping page ranges.
- **Not** `jobs.postsReceived` — a per-page download counter (bulk/JSON kind only).
  Acquisition now requests up to 5,000 posts per page; this field still tracks
  what one download observed, not the live index.
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

### What the sender owes when a send gets no answer

The receiver's rules above only work if a generation is never reused for
different content. The in-repo sender holds that line as follows, and any other
sender has the same obligation:

- A delivery that never got a response does **not** spend its generation. The
  exact update is stored (`publications.<handle>.pending` in the indexer's
  `users.json`) and replayed byte for byte — same `captureIds`, same count,
  same `observedAt` — so the retried body, and therefore its
  `Idempotency-Key`, is identical to the attempt that went unanswered.
- While that update is owed, a later import for the same account must not
  publish at the reserved generation. It stands down, and what it would have
  reported (`captureIds`, `runId`, `providerAccountId`, its state) is retained
  against the account (`publications.<handle>.deferred`). Several stood-down
  imports coalesce into one entry.
- Once the owed update is answered, that entry goes out as a **follow-on
  update at the next generation** — new content, not a replay: the count is
  recomputed and `observedAt` is fresh; only the identity comes from the
  registry, so it names the captures it confirms rather than going out
  handle-only. Dropping those ids instead would leave a capture indexed and
  permanently unconfirmed, because the indexer skips an already-recorded
  capture on every later pass.

Mechanics and operator-visible logging: [indexer operations](search-indexer.md)
"Publishing to Convex".

## Delivery

- **Direction:** push. The in-repo indexer calls `POST /publication/update`
  (`search/crates/indexer/src/publish.rs`), mirroring the raw-capture handoff.
  If a later indexer can only support polling, the envelope shape is unaffected
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
  called by `t.fetch(...)` in `tests/publication.test.ts` and
  `tests/scenario-publication-lifecycle.test.ts`, against an in-memory
  convex-test deployment. The in-repo sender has since called the
  **production** route over TLS with a deliberately unknown handle (422) and a
  wrong bearer (401), mutating no account state. No real account has been
  published yet.
- **Transport must be encrypted.** The bearer token travels in an
  `Authorization` header, so a plain `http://` endpoint would put
  `PUBLICATION_SERVICE_TOKEN` on the wire in cleartext. The in-repo sender
  refuses to build a configuration for one (`PublishConfig::new` in
  `search/crates/indexer/src/publish.rs`) unless the host is loopback, which is
  what its own tests point at. Any other sender should hold itself to the same
  rule.
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

This table only records observations. Rows are written by `convex/importer.ts` and,
in production (`COLLECTOR_MODE=outbound`), by `scripts/production-worker.ts` via
`worker.report`'s `"throttle"` event. A response qualifies only when it is a
refusal that names a limit (HTTP 429, usable `Retry-After`, or a problem
`code`/`type` that names a rate limit) — not merely because `RateLimit-*`
headers were present. `{ kind: "none" }` means nothing has been observed, never
"not throttled". Nothing reads these rows to decide whether to make a request.
See [the control plane](control-plane.md).

## Worker/indexer/service health

`serviceHealth` (`convex/schema.ts`) is a new table, one row per external dependency
(`service: "indexer" | "receiver" | "search"`), holding `healthy`, `lastHeartbeatAt`,
`lastSuccessAt`, and `lastError` as observed facts with timestamps. This exists because
`integrations.configured` today reports "configured" (an env var is set) as if it were
"healthy," and outside of the outbound-collector's own `collector` heartbeat table,
nothing observes whether the receiver or the indexer are actually alive (see the
limits reader's findings). x.md itself is not tracked here — it is a per-call
third-party dependency, covered by `providerThrottleEvents` instead of a standing
health row.

Nothing on `main` writes to `serviceHealth`. `convex/summary.ts` reads the table and
`convex/schema.ts` defines it; the only inserts anywhere are in tests. All three
services therefore read `unknown` ("No health report received yet") in production,
which is the honest reading and not a live zero. Now that the receiver above exists,
a natural source for `indexer` health is "did we receive a publication update
recently" — but that wiring is a later implementation step.

## Dashboard-facing shapes

Three more shapes exist purely as query/mutation return types (not stored tables):
`dashboardSummaryValidator`, `accountLibraryRowValidator`, and `queueBreakdownValidator`
in `convex/lib/contracts.ts`. Every count in all three is a `Count` — `{ kind: "known",
unit, value }` or `{ kind: "unknown", unit }`, where `unit` is `"jobs" | "captures" |
"posts" | "accounts"` — so a query can never collapse "I don't know" into 0, and no
consumer can read a bare number without also knowing what it counts. See the field
comments in `convex/lib/contracts.ts` for exactly what each count means and how it is
scoped; this document does not repeat them to avoid the two drifting apart.

`queueBreakdownValidator.savedCapturesAwaitingIndexing` (unit `"captures"`) is the one
bucket without a stored counter behind it: `convex/summary.ts`'s
`computeSavedCapturesAwaitingIndexing` derives it exactly as guided here — receipts
whose `captureId` has not appeared in a confirming `publicationUpdates` row for that
account, deduped per account across all of an owner's bulk jobs
(`tests/summary.test.ts`). Confirming means `outcome: "applied"` **and**
`reportedState` other than `"failed"`: an applied `failed` update reports that the
indexer could not index those captures, so it moves the account's state without
retiring the work (`confirmedCaptureIds` in `convex/summary.ts`;
`tests/review-fixes.test.ts` "stays counted as awaiting indexing instead of being
marked confirmed"). If that join proves too expensive at real production scale, a
denormalized per-capture status table is a reasonable future addition — not built,
since the join has not been measured against real volume yet.

## Explicitly out of scope here

- Ranking, cursor signing, and corpus policy stay on the search side (to-do.md
  ownership). This repository now also contains a publication sender; that does
  not move ranking or retrieval into Convex.
- The raw-capture receiver and search-query contracts in
  `docs/integration-contract.md` — unchanged by this document.
- Single-use nonce/replay protection for `/ticket-search` tickets — a search-query
  concern the collaborator-dependency reader flagged as deferred to "the integration
  layer," separate from publication updates. Still open; not addressed here.
- Authorized/scoped **search** (to-do.md P1) — `assertAuthorizedScope` still
  fail-closes anything but `{ kind: "global" }`. Dashboard **summary** scope is
  different: `convex/summary.ts` returns `{ kind: "owner" }` (this caller's
  imports). `{ kind: "account", accountId }` is reserved and unused.
- Confirming any "Open assumption" below with Pronsh. The in-repo sender can
  call `POST /publication/update`; a real account has not been published yet.

## Open assumptions, listed together

For a reviewer checking this against the collaborator-dependency reader's findings:

1. **Identity:** capture-batch updates send `providerAccountId` when the payload
   carries a `profile` or a post `author.id`; per-handle dump files stay handle-only.
   Our receiver already requires a resolvable existing account. Unconfirmed as a
   collaborator agreement — see "The one thing to agree first."
2. **Unique count:** the in-repo sender reports Tantivy's live `count_author`, not
   registry `accepted`/`rejected`. Unconfirmed as a collaborator agreement.
3. **Delivery direction:** the in-repo sender is push (`POST /publication/update`).
   Unconfirmed as a collaborator agreement if a later indexer cannot push.
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
  `queueBreakdownValidator` (+ `QueueBreakdown`), `dashboardSummaryValidator`
  (+ `DashboardSummary`), `nextActionValidator` (+ `NextAction`),
  `accountLibraryRowValidator` (+ `AccountLibraryRow`), and the convenience aliases
  `PublicationState`, `ReportedPublicationState`, `JobStatus`.
