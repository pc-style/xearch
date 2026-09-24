import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { activeThrottleUntil, type ProviderLimit } from "../convex/limits";

const modules = import.meta.glob("../convex/**/*.ts");

/**
 * Dashboard screenshot regression (huggingface account row): the "Provider
 * limits" panel showed x.md currently throttled on "history", but clicking
 * Retry on a stopped job for that same provider re-hit x.md immediately and
 * failed the same way again — `jobs.retry` set `readyAt: 0` unconditionally,
 * never checking the exact throttle fact the panel above it was already
 * showing. `retry` now reads that same fact (convex/limits.ts
 * `loadProviderLimit`/`activeThrottleUntil`) and queues the job for when the
 * provider itself said to come back, instead of firing early only to fail
 * again — never a self-imposed cap (AGENTS.md "Rate limiting"), only what
 * the provider already reported.
 */

async function setup() {
  const t = convexTest(schema, modules);

  // tests/setupEnv.ts lists this address on OPERATOR_EMAILS.
  const operatorUser = await t.run((ctx) =>
    ctx.db.insert("users", {
      isAnonymous: false,
      email: "operator@test.xearch",
      emailVerificationTime: Date.now(),
    }),
  );

  return { t, operator: t.withIdentity({ subject: `${operatorUser}|s` }) };
}

function stoppedJob(t: Awaited<ReturnType<typeof setup>>["t"], owner: Id<"users">) {
  return t.run((ctx) =>
    ctx.db.insert("jobs", {
      owner,
      kind: "bulk",
      input: "huggingface",
      refresh: false,
      status: "failed",
      count: 3,
      attempt: 1,
      retryable: true,
      warnings: [],
      updatedAt: Date.now(),
    }),
  );
}

function throttleEvent(
  t: Awaited<ReturnType<typeof setup>>["t"],
  jobId: Id<"jobs">,
  fields: { resetAt?: number; retryAfterMs?: number; observedAt?: number },
) {
  return t.run((ctx) =>
    ctx.db.insert("providerThrottleEvents", {
      jobId,
      provider: "xmd",
      operation: "history",
      reason: "Throttled on history",
      remaining: 20,
      observedAt: fields.observedAt ?? Date.now(),
      resetAt: fields.resetAt,
      retryAfterMs: fields.retryAfterMs,
    }),
  );
}

describe("jobs.retry respects an active x.md throttle", () => {
  it("queues the job for the reset time instead of retrying immediately", async () => {
    const { t, operator } = await setup();
    const owner = await t.run((ctx) => ctx.db.insert("users", { isAnonymous: true }));
    const jobId = await stoppedJob(t, owner);
    const observedAt = Date.now();
    const resetAt = observedAt + 5 * 60_000; // 5 minutes from now
    await throttleEvent(t, jobId, { observedAt, resetAt });

    await expect(operator.mutation(api.jobs.retry, { jobId })).resolves.toBeNull();

    const retried = await t.run((ctx) => ctx.db.get(jobId));

    expect(retried?.status).toBe("queued");
    expect(retried?.readyAt).toBe(resetAt);
    expect(retried?.phase).toContain("Retry queued for");
  });

  it("picks the later of resetAt and the retryAfterMs-derived time", async () => {
    const { t, operator } = await setup();
    const owner = await t.run((ctx) => ctx.db.insert("users", { isAnonymous: true }));
    const jobId = await stoppedJob(t, owner);
    const observedAt = Date.now();
    // resetAt is sooner; retryAfterMs (from observedAt) is later — the job
    // should wait for the later of the two, not whichever came first.
    const resetAt = observedAt + 60_000;
    const retryAfterMs = 5 * 60_000;
    await throttleEvent(t, jobId, { observedAt, resetAt, retryAfterMs });

    await operator.mutation(api.jobs.retry, { jobId });

    const retried = await t.run((ctx) => ctx.db.get(jobId));

    expect(retried?.readyAt).toBe(observedAt + retryAfterMs);
  });

  it("retries immediately when no throttle has ever been observed", async () => {
    const { t, operator } = await setup();
    const owner = await t.run((ctx) => ctx.db.insert("users", { isAnonymous: true }));
    const jobId = await stoppedJob(t, owner);

    await expect(operator.mutation(api.jobs.retry, { jobId })).resolves.toBeNull();

    const retried = await t.run((ctx) => ctx.db.get(jobId));

    expect(retried?.status).toBe("queued");
    expect(retried?.readyAt).toBe(0);
    expect(retried?.phase).toBe("Retry queued");
  });

  it("retries immediately once an observed throttle's reset/retry-after time has already passed", async () => {
    const { t, operator } = await setup();
    const owner = await t.run((ctx) => ctx.db.insert("users", { isAnonymous: true }));
    const jobId = await stoppedJob(t, owner);
    const observedAt = Date.now() - 60 * 60_000;
    await throttleEvent(t, jobId, { observedAt, resetAt: observedAt + 60_000 });

    await operator.mutation(api.jobs.retry, { jobId });

    const retried = await t.run((ctx) => ctx.db.get(jobId));

    expect(retried?.readyAt).toBe(0);
    expect(retried?.phase).toBe("Retry queued");
  });

  // convex/jobs.ts `claim` already refuses a job before its `readyAt`
  // (`if (!job || job.status !== "queued" || (job.readyAt ?? 0) > Date.now()) return null;`)
  // — this is the other half of the fix: a queued-but-not-yet-ready job
  // must not be claimable early just because it is "queued".
  it("a job queued for a future readyAt is not claimable yet (existing claim behavior)", async () => {
    const { t, operator } = await setup();
    const owner = await t.run((ctx) => ctx.db.insert("users", { isAnonymous: true }));
    const jobId = await stoppedJob(t, owner);
    const observedAt = Date.now();
    await throttleEvent(t, jobId, { observedAt, resetAt: observedAt + 5 * 60_000 });
    await operator.mutation(api.jobs.retry, { jobId });

    const { internal } = await import("../convex/_generated/api");
    const claimed = await t.run((ctx) => ctx.db.get(jobId));

    expect(claimed?.status).toBe("queued");
    await expect(t.mutation(internal.jobs.claim, { jobId })).resolves.toBeNull();
  });
});

describe("limits.activeThrottleUntil", () => {
  const base: ProviderLimit = {
    kind: "throttled",
    provider: "xmd",
    operation: "history",
    reason: "Throttled on history",
    remaining: { kind: "known", value: 20 },
    observedAt: 1_000,
  };

  it("returns undefined for a provider with no throttle observed", () => {
    expect(activeThrottleUntil({ kind: "none", provider: "xmd" }, 2_000)).toBeUndefined();
  });

  it("returns undefined when neither resetAt nor nextRetryAt is in the future", () => {
    expect(activeThrottleUntil({ ...base, resetAt: 1_500 }, 2_000)).toBeUndefined();
  });

  it("returns resetAt when only it is set and in the future", () => {
    expect(activeThrottleUntil({ ...base, resetAt: 5_000 }, 2_000)).toBe(5_000);
  });

  it("returns the later of resetAt and nextRetryAt when both are in the future", () => {
    expect(activeThrottleUntil({ ...base, resetAt: 5_000, nextRetryAt: 9_000 }, 2_000)).toBe(9_000);
    expect(activeThrottleUntil({ ...base, resetAt: 9_000, nextRetryAt: 5_000 }, 2_000)).toBe(9_000);
  });

  it("ignores a past one and uses the future one when only one qualifies", () => {
    expect(activeThrottleUntil({ ...base, resetAt: 500, nextRetryAt: 5_000 }, 2_000)).toBe(5_000);
  });
});
