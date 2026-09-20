import { v, ConvexError } from "convex/values";
import { query, mutation, internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { kindValidator, throttleProviderValidator } from "./schema";
import { user } from "./access";
import { handle, statusUrl } from "./lib/xmd";
import { parseQuery } from "./lib/search";

// `take(20)` is applied AFTER the dismissed filter, not before: filtering a
// page of 20 down to 3 would make dismissing a few runs look like the rest
// of the feed vanished. Read a larger window, then page it.
const JOB_FEED_SCAN = 200;
const JOB_FEED_LIMIT = 20;
export const list = query({
  args: { includeDismissed: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const owner = await user(ctx);
    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_owner", (q) => q.eq("owner", owner))
      .order("desc")
      .take(JOB_FEED_SCAN);
    return (args.includeDismissed ? jobs : jobs.filter((job) => job.dismissedAt === undefined)).slice(
      0,
      JOB_FEED_LIMIT,
    );
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
    const { author, text } = parseQuery(raw.trim());
    return [author ? `@${author}` : "", text].filter(Boolean).join(" ");
  } catch (error) {
    // parseQuery throws plain Errors with copy already written for a person
    // ("Search one author at a time...", "Use @handle to filter authors...").
    // Re-throw as ConvexError so the browser shows that text instead of a
    // generic server-error string.
    throw new ConvexError(error instanceof Error ? error.message : "Enter a valid search.");
  }
}
export const start = mutation({
  args: {
    kind: kindValidator,
    input: v.string(),
    since: v.optional(v.string()),
    refresh: v.optional(v.boolean()),
    previous: v.optional(v.id("jobs")),
  },
  handler: async (ctx, args) => {
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
    const previous = args.previous ? await ctx.db.get(args.previous) : null;
    if (
      args.previous &&
      (!previous ||
        previous.owner !== owner ||
        previous.input !== input ||
        previous.kind !== args.kind)
    )
      throw new ConvexError("Continuation does not belong to this indexing job.");
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
export const cancel = mutation({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, { jobId }) => {
    const owner = await user(ctx),
      job = await ctx.db.get(jobId);
    if (!job || job.owner !== owner) throw new ConvexError("Job not found.");
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
    const owner = await user(ctx),
      job = await ctx.db.get(jobId);
    if (!job || job.owner !== owner) throw new ConvexError("Job not found.");
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
const DISMISSABLE = ["complete", "partial", "failed", "cancelled"] as const;
export const dismiss = mutation({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, { jobId }) => {
    const owner = await user(ctx),
      job = await ctx.db.get(jobId);
    if (!job || job.owner !== owner) throw new ConvexError("Job not found.");
    // Deliberately refuses queued/running work: hiding a run that is still
    // spending provider allowance would make it unstoppable from the UI.
    // Stop it first, then dismiss it.
    if (!DISMISSABLE.includes(job.status as (typeof DISMISSABLE)[number]))
      throw new ConvexError("Stop this run before dismissing it.");
    if (job.dismissedAt !== undefined) return;
    await ctx.db.patch(jobId, { dismissedAt: Date.now() });
  },
});
export const restore = mutation({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, { jobId }) => {
    const owner = await user(ctx),
      job = await ctx.db.get(jobId);
    if (!job || job.owner !== owner) throw new ConvexError("Job not found.");
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
    const owner = await user(ctx),
      job = await ctx.db.get(jobId);
    if (!job || job.owner !== owner) throw new ConvexError("Job not found.");
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
    const retry = args.retryAfter !== undefined && (job.pageAttempt ?? args.attempt) < 3;
    const pages = (job.pages ?? 0) + (args.error ? 0 : 1);
    const wantsMore = !args.error && job.kind === "bulk" && job.autoContinue && !!args.nextUntil;
    const stalled =
      wantsMore &&
      (!Number.isFinite(Date.parse(args.nextUntil!)) ||
        (job.until !== undefined && Date.parse(args.nextUntil!) >= Date.parse(job.until)));
    const pause = stalled
      ? "Paused because x.md did not return an older page. Your downloaded posts are safe."
      : undefined;
    const continueImport = wantsMore && !pause;
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
      readyAt: retry
        ? Date.now() + Math.max(1000, args.retryAfter!)
        : continueImport
          ? Date.now() + 2000
          : undefined,
      warnings: args.warnings.slice(0, 10),
      nextUntil: stalled ? undefined : args.nextUntil,
      nextCursor: args.nextCursor,
      expectedUserId: args.expectedUserId ?? job.expectedUserId,
      pages,
      postsReceived: (job.postsReceived ?? 0) + (args.error ? 0 : (args.postsReceived ?? 0)),
      oldest: args.oldest ?? job.oldest,
      floorReached: args.floorReached ?? job.floorReached,
      ...(continueImport
        ? {
            until: args.nextUntil,
            pageAttempt: 0,
            phase: "Downloading older posts",
          }
        : {}),
      updatedAt: Date.now(),
    });
    if (continueImport)
      await ctx.scheduler.runAfter(2000, internal.importer.run, {
        jobId: job._id,
      });
    if (retry)
      await ctx.scheduler.runAfter(Math.max(1000, args.retryAfter!), internal.importer.run, {
        jobId: job._id,
      });
    if (args.profile) await upsertAccount(ctx, args.profile);
  },
});

type Profile = { handle: string; userId: string; name: string; avatar?: string };

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
async function upsertAccount(ctx: MutationCtx, profile: Profile): Promise<Id<"accounts">> {
  // `by_user_id` is not uniqueness-enforced by the schema, so `.unique()`
  // would throw on a duplicate rather than letting the import finish. Two
  // rows for ONE provider id is a pre-existing data problem, not the
  // cross-identity merge this function exists to prevent — both rows already
  // claim the same identity — so patching the first is safe.
  const byUserId = await ctx.db
    .query("accounts")
    .withIndex("by_user_id", (q) => q.eq("userId", profile.userId))
    .take(2);
  const existing = byUserId[0];
  let accountId: Id<"accounts">;
  if (existing) {
    // Same provider id: this IS that account, whatever handle it now uses.
    // Patching the handle here is how a rename is picked up.
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
