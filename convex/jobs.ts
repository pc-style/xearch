import { v, ConvexError } from "convex/values";
import { query, mutation, internalMutation } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { kindValidator, throttleProviderValidator } from "./schema";
import { user } from "./access";
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
  handler: async (ctx, args) => {
    // Authenticated callers only; every signed-in caller sees the same
    // shared feed, so nothing about the identity narrows what comes back.
    await user(ctx);
    const scope = args.scope ?? "all";
    const out: Doc<"jobs">[] = [];
    let scanned = 0;
    for await (const job of ctx.db.query("jobs").order("desc")) {
      if (++scanned > JOB_FEED_SCAN) break;
      if (!args.includeDismissed && job.dismissedAt !== undefined) continue;
      if (scope === "other" && job.kind === ACCOUNT_JOB_KIND) continue;
      out.push(job);
      if (out.length >= JOB_FEED_LIMIT) break;
    }
    return out;
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
export const start = mutation({
  args: {
    kind: kindValidator,
    input: v.string(),
    since: v.optional(v.string()),
    refresh: v.optional(v.boolean()),
    previous: v.optional(v.id("jobs")),
  },
  handler: async (ctx, args) => {
    // Authentication only. The job this creates is not scoped back to this
    // caller for reads or actions on it — imports are shared infrastructure,
    // not personal data (to-do.md) — `owner` below is written purely as an
    // audit trail of who started the run.
    const owner = await user(ctx);
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
    const input =
      args.kind === "live"
        ? canonicalLiveQuery(args.input)
        : args.kind === "post"
          ? statusUrl(args.input)
          : handle(args.input);
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
// Load a job, requiring only that the caller is authenticated. Jobs are
// shared infrastructure, not personal data (to-do.md): any signed-in caller
// may cancel, retry, dismiss, or restore any job, not only the one they
// started. `job.owner` still records who started it (an audit trail); it is
// no longer a permission check.
async function sharedJob(ctx: QueryCtx | MutationCtx, jobId: Id<"jobs">) {
  await user(ctx);
  const job = await ctx.db.get(jobId);
  if (!job) throw new ConvexError("Job not found.");
  return job;
}
export const cancel = mutation({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, { jobId }) => {
    const job = await sharedJob(ctx, jobId);
    if (!["queued", "running"].includes(job.status)) return;
    await ctx.db.patch(jobId, {
      status: "cancelled",
      phase: "Stopped; an in-flight request may still finish. Retained captures are not deleted.",
      updatedAt: Date.now(),
    });
  },
});
export const retry = mutation({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, { jobId }) => {
    const job = await sharedJob(ctx, jobId);
    if (!["failed", "partial", "cancelled"].includes(job.status))
      throw new ConvexError("Only stopped or failed jobs can be retried.");
    for (const status of ["queued", "running"] as const) {
      const active = await ctx.db
        .query("jobs")
        .withIndex("by_input", (q) =>
          q.eq("kind", job.kind).eq("input", job.input).eq("status", status),
        )
        .first();
      if (active) throw new ConvexError("This indexing job is already active.");
    }
    await ctx.db.patch(jobId, {
      status: "queued",
      readyAt: 0,
      error: undefined,
      phase: "Retry queued",
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.importer.run, { jobId });
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
  args: { jobId: v.id("jobs") },
  handler: async (ctx, { jobId }) => {
    const job = await sharedJob(ctx, jobId);
    // Deliberately refuses queued/running work: hiding a run that is still
    // spending provider allowance would make it unstoppable from the UI.
    // Stop it first, then dismiss it.
    if (job.status === "queued" || job.status === "running")
      throw new ConvexError("Stop this run before dismissing it.");
    if (job.dismissedAt !== undefined) return;
    await ctx.db.patch(jobId, { dismissedAt: Date.now() });
  },
});
export const restore = mutation({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, { jobId }) => {
    // Ownership is the whole check here; the row itself is not needed.
    await sharedJob(ctx, jobId);
    await ctx.db.patch(jobId, { dismissedAt: undefined });
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
// previously caused a production outage). Nothing reads these rows to decide
// whether to make a request; they are a record of what the provider said,
// shown to a person. `remaining`/`resetAt`/`retryAfterMs` are written ONLY
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
export const expire = internalMutation({
  args: { jobId: v.id("jobs"), attempt: v.number() },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (job?.status === "running" && job.attempt === args.attempt)
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
    const wantsMoreUntil = !args.error && job.kind === "bulk" && job.autoContinue && !!args.nextUntil;
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

    await ctx.db.patch(job._id, {
      status:
        retry || continueImport
          ? "queued"
          : args.error
            ? job.count > 0
              ? "partial"
              : "failed"
            : "complete",
      error: args.error ?? pause,
      // Set whenever this job will run again on its own, so the UI can say
      // "retrying automatically" instead of offering a button that does
      // nothing until then.
      readyAt: retry
        ? Date.now() + retryDelayMs!
        : continueImport
          ? Date.now() + 2000
          : undefined,
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
      ...(continueImport
        ? {
            ...(wantsMoreUntil ? { until: args.nextUntil } : {}),
            pageAttempt: 0,
            phase: wantsMoreUntil ? "Downloading older posts" : "Downloading the next page",
          }
        : {}),
      updatedAt: Date.now(),
    });
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
    )
      await ctx.db.patch(existing._id, profile);
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
const MAX_TRACKED_HANDLES = 50;
async function recordHandle(ctx: MutationCtx, accountId: Id<"accounts">, handleText: string) {
  const now = Date.now();
  const known = await ctx.db
    .query("accountHandles")
    .withIndex("by_account", (q) => q.eq("accountId", accountId))
    .take(MAX_TRACKED_HANDLES);
  const existing = known.find((row) => row.handle === handleText);
  if (existing) await ctx.db.patch(existing._id, { lastSeenAt: now });
  else
    await ctx.db.insert("accountHandles", {
      accountId,
      handle: handleText,
      firstSeenAt: now,
      lastSeenAt: now,
    });
}
