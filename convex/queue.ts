import { v, type Infer } from "convex/values";
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { user } from "./access";
import { jobStatusValidator, kindValidator, throttleProviderValidator } from "./schema";
import { ACCOUNT_JOB_KIND, resolveJobAccount } from "./lib/accounts";
import { activeThrottleUntil, loadProviderLimit } from "./limits";

/**
 * The operator Queue page's backend: "what is the worker going to do next,
 * and when" (convex/worker.ts `claimNext` is the actual claim logic this
 * mirrors). Read-only — this file never moves a job's status or writes
 * anything; it only narrates the same `jobs` rows convex/jobs.ts and
 * convex/worker.ts already own.
 *
 * Ordering mirrors `worker.claimNext`: at most one job is ever "running" (the
 * worker refuses to claim a second job while one is running), and among
 * queued jobs the worker claims whichever is both due (`readyAt <= now`) and
 * earliest — so sorting the queued set by its EFFECTIVE readyAt ascending
 * (an unset readyAt reads as 0, i.e. immediately due, exactly like
 * `worker.claimNext`'s `job.readyAt ?? 0`) already puts every ready job
 * ahead of every not-yet-ready one, without a separate "ready first" pass.
 * `claimNext` itself only scans its next 20 queued-by-creation-time
 * candidates rather than sorting the whole table by readyAt; this timeline
 * is an honest approximation of that intent (readyAt-ascending order) for
 * display, not a byte-for-byte replay of the scan cap.
 *
 * Terminal-but-retryable jobs (failed/partial/cancelled, still eligible for
 * `jobs.retry`) are not queued at all — nothing will touch them until a
 * person clicks Retry — so they are listed after every queued/running job,
 * oldest-decision-first (by `updatedAt` descending, i.e. most recently
 * stopped first), and their estimate chains after the active queue as the
 * honest worst case if someone retries them right now.
 */

// Bounded read (convex/_generated/ai/guidelines.md "never an unbounded
// scan"). Queued/running/terminal-retryable jobs are always a small,
// currently-relevant subset of the table, and this table's default order is
// `_creationTime` descending — recent-first — so a generous cap over the
// newest rows catches the entire live queue in ordinary operation; `truncated`
// admits when it might not have.
const QUEUE_SCAN_CAP = 2_000;

// How many recently-completed bulk jobs feed the seconds-per-page / pages-
// per-account medians. "The last ~30 completed bulk jobs" per the spec.
const ESTIMATE_SAMPLE_SIZE = 30;

// How far the completed-bulk-job scan is allowed to look for that sample —
// generous relative to ESTIMATE_SAMPLE_SIZE since not every bulk job in
// creation-time order is a completed one.
const ESTIMATE_SCAN_CAP = 400;

// Assumed seconds/page when no completed-import sample exists yet to derive
// one from. Never presented as a real observation — `estimateInputs.
// secondsPerPage` stays `undefined` whenever this fallback is the one
// actually used, so the UI can say "no estimate history yet" honestly
// instead of implying this number came from real imports.
const DEFAULT_SECONDS_PER_PAGE = 45;

export const waitReasonValidator = v.union(
  v.object({ kind: v.literal("running") }),
  v.object({ kind: v.literal("ready") }),
  // readyAt in the future because THIS app scheduled a retry/continuation
  // (convex/jobs.ts `finish`) — not because the provider itself is throttled.
  v.object({ kind: v.literal("backoff"), readyAt: v.number() }),
  // An observed provider throttle (convex/limits.ts) whose own reset/retry
  // time is still in the future — the provider, not our own backoff math, is
  // why this job has not moved.
  v.object({
    kind: v.literal("throttled"),
    provider: throttleProviderValidator,
    resetAt: v.number(),
  }),
  // Ready (or terminal-retryable) but something else is ahead of it in the
  // order the worker actually claims jobs.
  v.object({ kind: v.literal("behind"), aheadCount: v.number() }),
);

export type WaitReason = Infer<typeof waitReasonValidator>;

const timelineAccountValidator = v.object({
  accountId: v.id("accounts"),
  handle: v.string(),
  name: v.string(),
  avatar: v.optional(v.string()),
});

const timelineEstimateValidator = v.object({
  start: v.number(),
  finish: v.number(),
  // The same account's overall finish time — the moment its LAST job in the
  // current timeline is expected to be done — repeated on every one of that
  // account's entries so the UI can show "starts/done" per row and one
  // account-level "done" without a second lookup.
  accountFinish: v.optional(v.number()),
});

const timelineEntryValidator = v.object({
  jobId: v.id("jobs"),
  kind: kindValidator,
  input: v.string(),
  account: v.optional(timelineAccountValidator),
  status: jobStatusValidator,
  postsReceived: v.optional(v.number()),
  pages: v.optional(v.number()),
  pageAttempt: v.optional(v.number()),
  readyAt: v.optional(v.number()),
  phase: v.optional(v.string()),
  error: v.optional(v.string()),
  waitReason: waitReasonValidator,
  estimate: timelineEstimateValidator,
});

export type TimelineEntry = Infer<typeof timelineEntryValidator>;

const estimateInputsValidator = v.object({
  // `undefined` on either field means "no completed-import sample to derive
  // it from" — never a guessed number silently standing in for a real one.
  secondsPerPage: v.optional(v.number()),
  medianPages: v.optional(v.number()),
  sampleSize: v.number(),
});

export type EstimateInputs = Infer<typeof estimateInputsValidator>;

const timelineValidator = v.object({
  entries: v.array(timelineEntryValidator),
  estimateInputs: estimateInputsValidator,
  // True when a job is currently claimed and running.
  workerBusy: v.boolean(),
  // True when the QUEUE_SCAN_CAP whole-table scan hit its bound before
  // finishing — the entries above may be missing older queued/terminal jobs.
  truncated: v.boolean(),
});

export type Timeline = Infer<typeof timelineValidator>;

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * The last ~ESTIMATE_SAMPLE_SIZE *completed* bulk jobs with at least one
 * downloaded page, newest first. Bounded by ESTIMATE_SCAN_CAP over
 * `by_kind` (already the index convex/lib/accounts.ts uses for the exact
 * same "every bulk job" scan) rather than scanning the whole `jobs` table.
 */
async function loadEstimateSample(ctx: QueryCtx): Promise<Doc<"jobs">[]> {
  const sample: Doc<"jobs">[] = [];
  let scanned = 0;

  for await (const job of ctx.db
    .query("jobs")
    .withIndex("by_kind", (q) => q.eq("kind", ACCOUNT_JOB_KIND))
    .order("desc")) {
    if (++scanned > ESTIMATE_SCAN_CAP || sample.length >= ESTIMATE_SAMPLE_SIZE) break;

    if (job.status === "complete" && (job.pages ?? 0) > 0) sample.push(job);
  }

  return sample;
}

function computeEstimateInputs(sample: Doc<"jobs">[]): EstimateInputs {
  const secondsPerPageSamples: number[] = [];
  const pagesSamples: number[] = [];

  for (const job of sample) {
    const pages = job.pages ?? 0;

    if (pages <= 0) continue;
    pagesSamples.push(pages);
    // Wall time from creation to completion, across every requeue this job
    // went through — an approximation (it includes backoff/queue waiting
    // time, not pure download time), but the only duration this schema
    // actually has recorded per job.
    const durationSeconds = (job.updatedAt - job._creationTime) / 1000;

    if (durationSeconds > 0) secondsPerPageSamples.push(durationSeconds / pages);
  }

  return {
    secondsPerPage: median(secondsPerPageSamples),
    medianPages: median(pagesSamples),
    sampleSize: sample.length,
  };
}

/** Pages this job still needs, per the spec's estimation rule. */
function remainingPages(job: Doc<"jobs">, medianPages: number | undefined): number {
  const pages = job.pages ?? 0;

  if (job.kind === ACCOUNT_JOB_KIND) return Math.max(0, (medianPages ?? pages + 1) - pages);

  // Non-bulk kinds page by provider cursor, not by the bulk history medians
  // above. `floorReached` is this app's own signal for "the provider says
  // there is nothing more" (convex/schema.ts); when it has never been
  // reported, assume one more page is still outstanding rather than
  // guessing "done".
  if (job.floorReached === undefined) return 1;

  return job.floorReached ? 0 : 1;
}

/** Every job the worker will act on next, or that a person could retry. */
async function loadCandidateJobs(
  ctx: QueryCtx,
): Promise<{ jobs: Doc<"jobs">[]; truncated: boolean }> {
  const jobs: Doc<"jobs">[] = [];
  let scanned = 0;
  let truncated = false;

  for await (const job of ctx.db.query("jobs").order("desc")) {
    if (++scanned > QUEUE_SCAN_CAP) {
      truncated = true;
      break;
    }

    if (job.dismissedAt !== undefined) continue;

    const terminalRetryable =
      (job.status === "failed" || job.status === "partial") && job.retryable !== false;

    if (job.status === "queued" || job.status === "running" || terminalRetryable) jobs.push(job);
  }

  return { jobs, truncated };
}

export const timeline = query({
  args: { now: v.number() },
  returns: timelineValidator,
  handler: async (ctx, args): Promise<Timeline> => {
    await user(ctx);
    const now = args.now;

    // Reuses convex/limits.ts's own `loadProviderLimit`/`activeThrottleUntil`
    // (the exact pair convex/jobs.ts `retry` reuses too) rather than a
    // second, independent read of `providerThrottleEvents` that could
    // disagree with the dashboard's own "Provider limits" panel or with what
    // a manual retry actually schedules. Every job kind fetches through
    // x.md (convex/lib/xmd.ts), so that is the one provider whose throttle
    // state matters here — "receiver"/"search" are about this app's own
    // services, not a job's own calls.
    const [{ jobs, truncated }, sample, xmdLimit] = await Promise.all([
      loadCandidateJobs(ctx),
      loadEstimateSample(ctx),
      loadProviderLimit(ctx, "xmd"),
    ]);

    const xmdThrottleUntil = activeThrottleUntil(xmdLimit, now);

    const estimateInputs = computeEstimateInputs(sample);

    const running = jobs.filter((j) => j.status === "running");

    const queued = jobs
      .filter((j) => j.status === "queued")
      .sort((a, b) => (a.readyAt ?? 0) - (b.readyAt ?? 0));

    const terminalRetryable = jobs
      .filter((j) => j.status === "failed" || j.status === "partial")
      .sort((a, b) => b.updatedAt - a.updatedAt);

    // The exact order the worker will take them: running first (there is
    // never more than one in practice — worker.claimNext refuses a second
    // claim while one is running), then queued by effective readyAt
    // ascending (which already puts every due job ahead of every not-yet-due
    // one). Terminal-but-retryable jobs are not queued at all; they are
    // appended after, since nothing acts on them without a person clicking
    // Retry first.
    const ordered = [...running, ...queued, ...terminalRetryable];

    // One resolved-account cache for the whole request — several jobs can
    // resolve to the same account (e.g. a bulk job and an older profile
    // job for the same handle).
    const accountCache = new Map<string, Doc<"accounts"> | null>();

    let aheadCount = 0;
    let sawUnready = false; // once true, everything after is "behind" too
    let cursor = now; // the running chain of "nothing starts before this"
    const entries: TimelineEntry[] = [];
    const accountFinish = new Map<Id<"accounts">, number>();

    for (const job of ordered) {
      const account = await resolveJobAccount(ctx.db, job, accountCache);

      let waitReason: WaitReason;

      if (job.status === "running") {
        waitReason = { kind: "running" };
      } else if (job.status === "failed" || job.status === "partial") {
        // Terminal-but-retryable: nothing is "ahead of it" in the queued
        // sense, but it also is not next — a person has to act on it first.
        waitReason =
          xmdThrottleUntil !== undefined
            ? { kind: "throttled", provider: "xmd", resetAt: xmdThrottleUntil }
            : { kind: "behind", aheadCount };
      } else {
        const effectiveReadyAt = job.readyAt ?? 0;
        const ready = effectiveReadyAt <= now;

        if (!ready) {
          sawUnready = true;
          waitReason =
            xmdThrottleUntil !== undefined && xmdThrottleUntil >= effectiveReadyAt
              ? { kind: "throttled", provider: "xmd", resetAt: xmdThrottleUntil }
              : { kind: "backoff", readyAt: effectiveReadyAt };
        } else if (aheadCount === 0 && !sawUnready) {
          // Nothing running and nothing ahead of it: this is what the
          // worker claims next, unless the provider itself is currently
          // throttled (in which case claiming it just re-fails instantly).
          waitReason =
            xmdThrottleUntil !== undefined
              ? { kind: "throttled", provider: "xmd", resetAt: xmdThrottleUntil }
              : { kind: "ready" };
        } else {
          waitReason = { kind: "behind", aheadCount };
        }
      }

      const start = Math.max(
        cursor,
        now,
        job.status === "queued" ? (job.readyAt ?? 0) : now,
        waitReason.kind === "throttled" ? waitReason.resetAt : now,
      );

      const remaining = remainingPages(job, estimateInputs.medianPages);
      const secondsPerPage = estimateInputs.secondsPerPage ?? DEFAULT_SECONDS_PER_PAGE;
      const finish = start + remaining * secondsPerPage * 1000;

      cursor = finish;
      aheadCount += 1;

      if (account) accountFinish.set(account._id, finish);

      entries.push({
        jobId: job._id,
        kind: job.kind,
        input: job.input,
        account: account
          ? {
              accountId: account._id,
              handle: account.handle,
              name: account.name,
              avatar: account.avatar,
            }
          : undefined,
        status: job.status,
        postsReceived: job.postsReceived,
        pages: job.pages,
        pageAttempt: job.pageAttempt,
        readyAt: job.readyAt,
        phase: job.phase,
        error: job.error,
        waitReason,
        estimate: { start, finish, accountFinish: undefined },
      });
    }

    // Second pass: now that every job's finish time is known, stamp each
    // entry with its OWN account's overall finish (the last of that
    // account's entries in this timeline) — see timelineEstimateValidator's
    // `accountFinish` doc comment.
    const withAccountFinish = entries.map((entry) => {
      if (!entry.account) return entry;
      const finish = accountFinish.get(entry.account.accountId);

      return finish === undefined
        ? entry
        : { ...entry, estimate: { ...entry.estimate, accountFinish: finish } };
    });

    return {
      entries: withAccountFinish,
      estimateInputs,
      workerBusy: running.length > 0,
      truncated,
    };
  },
});
