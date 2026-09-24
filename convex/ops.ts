import { v, type Infer } from "convex/values";
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireOperator } from "./access";
import {
  historyBackfillStatusValidator,
  jobStatusValidator,
  kindValidator,
  pendingWorkUnitValidator,
  publicationStateValidator,
} from "./schema";
import {
  accountPublicationCandidates,
  allAccountJobs,
  currentPublication,
  latestHistoryWindowJob,
  resolveJobAccount,
} from "./lib/accounts";

/**
 * Read models for the operator dashboard at /ops (src/ops). Everything here
 * is derived from rows other modules already write; nothing is estimated.
 * A figure this app does not record is left out of the shape entirely, so
 * the UI has nothing to render for it but an explicit "not tracked yet".
 *
 * Operator-only, like convex/queue.ts `timeline`: these describe the whole
 * shared corpus and its search traffic, not the caller's own data.
 */

// Bounded reads (convex/_generated/ai/guidelines.md). Past a bound the
// response says `truncated` instead of presenting a partial total as whole.
const MAX_ACCOUNTS = 500;

const DAY_MS = 86_400_000;

const HOUR_MS = 3_600_000;

const MAX_RECEIPTS_24H = 5_000;

// Search sessions carry their result rows, so they are much heavier than
// receipts; this keeps one read well under the per-query byte budget.
const MAX_SESSIONS_24H = 200;

const MAX_JOBS_24H = 1_000;

const MAX_THROTTLES_24H = 200;

// Job kinds whose captures are posts. The others (profile, follow lists,
// archive inspection) produce profiles or metadata, not searchable posts.
const POST_KINDS: ReadonlySet<Doc<"jobs">["kind"]> = new Set(["bulk", "live", "post"]);

const runValidator = v.object({
  jobId: v.id("jobs"),
  status: jobStatusValidator,
  createdAt: v.number(),
  updatedAt: v.number(),
  refresh: v.boolean(),
  postsReceived: v.optional(v.number()),
  oldest: v.optional(v.string()),
  floorReached: v.optional(v.boolean()),
  phase: v.optional(v.string()),
  error: v.optional(v.string()),
  retryable: v.optional(v.boolean()),
});

const opsAccountValidator = v.object({
  accountId: v.id("accounts"),
  handle: v.string(),
  name: v.string(),
  avatar: v.optional(v.string()),
  // X's own join date and lifetime post count, when a profile fetch has
  // reported them. `joined` is how far back a complete history reaches.
  joined: v.optional(v.string()),
  statuses: v.optional(v.number()),
  publication: v.union(
    v.null(),
    v.object({
      state: publicationStateValidator,
      searchablePostCount: v.optional(v.number()),
      lastPublishedAt: v.optional(v.number()),
      lastError: v.optional(v.object({ message: v.string(), observedAt: v.number() })),
      pendingWork: v.optional(v.object({ unit: pendingWorkUnitValidator, count: v.number() })),
      updatedAt: v.number(),
    }),
  ),
  // Newest account-history run that was not dismissed, whatever its state.
  latestRun: v.optional(runValidator),
  // When a history import for this account last finished: the honest
  // "last refresh" time.
  lastCompletedAt: v.optional(v.number()),
  // The oldest post date any of this account's runs, or its deep-history
  // backfill, has reached. A date we collected back to, not a searchable
  // range: the indexer does not report per-account date ranges.
  oldestCollected: v.optional(v.string()),
  backfill: v.optional(
    v.object({
      status: historyBackfillStatusValidator,
      cursorUntil: v.string(),
      postsFound: v.number(),
      error: v.optional(v.string()),
    }),
  ),
  historyRun: v.optional(runValidator),
});

export type OpsAccount = Infer<typeof opsAccountValidator>;

function run(job: Doc<"jobs">) {
  return {
    jobId: job._id,
    status: job.status,
    createdAt: job._creationTime,
    updatedAt: job.updatedAt,
    refresh: job.refresh,
    postsReceived: job.postsReceived,
    oldest: job.oldest,
    floorReached: job.floorReached,
    phase: job.phase,
    error: job.error,
    retryable: job.retryable,
  };
}

function earlier(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;

  if (!b) return a;

  return a < b ? a : b;
}

export const accounts = query({
  args: { operatorToken: v.optional(v.string()) },
  returns: v.object({
    rows: v.array(opsAccountValidator),
    // More accounts, or more account imports, than one bounded read covers.
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requireOperator(ctx, args.operatorToken);

    // The `accounts` table, not the job history, is the list: an account
    // row exists only once a profile was pinned, and some deployments hold
    // accounts whose import runs were never recorded here.
    const accountRows = await ctx.db
      .query("accounts")
      .order("desc")
      .take(MAX_ACCOUNTS + 1);

    const accountsTruncated = accountRows.length > MAX_ACCOUNTS;
    const list = accountsTruncated ? accountRows.slice(0, MAX_ACCOUNTS) : accountRows;

    // Every account-history run, grouped by the account it resolves to.
    // One bounded scan plus cached identity lookups, the same resolution
    // convex/library.ts uses.
    const { jobs, truncated: jobsTruncated } = await allAccountJobs(ctx.db);
    const cache = new Map<string, Doc<"accounts"> | null>();
    const runsByAccount = new Map<Id<"accounts">, Doc<"jobs">[]>();

    for (const job of jobs) {
      const account = await resolveJobAccount(ctx.db, job, cache);

      if (!account) continue;
      const bucket = runsByAccount.get(account._id);

      if (bucket) bucket.push(job);
      else runsByAccount.set(account._id, [job]);
    }

    const [publications, backfills, historyJobs] = await Promise.all([
      Promise.all(
        list.map((a) => accountPublicationCandidates(ctx.db, a._id).then(currentPublication)),
      ),
      Promise.all(
        list.map((a) =>
          ctx.db
            .query("historyBackfills")
            .withIndex("by_account", (q) => q.eq("accountId", a._id))
            .first(),
        ),
      ),
      Promise.all(list.map((a) => latestHistoryWindowJob(ctx.db, a._id))),
    ]);

    const rows: OpsAccount[] = list.map((account, i) => {
      const runs = runsByAccount.get(account._id) ?? [];
      const visible = runs.filter((job) => job.dismissedAt === undefined);

      const latest = visible.reduce<Doc<"jobs"> | undefined>(
        (best, job) => (!best || job.updatedAt > best.updatedAt ? job : best),
        undefined,
      );

      const lastCompletedAt = runs
        .filter((job) => job.status === "complete")
        .reduce<number | undefined>((best, job) => Math.max(best ?? 0, job.updatedAt), undefined);

      const backfill = backfills[i];
      const historyJob = historyJobs[i];
      const publication = publications[i];

      // A backfill's `cursorUntil` is the boundary its next window starts
      // from, so everything after it has been walked. It counts only once a
      // window has actually run.
      const backfillReach =
        backfill && (backfill.postsFound > 0 || backfill.status === "complete")
          ? backfill.cursorUntil
          : undefined;

      const oldestCollected = runs.reduce<string | undefined>(
        (best, job) => earlier(best, job.oldest),
        backfillReach,
      );

      return {
        accountId: account._id,
        handle: account.handle,
        name: account.name,
        avatar: account.avatar,
        joined: account.joined,
        statuses: account.statuses,
        publication: publication
          ? {
              state: publication.state,
              searchablePostCount: publication.searchablePostCount,
              lastPublishedAt: publication.lastPublishedAt,
              lastError: publication.lastError
                ? {
                    message: publication.lastError.message,
                    observedAt: publication.lastError.observedAt,
                  }
                : undefined,
              pendingWork: publication.pendingWork,
              updatedAt: publication.updatedAt,
            }
          : null,
        latestRun: latest ? run(latest) : undefined,
        lastCompletedAt,
        oldestCollected: oldestCollected?.slice(0, 10),
        backfill: backfill
          ? {
              status: backfill.status,
              cursorUntil: backfill.cursorUntil,
              postsFound: backfill.postsFound,
              error: backfill.error,
            }
          : undefined,
        historyRun: historyJob ? run(historyJob) : undefined,
      };
    });

    return { rows, truncated: accountsTruncated || jobsTruncated };
  },
});

// --- Last-24-hour activity ---------------------------------------------

const hourValidator = v.object({
  start: v.number(),
  // Posts saved by imports this hour (receipts of post-producing jobs).
  posts: v.number(),
  // Records saved by profile and follow-list lookups this hour.
  other: v.number(),
});

const activityValidator = v.object({
  downloads: v.object({ hours: v.array(hourValidator), truncated: v.boolean() }),
  search: v.object({
    queries: v.number(),
    failed: v.number(),
    // Only searches run with "Stats for nerds" carry the search service's
    // own timing, so the latency figures cover that sample alone.
    timedSample: v.number(),
    medianMs: v.optional(v.number()),
    p95Ms: v.optional(v.number()),
    lastAt: v.optional(v.number()),
    truncated: v.boolean(),
  }),
  jobs: v.object({
    byKind: v.array(v.object({ kind: kindValidator, count: v.number() })),
    failed: v.number(),
    truncated: v.boolean(),
  }),
  throttles: v.object({ xmd: v.number(), truncated: v.boolean() }),
});

export type OpsActivity = Infer<typeof activityValidator>;

function percentile(sorted: number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined;

  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function downloadsByHour(ctx: QueryCtx, now: number) {
  const since = now - 24 * HOUR_MS;

  const receipts = await ctx.db
    .query("receipts")
    .withIndex("by_creation_time", (q) => q.gte("_creationTime", since))
    // Newest first, so a day over the cap drops its oldest batches.
    .order("desc")
    .take(MAX_RECEIPTS_24H + 1);

  const truncated = receipts.length > MAX_RECEIPTS_24H;
  // Oldest bucket first; the last one ends at `now`.
  const firstStart = Math.floor(now / HOUR_MS) * HOUR_MS - 23 * HOUR_MS;

  const hours = Array.from({ length: 24 }, (_, i) => ({
    start: firstStart + i * HOUR_MS,
    posts: 0,
    other: 0,
  }));

  const kinds = new Map<Id<"jobs">, Doc<"jobs">["kind"] | null>();

  for (const receipt of truncated ? receipts.slice(0, MAX_RECEIPTS_24H) : receipts) {
    let kind = kinds.get(receipt.jobId);

    if (kind === undefined) {
      kind = (await ctx.db.get(receipt.jobId))?.kind ?? null;
      kinds.set(receipt.jobId, kind);
    }

    const index = Math.floor((receipt._creationTime - firstStart) / HOUR_MS);

    if (index < 0 || index >= hours.length) continue;

    if (kind && POST_KINDS.has(kind)) hours[index].posts += receipt.records;
    else hours[index].other += receipt.records;
  }

  return { hours, truncated };
}

async function searchActivity(ctx: QueryCtx, now: number) {
  const sessions = await ctx.db
    .query("sessions")
    .withIndex("by_creation_time", (q) => q.gte("_creationTime", now - DAY_MS))
    .order("desc")
    .take(MAX_SESSIONS_24H + 1);

  const truncated = sessions.length > MAX_SESSIONS_24H;
  const sample = truncated ? sessions.slice(0, MAX_SESSIONS_24H) : sessions;

  const timings = sample
    .map((s) => s.stats?.api?.totalUs ?? s.stats?.backend.totalUs)
    .filter((us): us is number => us !== undefined)
    .map((us) => us / 1000)
    .sort((a, b) => a - b);

  // "Load more" starts another session with a page cursor; only a session
  // without one is a new query.
  const firstPages = sample.filter((s) => s.cursor === undefined);

  return {
    queries: firstPages.length,
    failed: firstPages.filter((s) => s.status === "failed").length,
    timedSample: timings.length,
    medianMs: percentile(timings, 50),
    p95Ms: percentile(timings, 95),
    lastAt: sample[0]?._creationTime,
    truncated,
  };
}

async function jobActivity(ctx: QueryCtx, now: number) {
  const jobs = await ctx.db
    .query("jobs")
    .withIndex("by_creation_time", (q) => q.gte("_creationTime", now - DAY_MS))
    .take(MAX_JOBS_24H + 1);

  const truncated = jobs.length > MAX_JOBS_24H;
  const counts = new Map<Doc<"jobs">["kind"], number>();
  let failed = 0;

  for (const job of truncated ? jobs.slice(0, MAX_JOBS_24H) : jobs) {
    counts.set(job.kind, (counts.get(job.kind) ?? 0) + 1);

    if (job.status === "failed" || job.status === "partial") failed += 1;
  }

  return {
    byKind: [...counts.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count),
    failed,
    truncated,
  };
}

async function throttleActivity(ctx: QueryCtx, now: number) {
  const events = await ctx.db
    .query("providerThrottleEvents")
    .withIndex("by_provider", (q) => q.eq("provider", "xmd"))
    .order("desc")
    .take(MAX_THROTTLES_24H + 1);

  const recent = events.filter((e) => e.observedAt >= now - DAY_MS);

  return {
    xmd: Math.min(recent.length, MAX_THROTTLES_24H),
    truncated: recent.length > MAX_THROTTLES_24H,
  };
}

export const activity = query({
  // `now` comes from the caller (guidelines: never read the wall clock in a
  // query); the dashboard passes its 30-second bucketed clock.
  args: { now: v.number(), operatorToken: v.optional(v.string()) },
  returns: activityValidator,
  handler: async (ctx, args): Promise<OpsActivity> => {
    await requireOperator(ctx, args.operatorToken);

    const [downloads, search, jobs, throttles] = await Promise.all([
      downloadsByHour(ctx, args.now),
      searchActivity(ctx, args.now),
      jobActivity(ctx, args.now),
      throttleActivity(ctx, args.now),
    ]);

    return { downloads, search, jobs, throttles };
  },
});
