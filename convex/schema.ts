import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

export const sortValidator = v.union(
  v.literal("relevance"),
  v.literal("engagement"),
  v.literal("likes"),
  v.literal("newest"),
  v.literal("oldest"),
);

export const postFields = {
  tweetId: v.string(),
  author: v.string(),
  text: v.string(),
  url: v.string(),
  createdAt: v.optional(v.number()),
  likes: v.optional(v.number()),
  reposts: v.optional(v.number()),
  replies: v.optional(v.number()),
  links: v.array(v.string()),
  avatar: v.optional(v.string()),
  displayName: v.optional(v.string()),
};

export const backendStatsFields = {
  totalUs: v.number(),
  reloadUs: v.number(),
  fingerprintUs: v.number(),
  cursorUs: v.number(),
  compileUs: v.number(),
  retrieveUs: v.number(),
  rankingCalls: v.number(),
  materializeUs: v.number(),
  candidateHits: v.number(),
  returnedRows: v.number(),
  indexDocs: v.number(),
  segments: v.number(),
};

export const apiStatsFields = {
  totalUs: v.number(),
  authUs: v.number(),
  validateUs: v.number(),
  cursorVerifyUs: v.number(),
  parseUs: v.number(),
  permitUs: v.number(),
  queueUs: v.number(),
  engineUs: v.number(),
  postprocessUs: v.number(),
  cursorSignUs: v.number(),
};

export const searchStatsFields = {
  backend: v.object(backendStatsFields),
  api: v.optional(v.object(apiStatsFields)),
};

export const kindValidator = v.union(
  v.literal("bulk"),
  v.literal("live"),
  v.literal("post"),
  v.literal("profile"),
  v.literal("following"),
  v.literal("followers"),
  v.literal("archive"),
);

// Acquisition-job lifecycle. Unrelated to accountPublications.state below:
// a job reaching "complete" means raw handoff finished, not that anything is
// searchable yet. See docs/publication-contract.md.
export const jobStatusValidator = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("complete"),
  v.literal("partial"),
  v.literal("failed"),
  v.literal("cancelled"),
);

// --- Publication contract (docs/publication-contract.md) --------------------
// Shared vocabulary for accountPublications, publicationUpdates, and the
// convex/lib/contracts.ts wire shapes. Kept here, next to the other
// cross-file validators (sortValidator, kindValidator), so table columns and
// the envelope that fills them can never drift apart.

// The full state an account's publication can be in. "downloaded" and
// "waiting_for_indexing" are ours to assign from acquisition-side facts (a
// durable raw-capture receipt exists) before any indexer update has ever
// arrived for this account. "indexing" / "searchable" / "failed" are ours to
// set only in response to an accepted publication update — see
// reportedPublicationStateValidator below, which is the narrower set the
// indexer itself is ever allowed to assert.
export const publicationStateValidator = v.union(
  v.literal("downloaded"),
  v.literal("waiting_for_indexing"),
  v.literal("indexing"),
  v.literal("searchable"),
  v.literal("failed"),
);

// The states a publication UPDATE may report. The indexer never tells us
// "downloaded" or "waiting_for_indexing" — those describe our own acquisition
// side before the indexer has said anything at all.
export const reportedPublicationStateValidator = v.union(
  v.literal("indexing"),
  v.literal("searchable"),
  v.literal("failed"),
);

// Units a "pending work" or dashboard count can be labelled with. A count
// with no matching unit here should not exist; see contracts.ts's
// countValidator, which pairs one of these with a value or an explicit
// "unknown".
export const countUnitValidator = v.union(
  v.literal("jobs"),
  v.literal("captures"),
  v.literal("posts"),
  v.literal("accounts"),
);

export const pendingWorkUnitValidator = v.union(
  v.literal("jobs"),
  v.literal("captures"),
  v.literal("posts"),
);

// Lifecycle of one account's deep-history backfill (convex/lib/
// historyWindow.ts, convex/jobs.ts). Distinct from jobStatusValidator: a
// backfill outlives any single window job, walking many of them back in
// time, and only ever reaches "complete" (ran out of history to search) or
// "stopped" (a window job failed permanently after its own retries) once —
// see historyBackfills below.
export const historyBackfillStatusValidator = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("complete"),
  v.literal("stopped"),
);

// Calls this app makes that can be throttled by the far side.
export const throttleProviderValidator = v.union(
  v.literal("xmd"),
  v.literal("receiver"),
  v.literal("search"),
);

// External services whose liveness/last-success we track as observed facts.
// x.md is a per-call third-party dependency (see throttleProviderValidator),
// not a standing service we hold a health row for.
export const serviceValidator = v.union(
  v.literal("indexer"),
  v.literal("receiver"),
  v.literal("search"),
);

export const publicationUpdateOutcomeValidator = v.union(
  v.literal("applied"),
  v.literal("stale_ignored"),
  v.literal("duplicate_ignored"),
  v.literal("rejected_unauthorized"),
  v.literal("rejected_invalid"),
);

// Fields a publication update carries, verbatim. Shared between the inbound
// wire envelope (convex/lib/contracts.ts publicationUpdateEnvelope) and the
// durable log below (publicationUpdates), so the two can never drift. Full
// semantics, idempotency, and staleness rules: docs/publication-contract.md.
export const publicationUpdateFields = {
  // Provider account id first; normalized handle is the fallback only. Once
  // a provider id is on record for an account, never resolve identity by
  // handle alone again — that is exactly how two different real accounts
  // get silently merged into one library row after a handle reassignment.
  providerAccountId: v.optional(v.string()),
  handle: v.string(),
  // The Convex jobs._id (as a string) of the acquisition run this reflects,
  // when the update traces to one run. Capture/job identity, kept distinct
  // from account identity above.
  runId: v.optional(v.string()),
  // Content-addressed capture ids (same id space as
  // convex/lib/handoff.ts Capture/Receipt.captureId) this update confirms
  // were processed.
  captureIds: v.array(v.string()),
  // Monotonic per account, assigned by the sender. Every idempotency and
  // ordering rule in this contract pivots on this one number — see
  // accountPublications.committedGeneration.
  generation: v.number(),
  reportedState: reportedPublicationStateValidator,
  // Unique, currently-searchable post count for this account as of this
  // update. NEVER a count of accepted/downloaded records: see
  // accountPublications.searchablePostCount and
  // docs/publication-contract.md ("what unique means"). Absent means
  // unknown, not zero and not unchanged-assume-previous.
  uniquePostCount: v.optional(v.number()),
  uniquePostCountAsOf: v.optional(v.number()),
  pendingWork: v.optional(v.object({ unit: pendingWorkUnitValidator, count: v.number() })),
  error: v.optional(v.object({ message: v.string(), code: v.optional(v.string()) })),
  // Sender-reported observation time; distinct from this app's own
  // receivedAt, which is assigned server-side on acceptance.
  observedAt: v.number(),
};

// "history": a deep-history backfill window (historyBackfills below,
// convex/jobs.ts `insertHistoryWindowJob`) — a `kind: "live"` job scheduled
// by `jobs.finish` itself, walking one dated slice of an account's timeline
// further back than x.md's account-timeline floor reaches. Never a person
// and never `discovered` (scripts/discover-accounts.mjs's own reason for
// queuing a run) — this is `jobs.finish` reacting to its OWN prior job, not
// to interaction evidence about an account nobody has imported yet.
export const jobOriginValidator = v.union(
  v.literal("manual"),
  v.literal("discovered"),
  v.literal("history"),
);

export const discoveredFromValidator = v.object({
  handle: v.string(),
  interactions: v.number(),
});

export default defineSchema({
  ...authTables,
  collector: defineTable({
    name: v.string(),
    online: v.boolean(),
    lastSeen: v.number(),
  }).index("by_name", ["name"]),
  // Control-plane metadata only. Corpus bytes and normalization belong
  // downstream. Identity is keyed on the provider account id (userId); handle
  // is the current display handle and a fallback lookup only — see
  // accountHandles and docs/publication-contract.md ("account identity").
  accounts: defineTable({
    handle: v.string(),
    userId: v.string(),
    name: v.string(),
    avatar: v.optional(v.string()),
    // X's own reported lifetime post count and join date, from x.md's
    // profile fields `statuses`/`joined` (scripts/production-worker.ts,
    // convex/importer.ts). Present only once a profile fetch has actually
    // reported them — never estimated. Compared against a bulk job's own
    // `postsReceived`/`floorReached` in convex/jobs.ts `finish` to decide
    // whether x.md's account-timeline floor (~3,200 posts) left more of
    // this account's history undiscovered, and `joined` is the deep-history
    // backfill's walk-back floor (convex/lib/historyWindow.ts).
    statuses: v.optional(v.number()),
    joined: v.optional(v.string()),
  })
    .index("by_handle", ["handle"])
    .index("by_user_id", ["userId"]),
  // Every handle an account has ever been known by. Lets identity resolution
  // treat the provider account id as truth and the handle as a fallback,
  // without ever merging two different provider ids that happened to share a
  // handle at different times (a handle reassignment).
  accountHandles: defineTable({
    accountId: v.id("accounts"),
    handle: v.string(),
    firstSeenAt: v.number(),
    lastSeenAt: v.number(),
  })
    .index("by_handle", ["handle"])
    .index("by_account", ["accountId"])
    // One account's handle history is bounded by how many times X has
    // actually reassigned/renamed it, not by an arbitrary read cap — see
    // convex/jobs.ts `recordHandle`, which uses this to look up "has this
    // exact account already seen this exact handle" directly instead of
    // scanning a capped page of the account's rows (a scan silently
    // re-inserted a handle once an account passed its 50th tracked one).
    .index("by_account_and_handle", ["accountId", "handle"]),
  jobs: defineTable({
    owner: v.id("users"),
    kind: kindValidator,
    input: v.string(),
    // How this run came to exist. "discovered": scripts/discover-accounts.mjs
    // queued it because indexed accounts interact with this one a lot;
    // `discoveredFrom` is that evidence. "history": `jobs.finish` itself
    // queued it as the next deep-history backfill window for `historyFor`
    // below (convex/jobs.ts `insertHistoryWindowJob`). Absent, or "manual",
    // means a person started it directly — every row written before this
    // field existed was one of those.
    origin: v.optional(jobOriginValidator),
    discoveredFrom: v.optional(v.array(discoveredFromValidator)),
    since: v.optional(v.string()),
    until: v.optional(v.string()),
    refresh: v.boolean(),
    expectedUserId: v.optional(v.string()),
    cursor: v.optional(v.string()),
    nextUntil: v.optional(v.string()),
    nextCursor: v.optional(v.string()),
    status: jobStatusValidator,
    count: v.number(),
    phase: v.optional(v.string()),
    autoContinue: v.optional(v.boolean()),
    pages: v.optional(v.number()),
    pageAttempt: v.optional(v.number()),
    postsReceived: v.optional(v.number()),
    oldest: v.optional(v.string()),
    floorReached: v.optional(v.boolean()),
    attempt: v.number(),
    warnings: v.array(v.string()),
    error: v.optional(v.string()),
    updatedAt: v.number(),
    readyAt: v.optional(v.number()),
    // When someone dismissed this finished run from the shared feeds, if
    // they did. Dismissing HIDES a run; it never deletes it, and it never
    // touches the `receipts` rows that prove a capture was durably stored —
    // to-do.md P0 "Preserve receipts and failure evidence; do not delete
    // records just to hide duplicates". Only a terminal run can be
    // dismissed (see convex/jobs.ts `dismiss`), and `restore` clears this
    // field again.
    dismissedAt: v.optional(v.number()),
    // Whether a *stopped* run (failed/partial) could succeed on a plain
    // retry, straight from `ProviderError.retryable` (convex/lib/xmd.ts) at
    // the moment convex/jobs.ts `finish` gave up on it. `undefined` for any
    // job that never stopped on an error, and for the pre-existing rows this
    // field is rolled out onto — those show the same as a retryable failure
    // (Retry offered) rather than silently losing the button. Never set from
    // parsing `error` text: the provider's message wording is not a stable
    // contract to match against.
    retryable: v.optional(v.boolean()),
    // The account a history-window job (origin: "history") is backfilling.
    // Unset for every other job kind/origin.
    historyFor: v.optional(v.id("accounts")),
  })
    .index("by_status", ["status"])
    // No index on `owner` alone: the imported corpus is shared
    // infrastructure, not personal data (to-do.md, convex/lib/search.ts), so
    // no query filters the jobs feed, the account library, or the dashboard
    // totals down to one owner any more. `owner` itself stays on every job
    // as an audit trail of who started it.
    //
    // One exact request's runs, newest first — Convex appends
    // `_creationTime` as the trailing column of every index, so
    // `.order("desc").first()` on this is "when was this last asked for?".
    // Used by `jobs.start` to answer a repeated request (from anyone) with
    // the run that already exists instead of starting a second one.
    .index("by_input", ["kind", "input", "status"])
    // The imported corpus is shared across every owner (see convex/lib/
    // search.ts and to-do.md): convex/lib/accounts.ts scans every account-
    // history job across all owners to build the account library and its
    // totals, and needs an index on kind alone to do that without reading
    // (and filtering out) every live search, single-post, and profile job
    // any owner has ever run.
    .index("by_kind", ["kind"]),
  // One row per account: the current publication pipeline state plus the
  // last confirmed-searchable snapshot. These are deliberately separate
  // fields so a failed refresh can move `state` to "failed" while leaving
  // searchablePostCount / searchablePostCountAsOf / lastPublishedAt exactly
  // as they were — a previous searchable state must never be erased by a
  // later failure. See docs/publication-contract.md.
  accountPublications: defineTable({
    accountId: v.id("accounts"),
    state: publicationStateValidator,
    // Generation of the most recently accepted update, of any reported
    // state (advances even on "failed"). An incoming update whose own
    // generation is <= this value is stale or a duplicate; see
    // publicationUpdateOutcomeValidator and docs/publication-contract.md.
    committedGeneration: v.number(),
    // Sticky "last known good" snapshot. Written only when an accepted
    // update's reportedState is "searchable"; never cleared or decremented
    // by a later "indexing" or "failed" update. This is the one field the
    // "Indexed posts" stat may read — never jobs.count or
    // jobs.postsReceived, which measure acquisition, not the committed index.
    searchablePostCount: v.optional(v.number()),
    searchablePostCountAsOf: v.optional(v.number()),
    lastPublishedAt: v.optional(v.number()),
    // Most recent error report, kept even after a later success moves
    // `state` on — this answers "when did this last fail and why", not
    // "is it currently failing" (read `state` for that).
    lastError: v.optional(
      v.object({ message: v.string(), observedAt: v.number(), generation: v.number() }),
    ),
    pendingWork: v.optional(v.object({ unit: pendingWorkUnitValidator, count: v.number() })),
    updatedAt: v.number(),
    // A digest of the material fields (reportedState, captureIds,
    // uniquePostCount, uniquePostCountAsOf, pendingWork, error) of the most
    // recently APPLIED update, so a later update resent under the SAME
    // generation number can
    // be told apart from a true idempotent replay: matching digest means
    // the sender resent the identical content (duplicate_ignored); a
    // different digest under the same generation means two different
    // reports claim to be the same generation, which is a contract
    // violation (rejected_invalid), not a no-op. Optional and unbackfilled
    // on purpose (no migration) — a row written before this field existed
    // simply cannot be checked for a conflicting replay, and falls back to
    // the old duplicate_ignored behavior. See convex/publication.ts
    // `applyUpdate` and docs/publication-contract.md "Idempotency and
    // staleness".
    lastAppliedDigest: v.optional(v.string()),
  })
    .index("by_account", ["accountId"])
    .index("by_state", ["state"]),
  // Append-only audit log of every publication update this app has applied,
  // rejected, or ignored as stale/duplicate. Exists so "duplicate updates are
  // idempotent" and "stale updates cannot regress displayed state" are
  // provable from evidence, not merely true by construction.
  publicationUpdates: defineTable({
    ...publicationUpdateFields,
    // Resolved identity at receipt time; unset when identity could not be
    // resolved at all (see outcome "rejected_invalid").
    accountId: v.optional(v.id("accounts")),
    receivedAt: v.number(),
    outcome: publicationUpdateOutcomeValidator,
    rejectionReason: v.optional(v.string()),
  })
    .index("by_account", ["accountId"])
    .index("by_handle", ["handle"])
    .index("by_account_and_generation", ["accountId", "generation"]),
  // Provider-reported throttling, attached to the specific job/attempt and
  // operation that observed it. Distinct from jobs.error (free text, can
  // hold stale historical messages such as a pre-PR#12 daily-limit string)
  // so the dashboard can tell a live limit from an old one. `remaining` and
  // `resetAt` are set ONLY when the provider actually supplied them — never
  // estimated, defaulted, or backfilled with a guessed number.
  providerThrottleEvents: defineTable({
    jobId: v.optional(v.id("jobs")),
    attempt: v.optional(v.number()),
    provider: throttleProviderValidator,
    operation: v.string(),
    reason: v.string(),
    remaining: v.optional(v.number()),
    resetAt: v.optional(v.number()),
    retryAfterMs: v.optional(v.number()),
    observedAt: v.number(),
  })
    .index("by_job", ["jobId"])
    .index("by_provider", ["provider"]),
  // Observed liveness of a backend dependency, as facts with timestamps —
  // never a boolean derived from "an env var is set", the way
  // integrations.configured reports "configured" today.
  serviceHealth: defineTable({
    service: serviceValidator,
    healthy: v.boolean(),
    lastHeartbeatAt: v.optional(v.number()),
    lastSuccessAt: v.optional(v.number()),
    lastError: v.optional(v.object({ message: v.string(), observedAt: v.number() })),
    observedAt: v.number(),
  })
    .index("by_service", ["service"])
    // `service` alone cannot answer "the newest observation": an index
    // orders by its own columns, and picking a row without observedAt in the
    // key means picking an arbitrary one. Readers use this and take the
    // first in descending order.
    .index("by_service_and_observed", ["service", "observedAt"]),
  // One row per account ever backfilled: the source of truth for "has this
  // account's deep history been (or is it being) walked back beyond x.md's
  // account-timeline floor", so convex/jobs.ts `finish` never starts a
  // second backfill for the same account. `cursorUntil` is the moving
  // boundary — the `until` the NEXT window job will use — and moves strictly
  // backward in time as each window completes; `windowDays` is the size of
  // the window most recently scheduled, widened (never shrunk) when a
  // window comes back empty (convex/lib/historyWindow.ts `nextWindowDays`).
  // `postsFound` is this backfill's own running total across every window
  // job it has scheduled, separate from any account's searchable-post count
  // (accountPublications.searchablePostCount) — the indexer, not this row,
  // is what makes a captured post searchable.
  historyBackfills: defineTable({
    accountId: v.id("accounts"),
    handle: v.string(),
    owner: v.id("users"),
    since: v.string(),
    cursorUntil: v.string(),
    windowDays: v.number(),
    postsFound: v.number(),
    status: historyBackfillStatusValidator,
    error: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_account", ["accountId"]),
  receipts: defineTable({
    jobId: v.id("jobs"),
    captureId: v.string(),
    receiptId: v.string(),
    records: v.number(),
  }).index("by_capture", ["jobId", "captureId"]),
  sessions: defineTable({
    owner: v.id("users"),
    raw: v.string(),
    sort: sortValidator,
    cursor: v.optional(v.string()),
    includeStats: v.optional(v.boolean()),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("complete"),
      v.literal("failed"),
    ),
    rows: v.array(v.object(postFields)),
    nextCursor: v.optional(v.string()),
    warnings: v.array(v.string()),
    stats: v.optional(v.object(searchStatsFields)),
    error: v.optional(v.string()),
  }).index("by_owner", ["owner"]),
  saved: defineTable({
    owner: v.id("users"),
    query: v.string(),
    sort: sortValidator,
  }).index("by_owner", ["owner"]),
  bookmarks: defineTable({ owner: v.id("users"), post: v.object(postFields) })
    .index("by_owner", ["owner"])
    .index("by_post", ["owner", "post.tweetId"]),
  pages: defineTable({
    url: v.string(),
    title: v.string(),
    text: v.string(),
    collectedAt: v.number(),
  }).index("by_url", ["url"]),
  deliveries: defineTable({
    owner: v.id("users"),
    outboundId: v.string(),
    query: v.string(),
  }).index("by_owner", ["owner"]),
});
