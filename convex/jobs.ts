import { Match } from "effect";
import { v, ConvexError } from "convex/values";
import { query, mutation, internalMutation } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { kindValidator, throttleProviderValidator } from "./schema";
import schema from "./schema";
import { user, requireOperator } from "./access";
import { activeThrottleUntil, loadProviderLimitForOperations } from "./limits";
import { handle, statusUrl } from "./lib/xmd";
import { canonicalQuery } from "./lib/search";
import { ACCOUNT_JOB_KIND, canonicalAccountForUserId } from "./lib/accounts";

// Every filter a caller cares about is applied BEFORE the limit, by streaming
// every job newest-first and stopping once enough eligible ones are found.
// Taking a fixed page and filtering afterwards silently shortens the feed:
// 20 dismissed runs, or 20 account imports when the caller only wants the
// other kinds, would hide older rows that should have been shown.
// `scanned` bounds the read (Convex guidelines: never an unbounded scan);
// reaching it means there are thousands of jobs newer than the next eligible
// one, which is not a case worth paginating a dashboard feed for.
//
// The imported corpus is shared infrastructure, not personal data (to-do.md,
// convex/lib/search.ts): this reads across every owner, not just the
// caller's own jobs. `jobs.owner` still records who started each run (an
// audit trail); it is no longer a visibility boundary here. No index needed
// for the whole-table scan below — it is ordered by `_creationTime`, Convex's
// default table order, the same as an indexed `.order("desc")` would give.
const JOB_FEED_SCAN = 2_000;

const JOB_FEED_LIMIT = 20;

// Which kinds a caller wants. "account" is the full-history import that owns
// a library row; "other" is everything else (live search, single post,
// profile, follower/following lookups) — the split src/Dashboard.tsx's
// "Other imports" feed and convex/library.ts already draw.
const jobScopeValidator = v.union(v.literal("all"), v.literal("other"));

export const list = query({
  args: {
    includeDismissed: v.optional(v.boolean()),
    scope: v.optional(jobScopeValidator),
  },
  returns: v.object({
    jobs: v.array(schema.doc("jobs")),
    // True when the whole-table scan hit JOB_FEED_SCAN before filling the
    // page, i.e. this feed page may be missing older eligible jobs. NOT set
    // just because the page filled up (that is a complete, ordinary page) —
    // same distinction convex/library.ts `rows` makes with its own
    // `truncated`.
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    // Authenticated callers only; every signed-in caller sees the same
    // shared feed, so nothing about the identity narrows what comes back.
    await user(ctx);
    const scope = args.scope ?? "all";
    const out: Doc<"jobs">[] = [];
    let scanned = 0;
    let truncated = false;

    for await (const job of ctx.db.query("jobs").order("desc")) {
      if (++scanned > JOB_FEED_SCAN) {
        truncated = true;
        break;
      }

      if (!args.includeDismissed && job.dismissedAt !== undefined) continue;

      if (scope === "other" && job.kind === ACCOUNT_JOB_KIND) continue;
      out.push(job);

      if (out.length >= JOB_FEED_LIMIT) break;
    }

    return { jobs: out, truncated };
  },
});

// Local upgrade: recover display statistics from an already-acknowledged capture.
export const restoreSummary = internalMutation({
  args: {
    jobId: v.id("jobs"),
    captureId: v.string(),
    posts: v.number(),
    oldest: v.optional(v.string()),
    floorReached: v.boolean(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);

    if (!job || job.kind !== "bulk" || job.status !== "complete" || job.postsReceived !== undefined)
      return;

    const receipt = await ctx.db
      .query("receipts")
      .withIndex("by_capture", (q) => q.eq("jobId", job._id).eq("captureId", args.captureId))
      .unique();

    if (!receipt || !Number.isInteger(args.posts) || args.posts < 0 || args.posts > 500)
      throw new Error("Invalid saved batch summary");
    await ctx.db.patch(job._id, {
      postsReceived: args.posts,
      pages: 1,
      oldest: args.oldest,
      floorReached: args.floorReached,
    });
  },
});

// One search, one label. `from:theo`, `@Theo` and `@theo` all mean the same
// thing to parseQuery, but `start` used to store the raw text verbatim, so
// the same live search appeared in the job feed under three different names
// AND slipped past the already-active guard below, which matches on this
// exact string. Canonical form is `@handle rest-of-query` with a lowercased
// handle, so repeats collide instead of piling up.
function canonicalLiveQuery(raw: string): string {
  try {
    return canonicalQuery(raw).canonical;
  } catch (error) {
    // parseQuery throws plain Errors with copy already written for a person
    // ("Search one author at a time...", "Use @handle to filter authors...").
    // Re-throw as ConvexError so the browser shows that text instead of a
    // generic server-error string.
    throw new ConvexError(error instanceof Error ? error.message : "Enter a valid search.");
  }
}

/**
 * How long an identical request is answered with the run that was already
 * made rather than a new one. Long enough to absorb a double-click and a
 * "did that work?" retry, short enough that a deliberate re-run is never
 * mistaken for one.
 */
const REPEAT_WINDOW_MS = 60_000;

/**
 * `HH:MM` in UTC, for `retry`'s "Retry queued for …" phase text. Explicit
 * UTC rather than the server's default locale/timezone (which this backend
 * has no control over and should not depend on) — the dashboard's primary
 * "Retrying automatically at …" display (src/library/AccountRow.tsx)
 * already formats `readyAt` in the viewer's own local time; this is only
 * the supplementary "Last phase" text in a run's expanded history.
 */
function utcHHMM(at: number): string {
  const date = new Date(at);

  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")} UTC`;
}

/**
 * The x.md operation name(s) (convex/lib/xmd.ts's `operation` — the string
 * `providerThrottleEvents.operation` is recorded under) that this job's
 * NEXT attempt will call. Matches convex/lib/collect.ts's own dispatch:
 * "live" reads under "search", every other read kind reads under its own
 * name, and "bulk" calls "profile" first (to pin identity) and then
 * "history" (json, this Convex action's own path — see collect.ts's
 * `historyPage`) or "bulk" (ndjson, the outbound worker's own streaming
 * path) once identity is already pinned. `job.expectedUserId` being set is
 * exactly the signal collect.ts itself uses to know identity is already
 * pinned, so a "bulk" job with one only re-reads "profile" if something
 * upstream forces it to — which does not happen — so both later operations
 * are included as candidates rather than guessing which format this run
 * used (convex/jobs.ts never stores that; see collect.ts's `historyPage`
 * grouping "history"/"bulk" under the same timeout for the same reason).
 *
 * Used only to scope a manual retry's throttle check (CodeRabbit
 * #4091329853) to the call this specific job is actually about to make,
 * not the provider's single most recent event across every operation.
 */
function nextXmdOperations(job: Pick<Doc<"jobs">, "kind" | "expectedUserId">): string[] {
  if (job.kind === "bulk") return job.expectedUserId ? ["history", "bulk"] : ["profile"];

  return [job.kind === "live" ? "search" : job.kind];
}

export const start = mutation({
  args: {
    kind: kindValidator,
    input: v.string(),
    since: v.optional(v.string()),
    refresh: v.optional(v.boolean()),
    previous: v.optional(v.id("jobs")),
    operatorToken: v.optional(v.string()),
  },
  returns: v.id("jobs"),
  handler: async (ctx, args) => {
    // Starting any kind of import spends provider allowance (x.md, and via
    // the raw-capture handoff). Per the authorization-boundary decision,
    // this requires a signed-in OPERATOR (the operator build's own token, or
    // a verified email on OPERATOR_EMAILS as a fallback — convex/access.ts),
    // not merely a signed-in session — an anonymous guest with neither is
    // refused here. `owner` below is still written purely as an audit trail
    // of who started the run, not a visibility boundary.
    const owner = await requireOperator(ctx, args.operatorToken);
    const outbound = process.env.COLLECTOR_MODE === "outbound";

    const worker = outbound
      ? await ctx.db
          .query("collector")
          .withIndex("by_name", (q) => q.eq("name", "desktop"))
          .unique()
      : null;

    if (outbound && (!worker?.online || Date.now() - worker.lastSeen > 45_000))
      throw new ConvexError(
        "The download worker is offline. Imports will resume when it reconnects.",
      );

    if (!process.env.X_MD_API_KEY || (!outbound && !process.env.RAW_CAPTURE_URL))
      throw new ConvexError(
        "Connect x.md and the raw-capture receiver before starting an indexing job.",
      );

    const input = Match.value(args.kind).pipe(
      Match.when("live", () => canonicalLiveQuery(args.input)),
      Match.when("post", () => statusUrl(args.input)),
      Match.orElse(() => handle(args.input)),
    );

    if (!input || input.length > 300) throw new ConvexError("Enter a search under 300 characters.");

    if (
      args.since &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(args.since) || !Number.isFinite(Date.parse(args.since)))
    )
      throw new ConvexError("Choose a valid start date.");
    // Ownership is deliberately not part of this check any more: the
    // imported corpus is shared, so a continuation is valid regardless of
    // who started the run it continues. Existence, input, and kind still
    // must match — a continuation is only ever the SAME request picking up
    // where it left off.
    const previous = args.previous ? await ctx.db.get(args.previous) : null;

    if (args.previous && (!previous || previous.input !== input || previous.kind !== args.kind))
      throw new ConvexError("Continuation does not belong to this indexing job.");

    // A second click is not a second import.
    //
    // This only ever refused a *concurrent* duplicate (below), so the instant
    // a run finished an identical one became a fresh row. Production shows
    // exactly that: four "from:theo" live searches 11 to 15 seconds apart,
    // each returning nothing — someone clicking again because nothing
    // visible had happened. Inside this window an identical request gets
    // back the run it already made.
    //
    // Idempotency, not a quota: nothing is refused, nothing is capped, and
    // no allowance is tracked (the self-imposed budgets were deleted in #12
    // and are not coming back). A deliberate re-run a minute later starts a
    // real import. An explicit continuation is never collapsed — it carries
    // a different cursor, which is the whole point of "Get next page".
    //
    // This lookup is global by kind+input, not per-owner: the imported
    // corpus is shared, so a duplicate request from ANY caller answers with
    // the run that already exists rather than starting a second one, the
    // same as a duplicate from the same person. `by_input` (kind, input,
    // status) already exists for the concurrent-duplicate guard below;
    // reused here with only its first two columns bound, which is a valid
    // partial-prefix query on the same index rather than a new one.
    if (!args.previous) {
      const recent = await ctx.db
        .query("jobs")
        .withIndex("by_input", (q) => q.eq("kind", args.kind).eq("input", input))
        .order("desc")
        .first();

      if (
        recent &&
        // Never a stopped run. A failed/partial/cancelled job has nothing
        // scheduled behind it, so handing its id back would answer "start
        // this import" by doing nothing at all — and those are exactly the
        // statuses the UI offers "Retry import" for.
        (recent.status === "queued" ||
          recent.status === "running" ||
          recent.status === "complete") &&
        Date.now() - recent._creationTime < REPEAT_WINDOW_MS &&
        recent.since === args.since &&
        recent.refresh === (args.refresh ?? false)
      )
        return recent._id;
    }

    for (const status of ["running", "queued"] as const) {
      if (
        await ctx.db
          .query("jobs")
          .withIndex("by_input", (q) =>
            q.eq("kind", args.kind).eq("input", input).eq("status", status),
          )
          .first()
      )
        throw new ConvexError("This indexing job is already active.");
    }

    // A handle can be released on X and claimed by a different real account,
    // so `by_handle` is not unique and `.unique()` would throw outright. Two
    // matches means the handle is genuinely ambiguous: seed no identity and
    // let the run pin its own via `pinIdentity`, rather than guessing one.
    const candidates =
      args.kind === "bulk"
        ? await ctx.db
            .query("accounts")
            .withIndex("by_handle", (q) => q.eq("handle", input))
            .take(2)
        : [];

    const account = candidates.length === 1 ? candidates[0] : null;

    const id = await ctx.db.insert("jobs", {
      owner,
      kind: args.kind,
      input,
      since: previous?.since ?? args.since,
      until: previous?.nextUntil,
      cursor: previous?.nextCursor,
      refresh: args.refresh ?? false,
      autoContinue: args.kind === "bulk",
      pages: 0,
      postsReceived: 0,
      expectedUserId: previous?.expectedUserId ?? account?.userId,
      status: "queued",
      count: 0,
      attempt: 0,
      warnings: [],
      updatedAt: Date.now(),
    });

    await ctx.scheduler.runAfter(0, internal.importer.run, { jobId: id });

    return id;
  },
});

export const claim = internalMutation({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, { jobId }) => {
    const job = await ctx.db.get(jobId);

    if (!job || job.status !== "queued" || (job.readyAt ?? 0) > Date.now()) return null;
    const attempt = job.attempt + 1;
    await ctx.db.patch(jobId, {
      status: "running",
      attempt,
      pageAttempt: (job.pageAttempt ?? 0) + 1,
      updatedAt: Date.now(),
      error: undefined,
      retryable: undefined,
    });
    await ctx.scheduler.runAfter(600_000, internal.jobs.expire, {
      jobId,
      attempt,
    });

    return { ...job, attempt };
  },
});

export const progress = internalMutation({
  args: { jobId: v.id("jobs"), attempt: v.number(), phase: v.string() },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);

    if (!job || job.status !== "running" || job.attempt !== args.attempt)
      throw new Error("Job is no longer active.");
    await ctx.db.patch(job._id, { phase: args.phase, updatedAt: Date.now() });
  },
});

// Load a job, requiring the caller pass `auth`. Jobs are shared
// infrastructure, not personal data (to-do.md): any caller `auth` admits may
// act on any job, not only the one they started. `job.owner` still records
// who started it (an audit trail); it is no longer a permission check.
//
// `auth` is `user` for read-only or already-stopped-work paths and
// `requireOperator` for anything that starts, resumes, or would otherwise
// let a job keep spending provider allowance — see the authorization-
// boundary decision in convex/access.ts.
async function sharedJob(
  ctx: QueryCtx | MutationCtx,
  jobId: Id<"jobs">,
  auth: (ctx: QueryCtx | MutationCtx) => Promise<Id<"users">> = user,
) {
  await auth(ctx);
  const job = await ctx.db.get(jobId);

  if (!job) throw new ConvexError("Job not found.");

  return job;
}

export const cancel = mutation({
  args: { jobId: v.id("jobs"), operatorToken: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { jobId, operatorToken }) => {
    const job = await sharedJob(ctx, jobId, (c) => requireOperator(c, operatorToken));

    if (!["queued", "running"].includes(job.status)) return null;
    await ctx.db.patch(jobId, {
      status: "cancelled",
      phase: "Stopped; an in-flight request may still finish. Retained captures are not deleted.",
      updatedAt: Date.now(),
    });

    return null;
  },
});

export const retry = mutation({
  args: { jobId: v.id("jobs"), operatorToken: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { jobId, operatorToken }) => {
    const job = await sharedJob(ctx, jobId, (c) => requireOperator(c, operatorToken));

    if (!["failed", "partial", "cancelled"].includes(job.status))
      throw new ConvexError("Only stopped or failed jobs can be retried.");

    // A provider 4xx like "invalid_thread"/"not_found" fails the exact same
    // way on every attempt — src/JobRow.tsx already hides the Retry button
    // for these, but this is the actual boundary: a repeat request against a
    // permanent failure spends another provider call to learn nothing new.
    if ((job.status === "failed" || job.status === "partial") && job.retryable === false)
      throw new ConvexError("x.md can't fetch this. Retrying will not change the result.");

    for (const status of ["queued", "running"] as const) {
      const active = await ctx.db
        .query("jobs")
        .withIndex("by_input", (q) =>
          q.eq("kind", job.kind).eq("input", job.input).eq("status", status),
        )
        .first();

      if (active) throw new ConvexError("This indexing job is already active.");
    }

    // Every job kind fetches through x.md (convex/lib/xmd.ts), so that is
    // the one provider whose throttle state a manual retry needs to check —
    // "receiver"/"search" are about this app's own services, not the
    // provider a job's own calls go through. Scoped to the operation(s)
    // THIS job will actually call next (`nextXmdOperations`), not the
    // provider's single most recent event across every operation
    // (CodeRabbit #4091329853): an unrelated job's "search" throttle must
    // not delay a "history" retry just because both happen to go through
    // x.md. This respects a provider-reported limit, the one kind
    // AGENTS.md's "Rate limiting" section allows — it adds no self-imposed
    // cap.
    const now = Date.now();
    const limit = await loadProviderLimitForOperations(ctx, "xmd", nextXmdOperations(job));
    const throttledUntil = activeThrottleUntil(limit, now);
    const readyAt = throttledUntil ?? 0;

    await ctx.db.patch(jobId, {
      status: "queued",
      readyAt,
      error: undefined,
      retryable: undefined,
      phase:
        throttledUntil === undefined
          ? "Retry queued"
          : `Retry queued for ${utcHHMM(throttledUntil)}`,
      updatedAt: now,
    });
    // Scheduled for the same instant `readyAt` allows a claim (convex/jobs.ts
    // `claim` already refuses one before then): re-hitting x.md before the
    // provider's own reset/retry-after time would just fail the same way
    // again, so there is nothing to gain from firing this any sooner.
    await ctx.scheduler.runAfter(Math.max(0, readyAt - now), internal.importer.run, { jobId });

    return null;
  },
});

// --- Dismissing finished runs ------------------------------------------
// A person could stop a run and retry it, but never clear it: the feed grew
// forever and a pile of old failures buried everything current. Dismissing
// HIDES a terminal run from the job feed and the retryable-work counter. It
// deletes nothing — the job document and its `receipts` (the proof a capture
// was durably stored) stay exactly as they were, and `restore` brings the
// row back — so it does not violate to-do.md's "do not delete records just
// to hide duplicates".
export const dismiss = mutation({
  args: { jobId: v.id("jobs"), operatorToken: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { jobId, operatorToken }) => {
    const job = await sharedJob(ctx, jobId, (c) => requireOperator(c, operatorToken));

    // Deliberately refuses queued/running work: hiding a run that is still
    // spending provider allowance would make it unstoppable from the UI.
    // Stop it first, then dismiss it.
    if (job.status === "queued" || job.status === "running")
      throw new ConvexError("Stop this run before dismissing it.");

    if (job.dismissedAt !== undefined) return null;
    await ctx.db.patch(jobId, { dismissedAt: Date.now() });

    return null;
  },
});

// A duplicate-input group (src/jobText.ts `dedupeJobsByInput`) can hold more
// runs than any one page of `jobs.list` (JOB_FEED_LIMIT) ever returns, and
// with 21+ of them for the same kind+input, a client that only knows the ids
// on its current page can dismiss those and nothing else — the next-newest
// run outside that page then resurfaces on the very next render instead of
// the group actually clearing (found on 4144bcd, which dismissed by id from
// `dedupeJobsByInput`'s own `earlierIds`, itself bounded by the same page).
// This walks every job for the exact (kind, input) server-side instead, so
// the count of terminal runs dismissed is never limited by what the caller
// happened to have loaded.
const DISMISS_INPUT_SCAN = 2_000;

export const dismissInput = mutation({
  args: { kind: kindValidator, input: v.string(), operatorToken: v.optional(v.string()) },
  returns: v.number(),
  handler: async (ctx, { kind, input, operatorToken }) => {
    await requireOperator(ctx, operatorToken);

    let dismissed = 0;
    let scanned = 0;

    // `by_input` is (kind, input, status): binding only its first two
    // columns is a valid partial-prefix query, matching every status for
    // this exact request the same way convex/jobs.ts `start`'s own repeat-
    // request lookup reuses this same index.
    for await (const job of ctx.db
      .query("jobs")
      .withIndex("by_input", (q) => q.eq("kind", kind).eq("input", input))) {
      if (++scanned > DISMISS_INPUT_SCAN) break;

      // Same terminal-status guard as `dismiss` above: an active run is left
      // untouched rather than silently hidden while it still spends
      // provider allowance with nothing left in the UI to stop it.
      if (job.status === "queued" || job.status === "running") continue;

      if (job.dismissedAt !== undefined) continue;
      await ctx.db.patch(job._id, { dismissedAt: Date.now() });
      dismissed++;
    }

    return dismissed;
  },
});

export const restore = mutation({
  args: { jobId: v.id("jobs"), operatorToken: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { jobId, operatorToken }) => {
    // Authorization is the whole check here; the row itself is not needed.
    await sharedJob(ctx, jobId, (c) => requireOperator(c, operatorToken));
    await ctx.db.patch(jobId, { dismissedAt: undefined });

    return null;
  },
});

// --- Provider-reported throttling --------------------------------------
// Records one observation that a provider asked US to slow down, exactly as
// the provider stated it. `providerThrottleEvents` existed with a query and
// a dashboard panel reading it, but nothing ever wrote a row, so the panel
// read "no throttling reported" even while x.md was actively refusing us.
//
// This is NOT an application quota and must never become one (AGENTS.md:
// no self-imposed rate limits, quotas or budgets — an agent-added cap
// previously caused a production outage). They are a record of what the
// provider said, shown to a person — and, since `retry` above reads them
// through `limits.activeThrottleUntil`, also read to decide WHEN to make a
// request again, never whether to make one at all or to refuse one on our
// own reasoning. `remaining`/`resetAt`/`retryAfterMs` are written ONLY
// when the provider actually supplied them — never estimated or defaulted.
export const recordThrottle = internalMutation({
  args: {
    jobId: v.optional(v.id("jobs")),
    attempt: v.optional(v.number()),
    provider: throttleProviderValidator,
    operation: v.string(),
    reason: v.string(),
    remaining: v.optional(v.number()),
    resetAt: v.optional(v.number()),
    retryAfterMs: v.optional(v.number()),
    observedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { observedAt, ...rest } = args;
    await ctx.db.insert("providerThrottleEvents", {
      ...rest,
      // The observation time is the provider's if it gave one, otherwise the
      // instant we recorded it — never left unset, since limits.ts orders on
      // it to decide which observation is current.
      observedAt: observedAt ?? Date.now(),
    });
  },
});

export const receipts = query({
  args: { jobId: v.id("jobs") },
  returns: v.array(schema.doc("receipts")),
  handler: async (ctx, { jobId }) => {
    await sharedJob(ctx, jobId);

    return ctx.db
      .query("receipts")
      .withIndex("by_capture", (q) => q.eq("jobId", jobId))
      .take(100);
  },
});

export const pinIdentity = internalMutation({
  args: { jobId: v.id("jobs"), attempt: v.number(), userId: v.string() },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);

    if (!job || job.status !== "running" || job.attempt !== args.attempt)
      throw new Error("Indexing job is no longer active.");

    if (job.expectedUserId && job.expectedUserId !== args.userId)
      throw new Error("Account identity changed.");
    await ctx.db.patch(job._id, { expectedUserId: args.userId });
  },
});

/** How long a running job may go without any worker report before it is presumed dead. */
export const EXPIRE_GRACE_MS = 180_000;

export const expire = internalMutation({
  args: { jobId: v.id("jobs"), attempt: v.number() },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);

    if (job?.status !== "running" || job.attempt !== args.attempt) return;

    // A worker that is still reporting progress (convex/worker.ts `report`
    // touches `updatedAt`; the VM worker pings its phase every minute during
    // a long fetch) is alive, however long x.md takes for one history page
    // (convex/lib/xmd.ts HISTORY_TIMEOUT_MS). Only a run nobody has touched
    // for EXPIRE_GRACE_MS is presumed dead.
    if (Date.now() - job.updatedAt < EXPIRE_GRACE_MS) {
      await ctx.scheduler.runAfter(EXPIRE_GRACE_MS, internal.jobs.expire, args);

      return;
    }

    await ctx.db.patch(job._id, {
      status: job.count ? "partial" : "failed",
      error: "Collection timed out. Only acknowledged captures are recorded; retry to continue.",
      updatedAt: Date.now(),
    });
  },
});

export const ack = internalMutation({
  args: {
    jobId: v.id("jobs"),
    attempt: v.number(),
    captureId: v.string(),
    receiptId: v.string(),
    count: v.number(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);

    if (!job || job.status !== "running" || job.attempt !== args.attempt)
      throw new Error("Indexing job is no longer active.");

    const existing = await ctx.db
      .query("receipts")
      .withIndex("by_capture", (q) => q.eq("jobId", job._id).eq("captureId", args.captureId))
      .unique();

    if (existing) return;
    await ctx.db.insert("receipts", {
      jobId: job._id,
      captureId: args.captureId,
      receiptId: args.receiptId,
      records: args.count,
    });
    await ctx.db.patch(job._id, {
      count: job.count + args.count,
      updatedAt: Date.now(),
    });
  },
});

export const finish = internalMutation({
  args: {
    jobId: v.id("jobs"),
    attempt: v.number(),
    warnings: v.array(v.string()),
    error: v.optional(v.string()),
    retryAfter: v.optional(v.number()),
    // Only meaningful alongside `error` — see the `jobs` table's own
    // `retryable` field comment in convex/schema.ts.
    retryable: v.optional(v.boolean()),
    nextUntil: v.optional(v.string()),
    nextCursor: v.optional(v.string()),
    expectedUserId: v.optional(v.string()),
    postsReceived: v.optional(v.number()),
    oldest: v.optional(v.string()),
    floorReached: v.optional(v.boolean()),
    profile: v.optional(
      v.object({
        handle: v.string(),
        userId: v.string(),
        name: v.string(),
        avatar: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);

    if (!job || job.status !== "running" || job.attempt !== args.attempt) return;

    // A transient provider failure backs off and requeues on its own — no
    // person has to click "Retry". `pageAttempt` is bumped once per attempt
    // by `claim` (never here), so it already counts this attempt. Backoff
    // grows with each attempt and is capped so a chronically-throttled job
    // never sleeps for hours; past MAX_PAGE_ATTEMPTS the failure is handed to
    // a person as partial/failed instead of retried forever.
    const MAX_PAGE_ATTEMPTS = 10;
    const RETRY_BASE_MS = 30_000;
    const RETRY_CAP_MS = 15 * 60_000;
    const pageAttempt = job.pageAttempt ?? 0;
    const retry = args.retryAfter !== undefined && pageAttempt < MAX_PAGE_ATTEMPTS;

    const retryDelayMs = retry
      ? Math.min(RETRY_CAP_MS, Math.max(args.retryAfter!, RETRY_BASE_MS * 2 ** pageAttempt))
      : undefined;

    const pages = (job.pages ?? 0) + (args.error ? 0 : 1);

    // The admin types a handle once; xearch indexes everything it can obtain
    // for it without anyone asking for the next page. Bulk history pages by
    // walking an ever-older time window (`nextUntil`); every other kind
    // (live/post/profile/followers/following/archive) pages by a provider
    // cursor (`nextCursor`). Whichever one the provider returned, the SAME
    // job requeues itself.
    const wantsMoreUntil =
      !args.error && job.kind === "bulk" && job.autoContinue && !!args.nextUntil;

    const wantsMoreCursor = !args.error && job.kind !== "bulk" && !!args.nextCursor;

    const stalledUntil =
      wantsMoreUntil &&
      (!Number.isFinite(Date.parse(args.nextUntil!)) ||
        (job.until !== undefined && Date.parse(args.nextUntil!) >= Date.parse(job.until)));

    // A cursor identical to the one this attempt was given back means the
    // provider made no progress; continuing would loop on the same page
    // forever instead of ever finishing.
    const stalledCursor =
      wantsMoreCursor && job.cursor !== undefined && args.nextCursor === job.cursor;

    const pause = stalledUntil
      ? "Paused because x.md did not return an older page. Your downloaded posts are safe."
      : stalledCursor
        ? "Paused because x.md did not return a further page. Your downloaded posts are safe."
        : undefined;

    const continueImport = (wantsMoreUntil || wantsMoreCursor) && !pause;

    const patch: Partial<Doc<"jobs">> = {
      status:
        retry || continueImport
          ? "queued"
          : args.error
            ? job.count > 0
              ? "partial"
              : "failed"
            : "complete",
      error: args.error ?? pause,
      // Cleared whenever this attempt did not end in a stored `error` (a
      // pause is a scheduling note, not a stopped-with-error state) — never
      // left over from a previous failed attempt on the same job document.
      retryable: args.error ? args.retryable : undefined,
      // Set whenever this job will run again on its own, so the UI can say
      // "retrying automatically" instead of offering a button that does
      // nothing until then.
      readyAt: retry ? Date.now() + retryDelayMs! : continueImport ? Date.now() + 2000 : undefined,
      warnings: args.warnings.slice(0, 10),
      nextUntil: stalledUntil ? undefined : args.nextUntil,
      nextCursor: stalledCursor ? undefined : args.nextCursor,
      // The cursor this job's NEXT claim will read (convex/importer.ts reads
      // `job.cursor`) — only advanced when a cursor-paged kind is actually
      // continuing; bulk kinds never use this field for their own paging.
      cursor: wantsMoreCursor && !stalledCursor ? args.nextCursor : job.cursor,
      expectedUserId: args.expectedUserId ?? job.expectedUserId,
      pages,
      postsReceived: (job.postsReceived ?? 0) + (args.error ? 0 : (args.postsReceived ?? 0)),
      oldest: args.oldest ?? job.oldest,
      floorReached: args.floorReached ?? job.floorReached,
      updatedAt: Date.now(),
    };

    if (continueImport) {
      if (wantsMoreUntil) patch.until = args.nextUntil;
      patch.pageAttempt = 0;
      patch.phase = wantsMoreUntil ? "Downloading older posts" : "Downloading the next page";
    }

    await ctx.db.patch(job._id, patch);

    if (continueImport)
      await ctx.scheduler.runAfter(2000, internal.importer.run, {
        jobId: job._id,
      });

    if (retry)
      await ctx.scheduler.runAfter(retryDelayMs!, internal.importer.run, {
        jobId: job._id,
      });

    if (args.profile) await upsertAccount(ctx, args.profile);
  },
});

export type Profile = { handle: string; userId: string; name: string; avatar?: string };

// Account identity is the provider account id, never the handle.
//
// This used to look the account up purely `by_handle` and unconditionally
// patch whatever row it found — including that row's `userId`. On X a handle
// can be released and later claimed by a completely different account, so
// that write spliced the new owner's identity onto the previous owner's row:
// one person's posts, another person's name, and a single merged row in the
// account library. The read side (convex/library.ts, convex/publication.ts)
// was already written to treat the provider id as truth and never merge two
// ids that shared a handle; this is the write side finally agreeing with it.
// See to-do.md P0 "Do not combine different identities after a handle
// reassignment" and docs/publication-contract.md "Account identity".
export async function upsertAccount(ctx: MutationCtx, profile: Profile): Promise<Id<"accounts">> {
  const existing = await canonicalAccountForUserId(ctx.db, profile.userId);
  let accountId: Id<"accounts">;

  if (existing) {
    // Same provider id: this IS that account, whatever handle it now uses,
    // so patching is how a rename gets picked up. Skipped when nothing
    // actually changed: `finish` runs once per page and a multi-page import
    // returns the same profile every time, so writing unconditionally
    // rewrote an identical row up to sixty times per import — and every
    // write re-fires the library and summary queries watching this document.
    if (
      existing.handle !== profile.handle ||
      existing.name !== profile.name ||
      existing.avatar !== profile.avatar
    ) {
      // Record the CURRENT handle before it is overwritten below.
      // accountHandles is append-only evidence written only by this
      // function, and most accounts have never had a rename yet, so this is
      // very often the first row ever written for this account — if it were
      // skipped, an account's handle at the moment of its very first rename
      // would already be gone from history, with only the new handle
      // recorded by the call at the bottom of this function.
      await recordHandle(ctx, existing._id, existing.handle);
      await ctx.db.patch(existing._id, profile);
    }

    accountId = existing._id;
  } else {
    // No row for this provider id. Deliberately does NOT adopt a row that
    // merely holds this handle today: an unknown id arriving on a known
    // handle is exactly a reassignment, and it gets its own row.
    accountId = await ctx.db.insert("accounts", profile);
  }

  await recordHandle(ctx, accountId, profile.handle);

  return accountId;
}

// Append-only handle history, so "which account held @x when" is answerable
// from data instead of guessed. Nothing wrote this table before, which is
// why the reassignment case had no evidence trail at all.
//
// Looked up by the exact (accountId, handle) pair via `by_account_and_handle`
// rather than scanning a capped page of the account's rows: a `.take(N)` scan
// would silently re-insert a handle the account had already seen once it
// accumulated more than N tracked handles, since the earlier row could fall
// outside the scanned page. The indexed lookup is exact regardless of how
// many handles this account has ever had.
async function recordHandle(ctx: MutationCtx, accountId: Id<"accounts">, handleText: string) {
  const now = Date.now();

  // `.first()`, not `.unique()`: Convex does not enforce uniqueness on this
  // (or any) index, and the comment above this function already describes
  // how a duplicate (accountId, handle) pair could exist from before this
  // exact-lookup fix — `.unique()` throws on a second match and would fail
  // the whole import page mutation for every account that already has one
  // (CodeRabbit #4089340879).
  const existing = await ctx.db
    .query("accountHandles")
    .withIndex("by_account_and_handle", (q) =>
      q.eq("accountId", accountId).eq("handle", handleText),
    )
    .first();

  if (existing) await ctx.db.patch(existing._id, { lastSeenAt: now });
  else
    await ctx.db.insert("accountHandles", {
      accountId,
      handle: handleText,
      firstSeenAt: now,
      lastSeenAt: now,
    });
}
