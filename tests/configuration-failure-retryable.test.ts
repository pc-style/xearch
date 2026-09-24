import { describe, expect, it, vi, afterEach } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

const modules = import.meta.glob("../convex/**/*.ts");

/**
 * CodeRabbit (PR #52, convex/importer.ts:136): `ProviderError` defaults
 * `retryable` to `false`. The "configuration" error importer.ts throws when
 * `X_MD_API_KEY`/`RAW_CAPTURE_URL` are missing used to fall through that
 * default, so a job that failed only because the DEPLOYMENT was never
 * configured got permanently marked `retryable: false` — `jobs.retry`
 * rejects it forever (convex/jobs.ts) and src/JobRow.tsx hides Retry and
 * shows "x.md can't fetch this", even after an operator sets the missing
 * env vars. A configuration problem is the operator's to fix, not x.md's;
 * it must stay retryable manually, just not on the automatic backoff path
 * (that would only hammer x.md with the same missing key).
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

function queuedJob(t: Awaited<ReturnType<typeof setup>>["t"], owner: Id<"users">) {
  return t.run((ctx) =>
    ctx.db.insert("jobs", {
      owner,
      kind: "profile",
      input: "theo",
      refresh: false,
      status: "queued",
      count: 0,
      attempt: 0,
      warnings: [],
      updatedAt: Date.now(),
    }),
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a missing X_MD_API_KEY/RAW_CAPTURE_URL stays manually retryable", () => {
  it("marks the stopped job retryable, and lets an operator retry it once configured", async () => {
    const { t, operator } = await setup();
    const owner = await t.run((ctx) => ctx.db.insert("users", { isAnonymous: true }));
    const jobId = await queuedJob(t, owner);

    // Neither env var stubbed: importer.ts's own "configuration" check
    // requires both to be genuinely absent, which is the real state of an
    // unconfigured deployment (never stubbed to empty strings — Convex's
    // dev/test runtime does not set these at all until an operator does).
    await t.action(internal.importer.run, { jobId });

    const stopped = await t.run((ctx) => ctx.db.get(jobId));

    expect(stopped?.status).toBe("failed");
    expect(stopped?.error).toContain("Configure X_MD_API_KEY");
    // The actual regression: this used to be `false` (ProviderError's own
    // default), which made `jobs.retry` permanently refuse the job.
    expect(stopped?.retryable).toBe(true);

    // Simulate the operator fixing the deployment's env, then retrying from
    // the UI (src/JobRow.tsx only shows Retry when this succeeds).
    vi.stubEnv("X_MD_API_KEY", "test-key");
    vi.stubEnv("RAW_CAPTURE_URL", "https://capture.example/captures");
    await expect(operator.mutation(api.jobs.retry, { jobId })).resolves.toBeNull();

    const retried = await t.run((ctx) => ctx.db.get(jobId));

    expect(retried?.status).toBe("queued");
  });
});
