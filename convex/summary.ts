import { v, type Infer } from "convex/values";
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { user } from "./access";
import { serviceValidator } from "./schema";
import {
  dashboardSummaryValidator,
  type Count,
  type DashboardSummary,
  type QueueBreakdown,
} from "./lib/contracts";

/**
 * The dashboard summary/stats query: docs/publication-contract.md
 * "Dashboard-facing shapes", built strictly on the frozen shapes in
 * convex/schema.ts and convex/lib/contracts.ts. This file does not add any
 * new wire shape — every returned value is exactly a `Count`,
 * `DashboardSummary`, or a small local type for the one thing contracts.ts
 * does not yet cover (service health) — and it never implements any part of
 * the indexer/watcher/registry that stays on Pronsh's side.
 *
 * Two things every count here must honor (docs/publication-contract.md,
 * to-do.md "Never invent a number"):
 *   1. A count of 0 is a claim that we looked and found nothing. "unknown" is
 *      a claim that we have not checked or the upstream side never said.
 *      They must never collapse into each other.
 *   2. `accountPublications.searchablePostCount` is the ONLY source for a
 *      searchable-post total — never `jobs.count`, `jobs.postsReceived`, nor
 *      a count of receipts/files. See "What unique means" in the contract.
 */

// --- Bounded reads ------------------------------------------------------
// Convex query guidelines: never `.collect()` an unbounded table; use
// `.take()` with a cap instead. These are generous relative to how many
// jobs/accounts/receipts one account or one owner realistically has today.
// These are the same tradeoff convex/library.ts already accepts for its own
// owner-scoped job list, and the one docs/publication-contract.md itself
// names for `savedCapturesAwaitingIndexing`
// ("a denormalized per-capture status table is a reasonable future addition
// — not built now"). If this table outgrows these caps, the fix is
// `@convex-dev/aggregate` (convex guidelines "Query guidelines"), not a
// larger constant.
const MAX_OWNED_JOBS = 1_000;
const MAX_RECEIPTS_PER_JOB = 200;
const MAX_PUBLICATION_UPDATES_PER_ACCOUNT = 500;

// Only a full-account "bulk" import ever establishes an account identity or
// a publication row (see convex/library.ts's own ACCOUNT_JOB_KIND) — a
// "live"/"post"/etc. job's receipts can never be confirmed by a publication
// update, since there is no account for one to apply to, so they are outside
// the scope of "saved captures awaiting indexing" entirely.
const ACCOUNT_JOB_KIND = "bulk" as const;

function knownCount(unit: Count["unit"], value: number): Count {
  return { kind: "known", unit, value };
}
function unknownCount(unit: Count["unit"]): Count {
  return { kind: "unknown", unit };
}

// --- Queued-post counts / provider "pending work" (NOT implemented here) ---
// to-do.md P0 "Show queued-post counts only when known. Unknown provider
// history size is 'unknown,' not zero or an invented estimate." is NOT
// covered by this query. The data exists —
// accountPublications.pendingWork / publicationUpdateFields.pendingWork
// (convex/schema.ts, docs/publication-contract.md "pendingWork") is written
// by convex/publication.ts whenever the indexer reports it — but
// dashboardSummaryValidator and queueBreakdownValidator (convex/lib/
// contracts.ts) have no field to carry a pendingWork total out to the
// dashboard, and that file is frozen and not one of this unit's owned files
// (convex/summary.ts, tests/summary.test.ts). Adding this bullet for real
// needs a new Count-shaped field on one of those two validators, which is a
// contract change outside this unit's scope. Left honestly unimplemented and
// untested rather than claimed as covered — do not read this comment as
// permission to bolt an ad hoc extra field onto the return value here; that
// would be exactly the kind of parallel mechanism the frozen contract exists
// to prevent.

// --- Indexed posts / indexed people (owner-scoped) ----------------------
//
// These two totals used to scan every `accountPublications` row in the
// deployment with no owner filter, while `convex/library.ts` `rows` — the
// list the "Indexed people" tile links to — was owner-scoped to the caller's
// own bulk jobs. The screen therefore contradicted itself: a caller with
// zero imports could read a nonzero "Indexed people" above an empty account
// list, and every user saw everyone else's corpus counted as their own.
//
// Both numbers are now derived from exactly the account set
// `convex/library.ts` builds its rows from: the accounts resolved from this
// owner's own bulk jobs. The tile and the list agree by construction, and
// the scan is bounded by how many accounts one person imported instead of by
// how many exist globally — which also retires the old MAX_PUBLICATIONS
// truncation case, since there is no unfiltered table scan left to truncate.

async function computeIndexTotals(
  ctx: QueryCtx,
  accountIds: Id<"accounts">[],
): Promise<{ indexedPosts: Count; indexedAccounts: Count }> {
  let sum = 0;
  let unknown = false;
  let searchableAccounts = 0;
  for (const accountId of accountIds) {
    const publication = await ctx.db
      .query("accountPublications")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .unique();
    if (!publication) continue;
    if (publication.state === "searchable") searchableAccounts += 1;
    if (publication.searchablePostCount !== undefined) {
      // Sticky "last known good" snapshot: included regardless of the
      // account's CURRENT state, per the non-regression guarantee — a
      // failed refresh must not erase a previously searchable account's
      // visible post count. docs/publication-contract.md
      // "The non-regression guarantee".
      sum += publication.searchablePostCount;
    } else if (publication.state === "searchable") {
      // The indexer reported "searchable" but never sent a uniquePostCount
      // for it (an update accepted without one). We genuinely do not know
      // this account's contribution, so the WHOLE total must say "unknown"
      // rather than silently treat this account as 0 or omit it from an
      // unlabelled partial sum. docs/publication-contract.md "what unique
      // means"; convex/lib/contracts.ts countValidator doc comment.
      unknown = true;
    }
    // Any other state with no searchablePostCount (downloaded /
    // waiting_for_indexing / indexing / failed-and-never-searchable) has
    // never had a post published for it yet: a true, known zero
    // contribution, not "unknown".
  }
  return {
    indexedPosts: unknown ? unknownCount("posts") : knownCount("posts", sum),
    // unit "accounts" — distinct accounts whose CURRENT state is
    // "searchable". Deliberately narrower than indexedPosts above: an
    // account that regressed to "failed" still contributes its old post
    // count to indexedPosts but is not counted here, since it is not
    // currently indexed.
    indexedAccounts: knownCount("accounts", searchableAccounts),
  };
}

// --- Queue (owner-scoped: jobs.owner is the only place user ownership
// actually exists in this schema — accounts/accountPublications are shared
// across owners today, see computeIndexTotals above) ----------------------

async function ownedJobs(ctx: QueryCtx, owner: Id<"users">): Promise<Doc<"jobs">[]> {
  const jobs = await ctx.db
    .query("jobs")
    .withIndex("by_owner", (q) => q.eq("owner", owner))
    // Newest first: a bounded read that silently kept the OLDEST jobs would
    // describe a queue the owner no longer has.
    .order("desc")
    .take(MAX_OWNED_JOBS);
  return jobs;
}

// Resolve one job to the account it belongs to, the same identity rule as
// convex/library.ts and convex/publication.ts: provider account id first
// (job.expectedUserId, pinned mid-run once identity is confirmed), the raw
// handle only as a fallback when no provider id has ever been pinned. Not
// imported from convex/library.ts because that file exports no such helper
// (only its two queries) and is out of this unit's owned files.
async function resolveAccountId(
  ctx: QueryCtx,
  job: Doc<"jobs">,
  cache: Map<string, Id<"accounts"> | null>,
): Promise<Id<"accounts"> | null> {
  const providerAccountId = job.expectedUserId;
  const cacheKey = providerAccountId !== undefined ? `id:${providerAccountId}` : `handle:${job.input}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;
  // `.take(2)` rather than `.unique()`: a handle released on X and claimed by
  // a different account leaves two `accounts` rows sharing one handle, and
  // `.unique()` throws on that instead of returning. Two matches means the
  // identity is genuinely ambiguous, which is "unresolved", not "pick one".
  const matches =
    providerAccountId !== undefined
      ? await ctx.db
          .query("accounts")
          .withIndex("by_user_id", (q) => q.eq("userId", providerAccountId))
          .take(2)
      : await ctx.db
          .query("accounts")
          .withIndex("by_handle", (q) => q.eq("handle", job.input))
          .take(2);
  const id = matches.length === 1 ? matches[0]._id : null;
  cache.set(cacheKey, id);
  return id;
}

// Every capture id an account has an ACCEPTED ("applied") publication update
// for. "accepted" deliberately excludes stale_ignored/duplicate_ignored/
// rejected_* — those never changed accountPublications, so they cannot be
// what confirmed a capture as indexed. docs/publication-contract.md
// "Idempotency and staleness".
async function confirmedCaptureIds(
  ctx: QueryCtx,
  accountId: Id<"accounts">,
  cache: Map<Id<"accounts">, Set<string>>,
): Promise<Set<string>> {
  const cached = cache.get(accountId);
  if (cached) return cached;
  const updates = await ctx.db
    .query("publicationUpdates")
    .withIndex("by_account", (q) => q.eq("accountId", accountId))
    .take(MAX_PUBLICATION_UPDATES_PER_ACCOUNT);
  const set = new Set<string>();
  for (const update of updates) {
    if (update.outcome !== "applied") continue;
    for (const captureId of update.captureIds) set.add(captureId);
  }
  cache.set(accountId, set);
  return set;
}

// unit "captures" — durable receipts this owner's bulk jobs produced that no
// accepted publication update has confirmed yet. Guidance in
// docs/publication-contract.md "Dashboard-facing shapes"; NEVER a count of
// posts (a capture/receipt is a file, not a post — to-do.md "Never label a
// count of files as a count of posts").
async function computeSavedCapturesAwaitingIndexing(
  ctx: QueryCtx,
  bulkJobs: Doc<"jobs">[],
): Promise<Count> {
  const accountCache = new Map<string, Id<"accounts"> | null>();
  const confirmedCache = new Map<Id<"accounts">, Set<string>>();
  // Dedupe at the ACCOUNT level across ALL of the owner's bulk jobs for that
  // account, never per job. captureId is content-addressed (same content ->
  // same id — see tests/indexing.test.ts), so a retry job that re-downloads
  // previously-captured content produces a second receipt row with the SAME
  // captureId under a different jobId; counting per job double-counts that
  // one capture. Jobs whose account cannot be resolved (no accounts row
  // exists yet) are pooled under a single `null` bucket rather than each
  // getting their own — the same content-addressed id can just as easily
  // repeat there too.
  const capturesByAccount = new Map<Id<"accounts"> | null, Set<string>>();
  for (const job of bulkJobs) {
    const receipts = await ctx.db
      .query("receipts")
      .withIndex("by_capture", (q) => q.eq("jobId", job._id))
      .take(MAX_RECEIPTS_PER_JOB);
    if (receipts.length === 0) continue;
    const accountId = await resolveAccountId(ctx, job, accountCache);
    let bucket = capturesByAccount.get(accountId);
    if (!bucket) {
      bucket = new Set<string>();
      capturesByAccount.set(accountId, bucket);
    }
    for (const receipt of receipts) bucket.add(receipt.captureId);
  }
  let count = 0;
  for (const [accountId, captureIds] of capturesByAccount) {
    const confirmed = accountId
      ? await confirmedCaptureIds(ctx, accountId, confirmedCache)
      : new Set<string>();
    for (const captureId of captureIds) {
      if (!confirmed.has(captureId)) count += 1;
    }
  }
  return knownCount("captures", count);
}

async function computeQueue(
  ctx: QueryCtx,
  jobs: Doc<"jobs">[],
): Promise<{ queue: QueueBreakdown; bulkJobs: Doc<"jobs">[] }> {
  let waiting = 0;
  let active = 0;
  let failedRetryable = 0;
  const bulkJobs: Doc<"jobs">[] = [];
  for (const job of jobs) {
    // A dismissed run is one the owner explicitly cleared (convex/jobs.ts
    // `dismiss`), so it must stop counting toward the work-to-do numbers —
    // otherwise dismissing changes nothing a person can see. Only terminal
    // runs can be dismissed, so this can never hide active work.
    //
    // It is deliberately NOT applied to `bulkJobs` below: the captures those
    // runs produced are still stored and still unconfirmed by the indexer.
    // `savedCapturesAwaitingIndexing` is a statement about data on disk, not
    // about which rows someone wants to look at, and hiding a row must never
    // silently retire the evidence under it.
    if (job.kind === ACCOUNT_JOB_KIND) bulkJobs.push(job);
    if (job.dismissedAt !== undefined) continue;
    if (job.status === "queued") waiting += 1;
    else if (job.status === "running") active += 1;
    // Exactly "failed" | "partial" (a person can retry these — see
    // convex/jobs.ts retry) — deliberately NOT "cancelled", which is a
    // person's own choice, not a failure to surface as retryable.
    // convex/lib/contracts.ts queueBreakdownValidator comment.
    else if (job.status === "failed" || job.status === "partial") failedRetryable += 1;
  }
  return {
    queue: {
      waitingDownloads: knownCount("jobs", waiting),
      activeDownloads: knownCount("jobs", active),
      savedCapturesAwaitingIndexing: await computeSavedCapturesAwaitingIndexing(ctx, bulkJobs),
      failedRetryable: knownCount("jobs", failedRetryable),
    },
    bulkJobs,
  };
}

export const summary = query({
  // `now` is REQUIRED, not defaulted with `?? Date.now()`. convex/
  // _generated/ai/guidelines.md "Do not read the wall clock inside a query":
  // a query is only re-run when its args or a watched document change, so a
  // bare Date.now() (or a fallback to one when the caller omits an optional
  // arg) freezes at whatever wall-clock instant last triggered a recompute
  // instead of tracking real time. The caller must pass the current time —
  // and refresh it periodically (e.g. on an interval) if it wants
  // `observedAt` to visibly advance — the same pattern the guideline itself
  // names ("pass the current time in as an argument and let the client
  // refresh it").
  //
  // src/library/summaryApi.tsx types `summaryQuery`'s args as `{ now: number }`
  // (not `Record<string, never>`) and src/library/Library.tsx calls it as
  // `useQuery(summaryQuery, isAuthenticated ? { now } : "skip")`, refreshing
  // `now` on a `setInterval` — done together with making this arg required.
  args: { now: v.number() },
  returns: dashboardSummaryValidator,
  handler: async (ctx, args): Promise<DashboardSummary> => {
    // Authenticated backend contract only — no raw state files, service
    // credentials, or private logs are read anywhere in this file; every
    // returned field is exactly a Count, a timestamp, or the fixed "global"
    // scope literal.
    const owner = await user(ctx);
    const jobs = await ownedJobs(ctx, owner);
    const { queue, bulkJobs } = await computeQueue(ctx, jobs);
    // The same account set convex/library.ts builds its rows from, resolved
    // once and shared, so the "Indexed people" tile and the account list it
    // links to can never disagree.
    const accountCache = new Map<string, Id<"accounts"> | null>();
    const accountIds: Id<"accounts">[] = [];
    const seen = new Set<Id<"accounts">>();
    for (const job of bulkJobs) {
      const accountId = await resolveAccountId(ctx, job, accountCache);
      if (accountId && !seen.has(accountId)) {
        seen.add(accountId);
        accountIds.push(accountId);
      }
    }
    const { indexedPosts, indexedAccounts } = await computeIndexTotals(ctx, accountIds);
    return {
      indexedPosts,
      indexedAccounts,
      queue,
      // Everything above is scoped to this caller's own imports — see
      // computeIndexTotals. convex/lib/contracts.ts summaryScopeValidator's
      // "account" variant remains reserved for to-do.md P1's authorized
      // collection access and is not wired to anything.
      scope: { kind: "owner" },
      observedAt: args.now,
    };
  },
});

// --- Worker/indexer/service health, separate from "configured" -----------
// convex/integrations.ts's `configured` reports "an env var is set", not
// liveness. `serviceHealth` (convex/schema.ts) holds observed facts with
// timestamps instead; this query is the one place that reads it. Nothing
// yet writes to serviceHealth (docs/publication-contract.md says so
// explicitly), so every service reads as "unknown" until a later unit wires
// up a writer — that is the honest state, not a bug in this query.

// Placeholder staleness window: no writer exists yet to observe a real
// heartbeat cadence for "indexer" | "receiver" | "search" (unlike the
// desktop collector's own 45s heartbeat in convex/integrations.ts, which is
// a different table for a different dependency). Kept as one named,
// documented constant so a later unit can retune it once a real writer's
// cadence is known, instead of a magic number buried in the comparison.
const SERVICE_STALE_AFTER_MS = 5 * 60 * 1000;

const SERVICES = ["indexer", "receiver", "search"] as const;

const serviceStatusValidator = v.union(
  // No serviceHealth row has ever been written for this service: distinct
  // from a live "unhealthy" reading, which is a checked, known fact.
  v.object({ service: serviceValidator, kind: v.literal("unknown") }),
  v.object({
    service: serviceValidator,
    kind: v.literal("known"),
    healthy: v.boolean(),
    // True when the most recent observation is older than
    // SERVICE_STALE_AFTER_MS. A stale "healthy: true" must read differently
    // in the UI than a fresh one — this is what makes that distinction
    // possible instead of silently trusting old data.
    stale: v.boolean(),
    lastHeartbeatAt: v.optional(v.number()),
    lastSuccessAt: v.optional(v.number()),
    lastError: v.optional(v.object({ message: v.string(), observedAt: v.number() })),
    observedAt: v.number(),
  }),
);
export type ServiceStatus = Infer<typeof serviceStatusValidator>;

export const health = query({
  // REQUIRED, not optional-with-a-Date.now()-fallback. An optional `now`
  // that defaults to `Date.now()` inside the handler is the exact anti-
  // pattern convex/_generated/ai/guidelines.md "Do not read the wall clock
  // inside a query" warns about: a recompute only happens when args or a
  // watched document change, not merely because time passed, so `stale`
  // would freeze at whatever was true at the last recompute instead of
  // tracking real time. Making the arg required forces every caller to
  // decide how it refreshes `now` — see `summary` above for the identical
  // fix: src/library/summaryApi.tsx and src/library/Library.tsx pass and
  // refresh `now` for both queries the same way.
  args: { now: v.number() },
  returns: v.array(serviceStatusValidator),
  handler: async (ctx, args): Promise<ServiceStatus[]> => {
    await user(ctx);
    const now = args.now;
    const out: ServiceStatus[] = [];
    for (const service of SERVICES) {
      const row = await ctx.db
        .query("serviceHealth")
        .withIndex("by_service", (q) => q.eq("service", service))
        .unique();
      if (!row) {
        out.push({ service, kind: "unknown" });
        continue;
      }
      const freshestAt = Math.max(row.lastHeartbeatAt ?? 0, row.observedAt);
      out.push({
        service,
        kind: "known",
        healthy: row.healthy,
        stale: now - freshestAt > SERVICE_STALE_AFTER_MS,
        lastHeartbeatAt: row.lastHeartbeatAt,
        lastSuccessAt: row.lastSuccessAt,
        lastError: row.lastError,
        observedAt: row.observedAt,
      });
    }
    return out;
  },
});
