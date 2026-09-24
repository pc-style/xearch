import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { activeThrottleUntil, type ProviderLimit } from "../convex/limits";

const modules = import.meta.glob("../convex/**/*.ts");

/**
 * Dashboard screenshot regression (huggingface account row): the "Provider
 * limits" panel showed x.md throttled on "history" — 20 remaining, resets
 * 5:31, next retry around 5:17 — but clicking Retry on a stopped job for
 * that same provider re-hit x.md immediately and failed the same way
 * again. `jobs.retry` set `readyAt: 0` unconditionally, never checking the
 * exact throttle fact the panel above it was already showing.
 *
 * `retry` now reads that same fact (convex/limits.ts
 * `loadProviderLimit`/`activeThrottleUntil`) and queues the job for when
 * the provider itself said to come back — never a self-imposed cap
 * (AGENTS.md "Rate limiting"), only what the provider already reported.
 *
 * CodeRabbit #4091232187 caught the first version of this against exactly
 * the screenshot's own numbers: `resetAt` (5:31) is the counting window's
 * own reset and only means "wait" once the reported allowance is actually
 * exhausted — with 20 left, waiting for 5:31 would have waited out an
 * entire window for no reason. `nextRetryAt` (5:17, derived from the
 * provider's `retryAfterMs`) is the one that matters here: the provider's
 * own explicit "come back at" instant for the specific call that got
 * refused, independent of how much allowance remains.
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
  fields: { remaining?: number; resetAt?: number; retryAfterMs?: number; observedAt?: number },
) {
  return t.run((ctx) =>
    ctx.db.insert("providerThrottleEvents", {
      jobId,
      provider: "xmd",
      operation: "history",
      reason: "Throttled on history",
      observedAt: fields.observedAt ?? Date.now(),
      remaining: fields.remaining,
      resetAt: fields.resetAt,
      retryAfterMs: fields.retryAfterMs,
    }),
  );
}

describe("jobs.retry respects an active x.md throttle", () => {
  // The dashboard screenshot's exact shape: allowance remains, so the far-
  // off window resetAt must be ignored in favor of the much sooner
  // provider-given retryAfterMs.
  it("with allowance remaining, waits for retryAfterMs and ignores the later resetAt", async () => {
    const { t, operator } = await setup();
    const owner = await t.run((ctx) => ctx.db.insert("users", { isAnonymous: true }));
    const jobId = await stoppedJob(t, owner);
    const observedAt = Date.now();
    const retryAfterMs = 60_000; // "next retry around 5:17"
    const resetAt = observedAt + 5 * 60_000; // "resets 5:31" — later, and must be ignored
    await throttleEvent(t, jobId, { remaining: 20, observedAt, resetAt, retryAfterMs });

    await expect(operator.mutation(api.jobs.retry, { jobId })).resolves.toBeNull();

    const retried = await t.run((ctx) => ctx.db.get(jobId));

    expect(retried?.status).toBe("queued");
    expect(retried?.readyAt).toBe(observedAt + retryAfterMs);
    expect(retried?.phase).toContain("Retry queued for");
  });

  it("with allowance remaining and no retryAfter given, retries immediately (resetAt alone never blocks)", async () => {
    const { t, operator } = await setup();
    const owner = await t.run((ctx) => ctx.db.insert("users", { isAnonymous: true }));
    const jobId = await stoppedJob(t, owner);
    const observedAt = Date.now();
    await throttleEvent(t, jobId, { remaining: 20, observedAt, resetAt: observedAt + 5 * 60_000 });

    await operator.mutation(api.jobs.retry, { jobId });

    const retried = await t.run((ctx) => ctx.db.get(jobId));

    expect(retried?.readyAt).toBe(0);
    expect(retried?.phase).toBe("Retry queued");
  });

  it("with allowance exhausted, waits until resetAt", async () => {
    const { t, operator } = await setup();
    const owner = await t.run((ctx) => ctx.db.insert("users", { isAnonymous: true }));
    const jobId = await stoppedJob(t, owner);
    const observedAt = Date.now();
    const resetAt = observedAt + 5 * 60_000;
    await throttleEvent(t, jobId, { remaining: 0, observedAt, resetAt });

    await operator.mutation(api.jobs.retry, { jobId });

    const retried = await t.run((ctx) => ctx.db.get(jobId));

    expect(retried?.readyAt).toBe(resetAt);
    expect(retried?.phase).toContain("Retry queued for");
  });

  it("with allowance exhausted AND a sooner retryAfter, waits for the later of the two", async () => {
    const { t, operator } = await setup();
    const owner = await t.run((ctx) => ctx.db.insert("users", { isAnonymous: true }));
    const jobId = await stoppedJob(t, owner);
    const observedAt = Date.now();
    const retryAfterMs = 30_000;
    const resetAt = observedAt + 5 * 60_000;
    await throttleEvent(t, jobId, { remaining: 0, observedAt, resetAt, retryAfterMs });

    await operator.mutation(api.jobs.retry, { jobId });

    const retried = await t.run((ctx) => ctx.db.get(jobId));

    expect(retried?.readyAt).toBe(resetAt);
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

  it("retries immediately once an observed throttle's retryAfter time has already passed, even at zero remaining", async () => {
    const { t, operator } = await setup();
    const owner = await t.run((ctx) => ctx.db.insert("users", { isAnonymous: true }));
    const jobId = await stoppedJob(t, owner);
    const observedAt = Date.now() - 60 * 60_000;
    await throttleEvent(t, jobId, { remaining: 0, observedAt, resetAt: observedAt + 60_000 });

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
    await throttleEvent(t, jobId, { remaining: 0, observedAt, resetAt: observedAt + 5 * 60_000 });
    await operator.mutation(api.jobs.retry, { jobId });

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
    remaining: { kind: "unknown" },
    observedAt: 1_000,
  };

  it("returns undefined for a provider with no throttle observed", () => {
    expect(activeThrottleUntil({ kind: "none", provider: "xmd" }, 2_000)).toBeUndefined();
  });

  it("ignores resetAt when the reported allowance still has some left, even if resetAt is in the future", () => {
    expect(
      activeThrottleUntil(
        { ...base, remaining: { kind: "known", value: 20 }, resetAt: 9_000 },
        2_000,
      ),
    ).toBeUndefined();
  });

  it("ignores resetAt when remaining is merely unknown, not confirmed exhausted", () => {
    expect(
      activeThrottleUntil({ ...base, remaining: { kind: "unknown" }, resetAt: 9_000 }, 2_000),
    ).toBeUndefined();
  });

  it("honors resetAt once remaining is reported as exactly exhausted", () => {
    expect(
      activeThrottleUntil(
        { ...base, remaining: { kind: "known", value: 0 }, resetAt: 9_000 },
        2_000,
      ),
    ).toBe(9_000);
  });

  it("honors nextRetryAt regardless of remaining allowance", () => {
    expect(
      activeThrottleUntil(
        { ...base, remaining: { kind: "known", value: 20 }, nextRetryAt: 9_000 },
        2_000,
      ),
    ).toBe(9_000);
  });

  it("returns undefined when the only qualifying deadline has already passed", () => {
    expect(
      activeThrottleUntil(
        { ...base, remaining: { kind: "known", value: 20 }, nextRetryAt: 1_500 },
        2_000,
      ),
    ).toBeUndefined();
  });

  it("with allowance exhausted and both deadlines in the future, returns the later one", () => {
    const exhausted = { ...base, remaining: { kind: "known" as const, value: 0 } };

    expect(activeThrottleUntil({ ...exhausted, resetAt: 5_000, nextRetryAt: 9_000 }, 2_000)).toBe(
      9_000,
    );
    expect(activeThrottleUntil({ ...exhausted, resetAt: 9_000, nextRetryAt: 5_000 }, 2_000)).toBe(
      9_000,
    );
  });
});
