import { v, type Infer } from "convex/values";
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { user } from "./access";
import { ACCOUNT_JOB_KIND, ownedAccountJobs, resolveJobAccount } from "./lib/accounts";
import { serviceValidator } from "./schema";
import {
  dashboardSummaryValidator,
  type Count,
  type DashboardSummary,
  type ProviderQueuedWork,
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


function knownCount(unit: Count["unit"], value: number): Count {
  return { kind: "known", unit, value };
}
function unknownCount(unit: Count["unit"]): Count {
  return { kind: "unknown", unit };
}

// --- Provider-reported queued work (to-do.md "Show queued-post counts only
// when known") ------------------------------------------------------------
// accountPublications.pendingWork is the indexer's own statement of what it
// still has outstanding for one account, in whichever unit it chose to
// report: jobs | captures | posts (convex/schema.ts
// pendingWorkUnitValidator, written by convex/publication.ts on any applied
// update). Three rules decide how it reaches the dashboard, and the first
// two are why it is three counts and not one number:
//
//   1. Units are never merged. Different accounts can report different units
//      in the same summary. Adding a capture count (files) to a post count
//      and calling the result "queued posts" would be precisely the "count
//      of files labelled as a count of posts" the bullet forbids, so each
//      unit is tallied and shown under its own label.
//   2. Silence is never zero. An account whose publication row carries no
//      pendingWork has told us nothing — an update that omits the field
//      means "nothing to say about outstanding work", not "there is none"
//      (convex/publication.ts, docs/publication-contract.md "omit when
//      unknown — never send a guessed count"). A unit no in-scope account
//      has ever reported is therefore "unknown". A unit some account DID
//      report on is "known", even when the tally is 0, because then someone
//      actually looked and said so.
//   3. Same owner scope as every other account-derived figure here: it is
//      computed in the one pass over the caller's own accounts below, off
//      the publication rows already being read, so it adds no extra read and
//      cannot describe an account this caller never imported.
type PendingWorkUnit = NonNullable<Doc<"accountPublications">["pendingWork"]>["unit"];
type PendingWorkTally = { reported: boolean; sum: number };

function emptyPendingWorkTallies(): Record<PendingWorkUnit, PendingWorkTally> {
  return {
    jobs: { reported: false, sum: 0 },
    captures: { reported: false, sum: 0 },
    posts: { reported: false, sum: 0 },
  };
}

// `reported`, never `sum > 0`, is what separates known from unknown here:
// "the indexer told us 0 posts are left" and "no account ever mentioned
// posts" are different claims and must not render as the same number.
function pendingWorkCount(unit: PendingWorkUnit, tally: PendingWorkTally): Count {
  return tally.reported ? knownCount(unit, tally.sum) : unknownCount(unit);
}

// --- Indexed posts / indexed people (owner-scoped) ----------------------
//
// Both totals are derived from the same account set convex/library.ts builds
// its rows from, so the "Indexed people" tile is exactly the length of the
// list it links to rather than a number that happens to look similar. The
// scan is bounded by one person's own imports; past that bound the totals
// report "unknown" instead of presenting a partial sum as a complete one.

async function computeAccountTotals(
  ctx: QueryCtx,
  accountIds: Id<"accounts">[],
): Promise<{
  indexedPosts: Count;
  indexedAccounts: Count;
  providerQueuedWork: ProviderQueuedWork;
}> {
  let sum = 0;
  let unknown = false;
  let searchableAccounts = 0;
  const pendingWork = emptyPendingWorkTallies();
  for (const accountId of accountIds) {
    // `.first()` rather than `.unique()`: by_account is not
    // uniqueness-enforced by the schema, and a second row for one account
    // would make `.unique()` throw and take the whole dashboard down rather
    // than degrade one number.
    const publication = await ctx.db
      .query("accountPublications")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first();
    if (!publication) continue;
    if (publication.state === "searchable") searchableAccounts += 1;
    if (publication.pendingWork !== undefined) {
      // Tallied under the unit it was reported in, never coerced into
      // another one. See "Provider-reported queued work" above.
      const tally = pendingWork[publication.pendingWork.unit];
      tally.reported = true;
      tally.sum += publication.pendingWork.count;
    }
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
    providerQueuedWork: {
      posts: pendingWorkCount("posts", pendingWork.posts),
      captures: pendingWorkCount("captures", pendingWork.captures),
      jobs: pendingWorkCount("jobs", pendingWork.jobs),
    },
  };
}

// --- Queue (owner-scoped via jobs.owner) ---------------------------------

async function ownedJobs(
  ctx: QueryCtx,
  owner: Id<"users">,
): Promise<{ jobs: Doc<"jobs">[]; truncated: boolean }> {
  // One past the bound, so a full page is distinguishable from a truncated
  // scan. Newest first: a bounded read that silently kept the OLDEST jobs
  // would describe a queue the owner no longer has.
  const scanned = await ctx.db
    .query("jobs")
    .withIndex("by_owner", (q) => q.eq("owner", owner))
    .order("desc")
    .take(MAX_OWNED_JOBS + 1);
  const truncated = scanned.length > MAX_OWNED_JOBS;
  return { jobs: truncated ? scanned.slice(0, MAX_OWNED_JOBS) : scanned, truncated };
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
    // An applied update whose reportedState is "failed" tells us the indexer
    // could NOT index those captures. Counting them as confirmed made them
    // vanish from "saved captures awaiting indexing" — the one number that
    // is supposed to show work still outstanding — so a capture that failed
    // to index looked identical to one that succeeded.
    if (update.outcome !== "applied" || update.reportedState === "failed") continue;
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
  // Shared with the caller rather than built locally: this function and the
  // owner-scoped totals resolve the same jobs to the same accounts, so a
  // second cache just paid for every one of those reads twice per load.
  accountCache: Map<string, Doc<"accounts"> | null>,
): Promise<Count> {
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
    const accountId = (await resolveJobAccount(ctx.db, job, accountCache))?._id ?? null;
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
  truncated: boolean,
  accountCache: Map<string, Doc<"accounts"> | null>,
): Promise<QueueBreakdown> {
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
  if (truncated)
    // More jobs than one bounded read covers, so every one of these counts
    // would be a partial presented as a total. A queue figure that is quietly
    // short is worse than one that admits it does not know.
    return {
      waitingDownloads: unknownCount("jobs"),
      activeDownloads: unknownCount("jobs"),
      savedCapturesAwaitingIndexing: unknownCount("captures"),
      failedRetryable: unknownCount("jobs"),
    };
  return {
    waitingDownloads: knownCount("jobs", waiting),
    activeDownloads: knownCount("jobs", active),
    savedCapturesAwaitingIndexing: await computeSavedCapturesAwaitingIndexing(
      ctx,
      bulkJobs,
      accountCache,
    ),
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
    const owned = await ownedJobs(ctx, owner);
    // One cache for the whole request: the queue's capture tally and the
    // owner-scoped totals below resolve the same jobs to the same accounts.
    const accountCache = new Map<string, Doc<"accounts"> | null>();
    const queue = await computeQueue(ctx, owned.jobs, owned.truncated, accountCache);
    // Resolved from the library-matching read, not from the queue's wider
    // all-kinds scan, so the "Indexed people" tile and the account list it
    // links to are computed over the same rows and cannot disagree.
    const accountIds: Id<"accounts">[] = [];
    const seen = new Set<Id<"accounts">>();
    const accountJobs = await ownedAccountJobs(ctx.db, owner);
    for (const job of accountJobs.jobs) {
      const accountId = (await resolveJobAccount(ctx.db, job, accountCache))?._id ?? null;
      if (accountId && !seen.has(accountId)) {
        seen.add(accountId);
        accountIds.push(accountId);
      }
    }
    // Truncation is the caller's fact, not part of summing: past the bound
    // none of these can honestly describe "every account this caller
    // imported", which is what the scope below claims — including the
    // queued-work totals, since the accounts we could not read may be the
    // ones with work outstanding.
    const { indexedPosts, indexedAccounts, providerQueuedWork } = accountJobs.truncated
      ? {
          indexedPosts: unknownCount("posts"),
          indexedAccounts: unknownCount("accounts"),
          providerQueuedWork: {
            posts: unknownCount("posts"),
            captures: unknownCount("captures"),
            jobs: unknownCount("jobs"),
          },
        }
      : await computeAccountTotals(ctx, accountIds);
    return {
      indexedPosts,
      indexedAccounts,
      queue,
      providerQueuedWork,
      // Everything above is scoped to this caller's own imports — see
      // computeAccountTotals. convex/lib/contracts.ts summaryScopeValidator's
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
        .withIndex("by_service_and_observed", (q) => q.eq("service", service))
      // Newest observation wins. `by_service` alone orders by nothing the
      // caller cares about, so `.first()` on it would return an arbitrary
      // row rather than the current reading.
      .order("desc")
        // `.first()`, not `.unique()`: by_service has no uniqueness
        // guarantee, and a duplicate row must not take the query down.
        .first();
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
