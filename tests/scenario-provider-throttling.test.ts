import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "../convex/schema";
import type { Id } from "../convex/_generated/dataModel";
import type { ProviderLimit } from "../convex/limits";
import { mountOps } from "./opsHarness";
import { stripMarkers } from "./solid";

/**
 * Workflow-run scenario evidence (to-do.md P0 "Provider limits" +
 * acceptance check "Provider throttling shows the real reason and retry
 * time. No provider allowance data means 'unknown'. Historical application
 * caps do not appear as current limits.").
 *
 * Drives the REAL backend query (convex/limits.ts, against a convex-test
 * in-memory local deployment seeded from the real schema) and feeds its
 * REAL return value into the REAL UI (the /ops Provider page, src/ops)
 * in jsdom, then prints what came out. Nothing under search/
 * (Rust) is touched. No paid import, no live coordination, nothing merged
 * or deployed. Written to the scratchpad per task instructions, not into
 * product code.
 */

const modules = import.meta.glob("../convex/**/*.ts");

const limitsAll = anyApi.limits.all;

const limitsCurrent = anyApi.limits.current;

async function withUser(t: ReturnType<typeof convexTest>) {
  const userId: Id<"users"> = await t.run((ctx) => ctx.db.insert("users", { isAnonymous: true }));

  return t.withIdentity({ subject: `${userId}|session` });
}

/** The dashboard's Provider page, fed the real x.md limit. */
async function renderPanel(limit: ProviderLimit): Promise<string> {
  const ops = await mountOps("provider", { limit });
  const html = stripMarkers(ops.find(".prov").textContent ?? "");

  ops.unmount();

  return html;
}

describe("scenario: provider throttling — real reason/retry, unknown allowance, no historical leakage", () => {
  it("part 1: a historical 'today's import limit' error on an old job never renders as a current limit", async () => {
    const t = convexTest(schema, modules);
    const userId: Id<"users"> = await t.run((ctx) => ctx.db.insert("users", { isAnonymous: true }));
    // The exact pre-PR#12 daily-cap message, left on an old failed job, with
    // NO providerThrottleEvents row for any provider — i.e. no live throttle
    // fact has ever been recorded.
    await t.run((ctx) =>
      ctx.db.insert("jobs", {
        owner: userId,
        kind: "bulk",
        input: "someone",
        refresh: false,
        status: "failed",
        count: 12,
        attempt: 3,
        warnings: [],
        error:
          "Paused at today's import limit. Your downloaded posts are safe. Try again tomorrow.",
        updatedAt: Date.now(),
      }),
    );
    const a = t.withIdentity({ subject: `${userId}|session` });
    const result = await a.query(limitsAll, {});
    console.log(
      "PART1 limits.all() with only a stale jobs.error on record:",
      JSON.stringify(result),
    );
    expect(result).toEqual([
      { kind: "none", provider: "xmd" },
      { kind: "none", provider: "receiver" },
      { kind: "none", provider: "search" },
    ]);

    // SAFETY: `limitsAll` is called through `anyApi` (untyped `any`) rather
    // than the generated `api` object — see this file's and
    // convex/limits.ts's header comments — but the `toEqual` above just
    // proved this exact value matches convex/limits.ts's real return shape.
    const html = await renderPanel((result as ProviderLimit[])[0]);
    console.log(
      "PART1 rendered UI contains 'today's import limit':",
      html.includes("today's import limit"),
    );
    expect(html).not.toContain("today's import limit");
    // Nothing has ever actually been throttled, and the page says exactly
    // that rather than a limit or a guessed allowance.
    expect(html).toContain("x.md has never reported a rate limit here");
    expect(html).not.toContain("calls left");
  });

  it("part 2: a live throttle with full provider data shows the real reason and a computed retry time", async () => {
    const t = convexTest(schema, modules);
    const a = await withUser(t);
    const observedAt = Date.now();
    await t.run((ctx) =>
      ctx.db.insert("providerThrottleEvents", {
        provider: "xmd",
        operation: "history",
        reason: "x.md rate limit reached: 429 from /v2/history.",
        remaining: 3,
        resetAt: observedAt + 3_600_000,
        retryAfterMs: 30_000,
        observedAt,
      }),
    );
    const result = await a.query(limitsCurrent, { provider: "xmd" });
    console.log(
      "PART2 limits.current('xmd') with a full live throttle event:",
      JSON.stringify(result),
    );
    expect(result).toMatchObject({
      kind: "throttled",
      operation: "history",
      reason: "x.md rate limit reached: 429 from /v2/history.",
      remaining: { kind: "known", value: 3 },
    });

    if (result.kind !== "throttled") throw new Error("expected throttled");
    expect(result.nextRetryAt).toBe(observedAt + 30_000);

    const html = await renderPanel(result);

    const expectedRetryText = new Date(observedAt + 30_000).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
    });

    console.log(
      "PART2 rendered UI contains real reason:",
      html.includes("x.md rate limit reached: 429 from /v2/history."),
    );
    console.log(
      "PART2 rendered UI contains computed retry time:",
      html.includes(expectedRetryText),
    );
    console.log("PART2 rendered UI contains remaining count:", html.includes("3 calls left"));
    expect(html).toContain("x.md rate limit reached: 429 from /v2/history.");
    expect(html).toContain("3 calls left");
    expect(html).toContain(`new work resumes at ${expectedRetryText}`);
  });

  it("part 3: a live throttle with NO provider allowance data renders as honestly unknown, never 0 or invented", async () => {
    const t = convexTest(schema, modules);
    const a = await withUser(t);
    const observedAt = Date.now();
    await t.run((ctx) =>
      ctx.db.insert("providerThrottleEvents", {
        provider: "xmd",
        operation: "search",
        reason: "x.md returned 429 with no allowance header.",
        // remaining and resetAt deliberately omitted — the provider did not say.
        retryAfterMs: 5_000,
        observedAt,
      }),
    );
    const result = await a.query(limitsCurrent, { provider: "xmd" });
    console.log("PART3 limits.current('xmd') with no allowance data:", JSON.stringify(result));
    expect(result).toMatchObject({ kind: "throttled", remaining: { kind: "unknown" } });
    expect(result).not.toHaveProperty("resetAt");

    // SAFETY: `limitsCurrent` is called through `anyApi` (untyped `any`) —
    // see PART1's identical note above — but the `toMatchObject` assertion
    // just above already proved this value is a throttled ProviderLimit.
    const html = await renderPanel(result as ProviderLimit);

    console.log(
      "PART3 rendered UI claims a number of calls left (should not):",
      html.includes("calls left"),
    );
    expect(html).toContain("x.md returned 429 with no allowance header.");
    expect(html).not.toContain("calls left");
    expect(html).toContain("Limited");
  });
});
