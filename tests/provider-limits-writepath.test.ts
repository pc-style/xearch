import { describe, expect, it, vi, afterEach } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

const modules = import.meta.glob("../convex/**/*.ts");

/**
 * Closes the gap convex/limits.ts documents against itself: the query and the
 * dashboard panel were complete and tested, but NOTHING in product code ever
 * wrote a providerThrottleEvents row, so the panel read "no throttling
 * reported" in production even while x.md was actively refusing us. These
 * tests drive the real acquisition path with a stubbed transport and assert
 * the row arrives at the dashboard query — not by inserting a synthetic row.
 */

async function setup() {
  const t = convexTest(schema, modules);
  const alice = await t.run((ctx) => ctx.db.insert("users", { isAnonymous: true }));
  return { t, alice, a: t.withIdentity({ subject: `${alice}|session` }) };
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

/** The exact problem body production retained from a real x.md 429. */
const RATE_LIMITED_BODY = {
  type: "https://x.pcstyle.dev/docs/reliability#rate-limited",
  title: "Rate limit exceeded",
  status: 429,
  detail: "Too many bulk imports for this API key: 20 per 15 minutes.",
  code: "rate_limited",
  resolution: "Wait the number of seconds in the `Retry-After` header, then retry.",
  retry_after: 423,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("provider throttling reaches the dashboard from the real acquisition path", () => {
  it("records what x.md said on a 429 and reports it as the current limit", async () => {
    const { t, alice, a } = await setup();
    vi.stubEnv("X_MD_API_KEY", "test-key");
    vi.stubEnv("RAW_CAPTURE_URL", "https://capture.example/captures");
    vi.stubEnv("COLLECTOR_MODE", "receiver");

    // Nothing is currently known: an empty table must say so, never invent a
    // "not throttled" claim.
    const before = await a.query(api.limits.all, {});
    expect(before.find((limit) => limit.provider === "xmd")).toEqual({
      kind: "none",
      provider: "xmd",
    });

    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify(RATE_LIMITED_BODY), {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "423",
            "RateLimit-Policy": '"api-ip";q=600;w=60, "import-key";q=20;w=900',
            RateLimit: '"api-ip";r=599;t=27, "import-key";r=3;t=873',
          },
        }),
    );

    const jobId = await queuedJob(t, alice);
    await t.action(internal.importer.run, { jobId });

    const after = await a.query(api.limits.all, {});
    const xmd = after.find((limit) => limit.provider === "xmd");
    expect(xmd?.kind).toBe("throttled");
    if (xmd?.kind !== "throttled") throw new Error("expected a throttled reading");

    // The provider's own words, not ours.
    expect(xmd.reason).toContain("20 per 15 minutes");
    expect(xmd.operation).toBe("profile");
    // The most constraining of the two reported policies (import-key, 3),
    // never the roomier api-ip one.
    expect(xmd.remaining).toEqual({ kind: "known", value: 3 });
    // Retry-After: 423s, applied to the observation time.
    expect(xmd.nextRetryAt).toBeDefined();
    expect(xmd.nextRetryAt! - xmd.observedAt).toBe(423_000);

    // The observation is attached to the run and attempt that saw it, and is
    // a row of its own rather than a reinterpretation of jobs.error.
    const events = await t.run((ctx) => ctx.db.query("providerThrottleEvents").collect());
    expect(events).toHaveLength(1);
    expect(events[0].jobId).toBe(jobId);
    expect(events[0].provider).toBe("xmd");
  });

  it("says the remaining allowance is unknown when the provider did not supply one, instead of reporting zero", async () => {
    const { t, alice, a } = await setup();
    vi.stubEnv("X_MD_API_KEY", "test-key");
    vi.stubEnv("RAW_CAPTURE_URL", "https://capture.example/captures");
    vi.stubEnv("COLLECTOR_MODE", "receiver");

    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify(RATE_LIMITED_BODY), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        }),
    );

    await t.action(internal.importer.run, { jobId: await queuedJob(t, alice) });

    const xmd = (await a.query(api.limits.all, {})).find((limit) => limit.provider === "xmd");
    if (xmd?.kind !== "throttled") throw new Error("expected a throttled reading");
    expect(xmd.remaining).toEqual({ kind: "unknown" });
    expect(xmd.resetAt).toBeUndefined();
    // No Retry-After header, but the body carried retry_after: 423 seconds.
    expect(xmd.nextRetryAt! - xmd.observedAt).toBe(423_000);
  });

  it("leaves a stale jobs.error string out of the current-limit reading entirely", async () => {
    const { t, alice, a } = await setup();
    // A pre-PR#12 style application-cap message left on an old job row. It is
    // free text and indistinguishable from a live limit by content alone,
    // which is exactly why limits.ts must never read it.
    await t.run((ctx) =>
      ctx.db.insert("jobs", {
        owner: alice,
        kind: "bulk",
        input: "someone",
        refresh: false,
        status: "failed",
        count: 0,
        attempt: 1,
        warnings: [],
        error: "Paused at today's import limit. Try again tomorrow.",
        updatedAt: Date.now(),
      }),
    );
    expect((await a.query(api.limits.all, {})).find((l) => l.provider === "xmd")).toEqual({
      kind: "none",
      provider: "xmd",
    });
  });
});
