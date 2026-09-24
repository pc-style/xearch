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
    .index("by_account", ["accountId"]),
  jobs: defineTable({
    owner: v.id("users"),
    kind: kindValidator,
    input: v.string(),
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
