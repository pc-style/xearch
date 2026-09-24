import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import schema from "../convex/schema";
import type { Id } from "../convex/_generated/dataModel";
import type { ProviderLimit } from "../convex/limits";
import ProviderLimits from "../src/library/ProviderLimits";

/**
 * Workflow-run scenario evidence (to-do.md P0 "Provider limits" +
 * acceptance check "Provider throttling shows the real reason and retry
 * time. No provider allowance data means 'unknown'. Historical application
 * caps do not appear as current limits.").
 *
 * Drives the REAL backend query (convex/limits.ts, against a convex-test
 * in-memory local deployment seeded from the real schema) and feeds its
 * REAL return value into the REAL UI component (src/library/ProviderLimits)
 * via react-dom/server, then prints what came out. Nothing under search/
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

function renderPanel(limits: ProviderLimit[] | undefined): string {
  return renderToStaticMarkup(createElement(ProviderLimits, { limits, isAuthenticated: true }));
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
    const html = renderPanel(result as ProviderLimit[]);
    console.log(
      "PART1 rendered UI contains 'today's import limit':",
      html.includes("today's import limit"),
    );
    console.log(
      "PART1 rendered UI has a 'No throttling reported' badge for each of xmd/receiver/search:",
      html.includes("x.md:") &&
        html.includes("Raw-capture receiver:") &&
        html.includes("Search backend:"),
    );
    expect(html).not.toContain("today's import limit");
    // One badge per provider, each reading "No throttling reported" (a 4th,
    // non-badge occurrence of the same phrase is the panel's own explanatory
    // footer sentence — expected, not a duplicate badge).
    expect(html.match(/No throttling reported/g) ?? []).toHaveLength(4);
    expect(html).toContain("x.md:");
    expect(html).toContain("Raw-capture receiver:");
    expect(html).toContain("Search backend:");
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

    const html = renderPanel([
      result,
      { kind: "none", provider: "receiver" },
      { kind: "none", provider: "search" },
    ]);

    const expectedRetryText = new Date(observedAt + 30_000).toLocaleTimeString();
    console.log(
      "PART2 rendered UI contains real reason:",
      html.includes("x.md rate limit reached: 429 from /v2/history."),
    );
    console.log(
      "PART2 rendered UI contains computed retry time:",
      html.includes(expectedRetryText),
    );
    console.log("PART2 rendered UI contains remaining count:", html.includes("3 remaining"));
    expect(html).toContain("x.md rate limit reached: 429 from /v2/history.");
    expect(html).toContain("3 remaining");
    expect(html).toContain(`Next retry around ${expectedRetryText}`);
  });

  it("part 3: a live throttle with NO provider allowance data renders as honestly unknown, never 0 or invented", async () => {
    const t = convexTest(schema, modules);
    const a = await withUser(t);
    const observedAt = Date.now();
    await t.run((ctx) =>
      ctx.db.insert("providerThrottleEvents", {
        provider: "search",
        operation: "query",
        reason: "search service returned 429 with no allowance header.",
        // remaining and resetAt deliberately omitted — the provider did not say.
        retryAfterMs: 5_000,
        observedAt,
      }),
    );
    const result = await a.query(limitsCurrent, { provider: "search" });
    console.log("PART3 limits.current('search') with no allowance data:", JSON.stringify(result));
    expect(result).toMatchObject({ kind: "throttled", remaining: { kind: "unknown" } });
    expect(result).not.toHaveProperty("resetAt");

    // SAFETY: `limitsCurrent` is called through `anyApi` (untyped `any`) —
    // see PART1's identical note above — but the `toMatchObject` assertion
    // just above already proved this value is a throttled ProviderLimit.
    const html = renderPanel([
      { kind: "none", provider: "xmd" },
      { kind: "none", provider: "receiver" },
      result as ProviderLimit,
    ]);

    console.log(
      "PART3 rendered UI contains 'remaining allowance unknown':",
      html.includes("remaining allowance unknown"),
    );
    console.log(
      "PART3 rendered UI contains a fabricated '0 remaining':",
      html.includes("0 remaining"),
    );
    console.log(
      "PART3 rendered UI contains a 'resets' clause (should not, resetAt absent):",
      html.includes(", resets"),
    );
    expect(html).toContain("remaining allowance unknown");
    expect(html).not.toContain("0 remaining");
    expect(html).not.toContain(", resets");
  });
});
