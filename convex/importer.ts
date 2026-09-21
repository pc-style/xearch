import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { XmdClient, ProviderError, string } from "./lib/xmd";
import { collectXmd } from "./lib/collect";
import { deliverCapture } from "./lib/handoff";
import { serviceToken } from "./lib/serviceAuth";
import type { Doc } from "./_generated/dataModel";

export const run = internalAction({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, { jobId }): Promise<void> => {
    if (process.env.COLLECTOR_MODE === "outbound") return;
    const job: Doc<"jobs"> | null = await ctx.runMutation(internal.jobs.claim, {
      jobId,
    });
    if (!job) return;
    try {
      if (!process.env.X_MD_API_KEY || !process.env.RAW_CAPTURE_URL)
        throw new ProviderError(
          "configuration",
          "Configure X_MD_API_KEY and RAW_CAPTURE_URL to run indexing jobs.",
        );
      const xmd = new XmdClient(process.env.X_MD_API_KEY, fetch, process.env.X_MD_BASE_URL);
      const result = await collectXmd(
        xmd,
        {
          runId: jobId,
          attempt: job.attempt,
          kind: job.kind,
          input: job.input,
          since: job.since,
          until: job.until,
          cursor: job.cursor,
          refresh: job.refresh,
          expectedUserId: job.expectedUserId,
        },
        (capture) => deliverCapture(process.env.RAW_CAPTURE_URL!, serviceToken("capture"), capture),
        async (receipt, count) => {
          await ctx.runMutation(internal.jobs.ack, {
            jobId,
            attempt: job.attempt,
            captureId: receipt.captureId,
            receiptId: receipt.receiptId,
            count,
          });
        },
        Date.now,
        async (id) => {
          await ctx.runMutation(internal.jobs.pinIdentity, {
            jobId,
            attempt: job.attempt,
            userId: id,
          });
        },
        async (phase) => {
          await ctx.runMutation(internal.jobs.progress, {
            jobId,
            attempt: job.attempt,
            phase,
          });
        },
      );
      const name = result.profile && string(result.profile.screen_name);
      await ctx.runMutation(internal.jobs.finish, {
        jobId,
        attempt: job.attempt,
        warnings: result.warnings,
        postsReceived: result.postsReceived,
        oldest: result.oldest,
        floorReached: result.floorReached,
        expectedUserId: result.expectedUserId,
        nextUntil: result.nextUntil,
        nextCursor: result.nextCursor,
        profile:
          name && /^[A-Za-z0-9_]{1,15}$/.test(name) && result.expectedUserId
            ? {
                handle: name.toLowerCase(),
                userId: result.expectedUserId,
                name: string(result.profile!.name) ?? name,
                avatar: string(result.profile!.avatar_url)?.startsWith("https://")
                  ? string(result.profile!.avatar_url)
                  : undefined,
              }
            : undefined,
      });
    } catch (error) {
      // Record what the provider told us BEFORE finishing the job, so the
      // observation survives even if `finish` decides this attempt is stale.
      // This is a record of what x.md (or the capture receiver) said, shown
      // to a person — nothing reads it back to decide whether to call out,
      // and it must never grow into an application-side quota (AGENTS.md).
      if (error instanceof ProviderError && error.throttle) {
        const throttle = error.throttle;
        // Best-effort on purpose. Recording what the provider said is
        // strictly less important than finishing the job below: if this
        // write failed and took the catch block with it, the run would stay
        // "running" until the 10-minute expiry instead of reporting its real
        // error. Losing one observation beats stranding the job.
        await ctx
          .runMutation(internal.jobs.recordThrottle, {
            jobId,
            attempt: job.attempt,
            provider: throttle.provider,
            operation: throttle.operation,
            // The schema requires a reason; the provider does not always send
            // one. Fall back to the error text we already show a person rather
            // than inventing a reason or dropping the whole observation.
            reason: throttle.reason ?? error.message,
            remaining: throttle.remaining,
            resetAt: throttle.resetAt,
            retryAfterMs: throttle.retryAfterMs,
            observedAt: throttle.observedAt,
          })
          .catch(() => {});
      }
      await ctx.runMutation(internal.jobs.finish, {
        jobId,
        attempt: job.attempt,
        warnings: [],
        error:
          error instanceof ProviderError
            ? error.message
            : "Collection failed before a complete handoff. Acknowledged raw captures remain with the storage service.",
        retryAfter:
          error instanceof ProviderError && error.retryable ? error.retryAfter : undefined,
      });
    }
  },
});
