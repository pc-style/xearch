import { describe, expect, it } from "vitest";
import { renderHtml } from "./solid";
import OverviewStats from "../src/library/OverviewStats";
import ActiveQueue from "../src/library/ActiveQueue";
import ProviderLimits from "../src/library/ProviderLimits";
import RecentActivity from "../src/library/RecentActivity";

/**
 * A skipped Convex query returns `undefined`, exactly like one still in
 * flight. Before this, a signed-out visitor saw "Loading overview…",
 * "Loading queue…", "Loading recent activity…" and three "loading…" badges
 * that would never resolve, while the account library beside them correctly
 * said "Connect to see the accounts you've imported."
 *
 * to-do.md P0: "Make loading, empty, offline, stale-data, and partial-failure
 * states explicit." Not-signed-in is not loading, and the two must not share
 * a label.
 */
const signedOut = { isAuthenticated: false } as const;

const signedIn = { isAuthenticated: true } as const;

describe("signed-out panels never impersonate a loading state", () => {
  it("Overview asks the visitor to connect instead of loading forever", () => {
    const html = renderHtml(OverviewStats, {
      summary: undefined,
      health: undefined,
      limits: undefined,
      config: undefined,
      liveNow: Date.now(),
      connected: true,
      ...signedOut,
    });

    expect(html).not.toMatch(/Loading overview/);
    expect(html).not.toMatch(/loading…/);
    expect(html).toMatch(/Connect to see/);
  });

  it("Active queue and recent history say connect, not load", () => {
    for (const component of [ActiveQueue, RecentActivity]) {
      const html = renderHtml(component, { rows: undefined, ...signedOut });

      expect(html).not.toMatch(/Loading/);
      expect(html).toMatch(/Connect to see/);
    }
  });

  it("Provider limits render nothing at all while signed out — there is nothing to report yet, not a loading state (B2)", () => {
    const html = renderHtml(ProviderLimits, { limits: undefined, ...signedOut });

    expect(html).toBe("");
  });

  it("still shows a real loading state to a signed-in caller whose query is in flight", () => {
    const queue = renderHtml(ActiveQueue, { rows: undefined, ...signedIn });

    expect(queue).toMatch(/Loading queue/);

    const history = renderHtml(RecentActivity, { rows: undefined, ...signedIn });

    expect(history).toMatch(/Loading recent activity/);
  });
});
