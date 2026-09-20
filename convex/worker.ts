import { action, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { throttleProviderValidator } from "./schema";
import type { Doc } from "./_generated/dataModel";

function authorize(token: string) {
  if (
    process.env.COLLECTOR_MODE !== "outbound" ||
    !process.env.COLLECTOR_TOKEN ||
    token !== process.env.COLLECTOR_TOKEN
  )
    throw new ConvexError("Worker authentication failed.");
}
export const heartbeat = internalMutation({
  args: { online: v.boolean() },
  handler: async (ctx, { online }) => {
    const existing = await ctx.db
      .query("collector")
      .withIndex("by_name", (q) => q.eq("name", "desktop"))
      .unique();
    const lastSeen = Date.now();
    if (existing) await ctx.db.patch(existing._id, { online, lastSeen });
    else await ctx.db.insert("collector", { name: "desktop", online, lastSeen });
    if (online)
      await ctx.scheduler.runAfter(45_000, internal.worker.expire, {
        lastSeen,
      });
  },
});
export const expire = internalMutation({
  args: { lastSeen: v.number() },
  handler: async (ctx, { lastSeen }) => {
    const row = await ctx.db
      .query("collector")
      .withIndex("by_name", (q) => q.eq("name", "desktop"))
      .unique();
    if (row?.lastSeen === lastSeen) await ctx.db.patch(row._id, { online: false });
  },
});
export const claimNext = internalMutation({
  args: {},
  handler: async (ctx): Promise<Doc<"jobs"> | null> => {
    if (
      await ctx.db
        .query("jobs")
        .withIndex("by_status", (q) => q.eq("status", "running"))
        .first()
    )
      return null;
    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_status", (q) => q.eq("status", "queued"))
      .take(20);
    const job = jobs.find((j) => (j.readyAt ?? 0) <= Date.now());
    if (!job) return null;
    const attempt = job.attempt + 1;
    await ctx.db.patch(job._id, {
      status: "running",
      attempt,
      pageAttempt: (job.pageAttempt ?? 0) + 1,
      phase: "Starting download",
      updatedAt: Date.now(),
      error: undefined,
    });
    await ctx.scheduler.runAfter(600_000, internal.jobs.expire, {
      jobId: job._id,
      attempt,
    });
    return { ...job, status: "running", attempt };
  },
});
export const poll = action({
  args: {
    token: v.string(),
    heartbeatOnly: v.optional(v.boolean()),
    online: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<Doc<"jobs"> | null> => {
    authorize(args.token);
    await ctx.runMutation(internal.worker.heartbeat, {
      online: args.online !== false,
    });
    if (args.heartbeatOnly || args.online === false) return null;
    return ctx.runMutation(internal.worker.claimNext, {});
  },
});
export const report = action({
  args: {
    token: v.string(),
    jobId: v.id("jobs"),
    attempt: v.number(),
    event: v.union(
      v.literal("phase"),
      v.literal("identity"),
      v.literal("receipt"),
      v.literal("finish"),
      // Production runs COLLECTOR_MODE=outbound, so the VM worker — not
      // convex/importer.ts — is what actually talks to x.md and therefore
      // the only thing that ever sees a provider asking us to slow down.
      // Without this event that observation dies on the worker and the
      // dashboard's provider-limits panel stays empty in the one deployment
      // that matters.
      v.literal("throttle"),
    ),
    phase: v.optional(v.string()),
    userId: v.optional(v.string()),
    captureId: v.optional(v.string()),
    receiptId: v.optional(v.string()),
    count: v.optional(v.number()),
    warnings: v.optional(v.array(v.string())),
    error: v.optional(v.string()),
    retryAfter: v.optional(v.number()),
    postsReceived: v.optional(v.number()),
    oldest: v.optional(v.string()),
    floorReached: v.optional(v.boolean()),
    nextUntil: v.optional(v.string()),
    nextCursor: v.optional(v.string()),
    expectedUserId: v.optional(v.string()),
    // Only read for the "throttle" event. Every field is the provider's own
    // report, forwarded verbatim; the worker never estimates one.
    throttle: v.optional(
      v.object({
        provider: throttleProviderValidator,
        operation: v.string(),
        reason: v.string(),
        remaining: v.optional(v.number()),
        resetAt: v.optional(v.number()),
        retryAfterMs: v.optional(v.number()),
        observedAt: v.optional(v.number()),
      }),
    ),
  },
  handler: async (ctx, args): Promise<void> => {
    authorize(args.token);
    const base = { jobId: args.jobId, attempt: args.attempt };
    if (args.event === "throttle") {
      // A throttle report is an observation, never a job state change: it
      // must not move the job's status, and a job that is no longer this
      // attempt should still have its observation recorded.
      if (args.throttle) await ctx.runMutation(internal.jobs.recordThrottle, { ...base, ...args.throttle });
      return;
    }
    if (args.event === "phase")
      await ctx.runMutation(internal.jobs.progress, {
        ...base,
        phase: args.phase ?? "Downloading",
      });
    else if (args.event === "identity")
      await ctx.runMutation(internal.jobs.pinIdentity, {
        ...base,
        userId: args.userId!,
      });
    else if (args.event === "receipt")
      await ctx.runMutation(internal.jobs.ack, {
        ...base,
        captureId: args.captureId!,
        receiptId: args.receiptId!,
        count: args.count!,
      });
    else
      await ctx.runMutation(internal.jobs.finish, {
        ...base,
        warnings: args.warnings ?? [],
        error: args.error,
        retryAfter: args.retryAfter,
        postsReceived: args.postsReceived,
        oldest: args.oldest,
        floorReached: args.floorReached,
        nextUntil: args.nextUntil,
        nextCursor: args.nextCursor,
        expectedUserId: args.expectedUserId,
      });
  },
});
