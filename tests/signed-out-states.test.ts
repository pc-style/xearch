import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
    const html = renderToStaticMarkup(
      createElement(OverviewStats, {
        summary: undefined,
        health: undefined,
        limits: undefined,
        connected: true,
        ...signedOut,
      }),
    );

    expect(html).not.toMatch(/Loading overview/);
    expect(html).not.toMatch(/loading…/);
    expect(html).toMatch(/Connect to see/);
  });

  it("Active queue and recent history say connect, not load", () => {
    for (const component of [ActiveQueue, RecentActivity]) {
      const html = renderToStaticMarkup(
        createElement(component, { rows: undefined, ...signedOut }),
      );

      expect(html).not.toMatch(/Loading/);
      expect(html).toMatch(/Connect to see/);
    }
  });

  it("Provider limits badges say connect, not loading", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderLimits, { limits: undefined, ...signedOut }),
    );

    expect(html).not.toMatch(/loading…/);
    expect(html).toMatch(/connect to view/);
  });

  it("still shows a real loading state to a signed-in caller whose query is in flight", () => {
    const queue = renderToStaticMarkup(
      createElement(ActiveQueue, { rows: undefined, ...signedIn }),
    );

    expect(queue).toMatch(/Loading queue/);

    const history = renderToStaticMarkup(
      createElement(RecentActivity, { rows: undefined, ...signedIn }),
    );

    expect(history).toMatch(/Loading recent activity/);
  });
});
