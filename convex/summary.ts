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
// A global sum this way is a real, documented tradeoff (this scans up to
// MAX_PUBLICATIONS accountPublications rows, not literally "every account
// that will ever exist") — the same tradeoff convex/library.ts already
// accepts for its own owner-scoped job list, and the one
// docs/publication-contract.md itself names for `savedCapturesAwaitingIndexing`
// ("a denormalized per-capture status table is a reasonable future addition
// — not built now"). If this table outgrows these caps, the fix is
// `@convex-dev/aggregate` (convex guidelines "Query guidelines"), not a
// larger constant.
const MAX_PUBLICATIONS = 5_000;
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

// --- Indexed posts / indexed people (global scope; accountPublications has
// no owner field — see convex/lib/contracts.ts summaryScopeValidator: only
// { kind: "global" } is meaningful until to-do.md P1's authorized/scoped
// collection access is built) -------------------------------------------
//
// IMPORTANT, tested limitation (tests/summary.test.ts "indexedAccounts is
// GLOBAL, not owner-scoped"): because this scans every accountPublications
// row with no owner filter, `indexedAccounts`/`indexedPosts` can report
// accounts a given caller cannot see in their own convex/library.ts `rows`
// query (which IS owner-scoped, to that owner's own bulk jobs). A caller
// with zero imports of their own can see a nonzero indexedAccounts here while
// `library.rows` returns `[]` for them. This is not this file inventing a
// number — every value returned is still true for the stated `{ kind:
// "global" }` scope in DashboardSummary.scope, which is the frozen contract's
// own signal to the UI that this total is NOT scoped to the caller and must
// not be presented as "click through to your account list". Do not treat
// this total as addressable/linkable to one caller's own library rows until
// to-do.md P1 lands real per-owner scoping — that requires schema changes
// (an owner field on accounts/accountPublications) outside this unit's
// owned files (convex/summary.ts, tests/summary.test.ts).

async function computeIndexTotals(
  ctx: QueryCtx,
): Promise<{ indexedPosts: Count; indexedAccounts: Count }> {
  const publications = await ctx.db.query("accountPublications").take(MAX_PUBLICATIONS);
  let sum = 0;
  let unknown = false;
  let searchableAccounts = 0;
  for (const publication of publications) {
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
    // "searchable" (convex/lib/contracts.ts dashboardSummaryValidator
    // comment). Deliberately narrower than indexedPosts above: an account
    // that regressed to "failed" still contributes its old post count to
    // indexedPosts but is not counted here, since it is not currently
    // indexed.
    indexedAccounts: knownCount("accounts", searchableAccounts),
  };
}

// --- Queue (owner-scoped: jobs.owner is the only place user ownership
// actually exists in this schema — accounts/accountPublications are shared
// across owners today, see computeIndexTotals above) ----------------------

async function ownedJobs(ctx: QueryCtx, owner: Id<"users">): Promise<Doc<"jobs">[]> {
  return ctx.db
    .query("jobs")
    .withIndex("by_owner", (q) => q.eq("owner", owner))
    .take(MAX_OWNED_JOBS);
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
  const found =
    providerAccountId !== undefined
      ? await ctx.db
          .query("accounts")
          .withIndex("by_user_id", (q) => q.eq("userId", providerAccountId))
          .unique()
      : await ctx.db
          .query("accounts")
          .withIndex("by_handle", (q) => q.eq("handle", job.input))
          .unique();
  const id = found?._id ?? null;
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

async function computeQueue(ctx: QueryCtx, owner: Id<"users">): Promise<QueueBreakdown> {
  const jobs = await ownedJobs(ctx, owner);
  let waiting = 0;
  let active = 0;
  let failedRetryable = 0;
  const bulkJobs: Doc<"jobs">[] = [];
  for (const job of jobs) {
    if (job.status === "queued") waiting += 1;
    else if (job.status === "running") active += 1;
    // Exactly "failed" | "partial" (a person can retry these — see
    // convex/jobs.ts retry) — deliberately NOT "cancelled", which is a
    // person's own choice, not a failure to surface as retryable.
    // convex/lib/contracts.ts queueBreakdownValidator comment.
    else if (job.status === "failed" || job.status === "partial") failedRetryable += 1;
    if (job.kind === ACCOUNT_JOB_KIND) bulkJobs.push(job);
  }
  return {
    waitingDownloads: knownCount("jobs", waiting),
    activeDownloads: knownCount("jobs", active),
    savedCapturesAwaitingIndexing: await computeSavedCapturesAwaitingIndexing(ctx, bulkJobs),
    failedRetryable: knownCount("jobs", failedRetryable),
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
  // COORDINATION NOTE for whoever wires this up outside this unit's owned
  // files (convex/summary.ts, tests/summary.test.ts): src/library/
  // summaryApi.tsx currently types `summaryQuery`'s args as
  // `Record<string, never>` and src/library/Library.tsx calls it as
  // `useQuery(summaryQuery, isAuthenticated ? {} : "skip")` — neither passes
  // `now`. Making this arg required does not, by itself, make tsc catch that
  // mismatch (summaryApi.tsx's FunctionReference type is hand-written, not
  // generated from this validator), so that calling code will fail at
  // RUNTIME (Convex will reject the missing required arg) until both files
  // are updated together to pass `{ now: Date.now() }` and refresh it (e.g.
  // `useState`/`setInterval`). This is a required follow-up, not an
  // optional cleanup — flagged here and in this unit's handoff notes.
  args: { now: v.number() },
  returns: dashboardSummaryValidator,
  handler: async (ctx, args): Promise<DashboardSummary> => {
    // Authenticated backend contract only — no raw state files, service
    // credentials, or private logs are read anywhere in this file; every
    // returned field is exactly a Count, a timestamp, or the fixed "global"
    // scope literal.
    const owner = await user(ctx);
    const { indexedPosts, indexedAccounts } = await computeIndexTotals(ctx);
    const queue = await computeQueue(ctx, owner);
    return {
      indexedPosts,
      indexedAccounts,
      queue,
      // Only "global" is meaningful today — convex/lib/contracts.ts
      // summaryScopeValidator's "account" variant is reserved for to-do.md
      // P1's authorized/scoped collection access, not wired to anything
      // yet. Not implemented here; see that file's comment.
      scope: { kind: "global" },
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
  // inside a query" warns about: whenever the caller omits it (as src/
  // library/Library.tsx does today, passing `{}`), this query would still
  // read the wall clock on every recompute — but a recompute only happens
  // when args or a watched document change, not merely because time passed,
  // so `stale` would freeze at whatever was true at the last recompute
  // instead of tracking real time. Making the arg required forces every
  // caller to decide how it refreshes `now` (e.g. an interval that bumps a
  // piece of state and re-passes it), rather than silently getting a wrong
  // answer. See convex/summary.ts's `summary` query above for the identical
  // fix and the same coordination note: src/library/summaryApi.tsx and src/
  // library/Library.tsx (not owned by this unit) still pass no `now` and
  // must be updated to do so, or the live query will start rejecting the
  // missing required arg at runtime.
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
