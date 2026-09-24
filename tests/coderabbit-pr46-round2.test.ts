// Regression test for the second CodeRabbit pass on PR #46 (2026-09-24):
// "Label the count as searchable accounts." `summary.indexedAccounts`
// (convex/summary.ts) counts only accounts whose publication state is
// "searchable" — an account that's downloaded but not yet published is
// imported but not counted here, so "Imported accounts" overclaimed what the
// number measures. Rendered with plain renderToStaticMarkup + createElement,
// matching this repo's no-jsdom test convention (see
// tests/signed-out-states.test.ts, which renders the same component).
import { describe, expect, it } from "vitest";
import { renderHtml } from "./solid";
import OverviewStats from "../src/library/OverviewStats";
import type { DashboardSummary } from "../convex/lib/contracts";

function count(value: number): DashboardSummary["indexedPosts"] {
  return { kind: "known", unit: "posts", value };
}

function accountCount(value: number): DashboardSummary["indexedAccounts"] {
  return { kind: "known", unit: "accounts", value };
}

function jobCount(value: number): DashboardSummary["queue"]["waitingDownloads"] {
  return { kind: "known", unit: "jobs", value };
}

function captureCount(value: number): DashboardSummary["queue"]["savedCapturesAwaitingIndexing"] {
  return { kind: "known", unit: "captures", value };
}

const summary: DashboardSummary = {
  indexedPosts: count(9006),
  indexedAccounts: accountCount(5),
  queue: {
    waitingDownloads: jobCount(0),
    activeDownloads: jobCount(0),
    savedCapturesAwaitingIndexing: captureCount(0),
    failedRetryable: jobCount(0),
  },
  providerQueuedWork: {
    posts: { kind: "unknown", unit: "posts" },
    captures: { kind: "unknown", unit: "captures" },
    jobs: { kind: "unknown", unit: "jobs" },
  },
  scope: { kind: "global" },
  observedAt: Date.now(),
};

describe("OverviewStats labels the searchable-account count accurately", () => {
  it("says 'Searchable accounts', not 'Imported accounts'", () => {
    const html = renderHtml(OverviewStats, {
      summary,
      health: undefined,
      limits: undefined,
      config: undefined,
      liveNow: Date.now(),
      connected: true,
      isAuthenticated: true,
    });

    expect(html).toContain("Searchable accounts");
    expect(html).not.toContain("Imported accounts");
  });
});
