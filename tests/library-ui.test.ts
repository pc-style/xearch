import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getFunctionName } from "convex/server";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import type { AccountLibraryRow, DashboardSummary } from "../convex/lib/contracts";
import type { ServiceStatus } from "../convex/summary";
import { summaryQuery, healthQuery } from "../src/library/summaryApi";
import { limitsAllQuery } from "../src/library/limitsApi";
import type { ProviderLimit } from "../convex/limits";

/**
 * A rendered-DOM smoke test for src/library/*.tsx (to-do.md P0 "Replace the
 * job wall with an account library"). Previous verifier passes on this unit
 * found tsc/lint-level evidence only and no proof the component tree
 * actually renders its claimed states — this fills that gap by rendering
 * <Library> to static markup (react-dom/server, no jsdom dependency needed)
 * against mocked convex/react hooks, and asserting on the real output
 * string, not on the source text.
 *
 * `convex/react`'s hooks are mocked; `getFunctionName` (the real
 * implementation from convex/server) is used inside the mock to route each
 * `useQuery` call to a fixture by the query's own module:export name, the
 * same mechanism Convex itself uses — see convex/server/api.js.
 */

const mockState = vi.hoisted(() => ({
  isAuthenticated: true,
  connected: true,
  responses: new Map<string, unknown>(),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: mockState.isAuthenticated }),
  useConvexConnectionState: () => ({ isWebSocketConnected: mockState.connected }),
  useQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) => {
    if (args === "skip") return undefined;
    return mockState.responses.get(getFunctionName(ref));
  },
  useMutation: () => vi.fn().mockResolvedValue(undefined),
}));

import Library from "../src/library/Library";

function accountId(id: string) {
  return id as unknown as Id<"accounts">;
}
function jobId(id: string) {
  return id as unknown as Id<"jobs">;
}

function makeSummary(overrides: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    indexedPosts: { kind: "known", unit: "posts", value: 0 },
    indexedAccounts: { kind: "known", unit: "accounts", value: 0 },
    queue: {
      waitingDownloads: { kind: "known", unit: "jobs", value: 0 },
      activeDownloads: { kind: "known", unit: "jobs", value: 0 },
      savedCapturesAwaitingIndexing: { kind: "known", unit: "captures", value: 0 },
      failedRetryable: { kind: "known", unit: "jobs", value: 0 },
    },
    scope: { kind: "global" },
    observedAt: Date.now(),
    ...overrides,
  };
}

function makeHealth(): ServiceStatus[] {
  return [
    { service: "indexer", kind: "unknown" },
    { service: "receiver", kind: "unknown" },
    { service: "search", kind: "unknown" },
  ];
}

function makeRow(overrides: Partial<AccountLibraryRow> = {}): AccountLibraryRow {
  return {
    accountId: accountId("acct1"),
    handle: "adam",
    name: "Adam",
    publicationState: "searchable",
    searchablePostCount: { kind: "known", unit: "posts", value: 100 },
    nextAction: { kind: "none" },
    ...overrides,
  };
}

function reset() {
  mockState.isAuthenticated = true;
  mockState.connected = true;
  mockState.responses = new Map();
}

function setQuery(ref: Parameters<typeof getFunctionName>[0], value: unknown) {
  mockState.responses.set(getFunctionName(ref), value);
}

function renderLibrary() {
  return renderToStaticMarkup(createElement(Library, { ensureSession: () => Promise.resolve() }));
}

describe("Library (src/library/Library.tsx) rendered output", () => {
  it("renders explicit, distinguishable loading states before any query resolves", () => {
    reset();
    // summary/health/library.rows all left unset in mockState.responses ->
    // useQuery returns undefined for each, which is the real "still loading"
    // shape (never "skip", since isAuthenticated is true).
    const html = renderLibrary();
    expect(html).toContain("Loading overview");
    expect(html).toContain("Loading queue");
    expect(html).toContain("Loading your account library");
    // Section labels the to-do.md "compact layout" bullet names must be the
    // actual rendered output, not just source text.
    expect(html).toContain("Overview");
    expect(html).toContain("Active queue");
    expect(html).toContain("Account library");
  });

  it("renders the empty state distinctly from loading once queries resolve with no data", () => {
    reset();
    setQuery(api.library.rows, []);
    setQuery(summaryQuery, makeSummary());
    setQuery(healthQuery, makeHealth());
    const html = renderLibrary();
    expect(html).not.toContain("Loading overview");
    // renderToStaticMarkup HTML-escapes quotes/apostrophes in text nodes.
    expect(html).toContain("No accounts imported yet. Start an");
    expect(html).toContain("Account history");
    expect(html).toContain("Nothing is downloading right now.");
  });

  it("renders an offline/reconnecting state without discarding the last data received", () => {
    reset();
    mockState.connected = false;
    const row = makeRow();
    setQuery(api.library.rows, [row]);
    setQuery(
      summaryQuery,
      makeSummary({ indexedAccounts: { kind: "known", unit: "accounts", value: 1 } }),
    );
    setQuery(healthQuery, makeHealth());
    const html = renderLibrary();
    expect(html).toContain("Reconnecting to Convex");
    expect(html).toContain("reflect the last data this page received");
    // The account row itself must still be visible while offline, not
    // replaced by a generic error.
    expect(html).toContain("@adam");
  });

  it("shows a failed publication next to its still-good corpus, and never the removed contradictory copy", () => {
    reset();
    const failedButIndexed = makeRow({
      accountId: accountId("acct-failed"),
      handle: "big",
      name: "Big Account",
      publicationState: "failed",
      searchablePostCount: { kind: "known", unit: "posts", value: 2_500 },
      lastError: { message: "publish rejected: schema mismatch", observedAt: Date.now() },
      latestJob: {
        jobId: jobId("job1"),
        status: "complete",
        updatedAt: Date.now(),
      },
    });
    setQuery(api.library.rows, [failedButIndexed]);
    setQuery(summaryQuery, makeSummary());
    setQuery(healthQuery, makeHealth());
    const html = renderLibrary();
    expect(html).toContain("Publication failed");
    expect(html).toContain("The previously confirmed index still has");
    expect(html).toContain("2,500 posts");
    expect(html).toContain("publish rejected: schema mismatch");
    // The exact strings to-do.md P0 calls out for removal must never appear
    // in this component tree's own output.
    expect(html).not.toContain("Downloads aren't searchable yet");
    expect(html).not.toContain("Search will be available when the search backend is connected.");
  });

  it("renders an explicit unauthenticated/offline-from-data state", () => {
    reset();
    mockState.isAuthenticated = false;
    const html = renderLibrary();
    expect(html).toContain("Connect to see the accounts you");
    expect(html).toContain("ve imported.");
    expect(html).toContain("Connect to my library");
    expect(html).not.toContain("No accounts imported yet");
  });

  it("renders provider limits honestly: none observed vs. a real throttle fact, never jobs.error", () => {
    reset();
    setQuery(api.library.rows, []);
    setQuery(summaryQuery, makeSummary());
    setQuery(healthQuery, makeHealth());
    const limits: ProviderLimit[] = [
      { kind: "none", provider: "xmd" },
      {
        kind: "throttled",
        provider: "receiver",
        operation: "handoff",
        reason: "Too many requests",
        remaining: { kind: "unknown" },
        observedAt: Date.now(),
      },
      { kind: "none", provider: "search" },
    ];
    setQuery(limitsAllQuery, limits);
    const html = renderLibrary();
    expect(html).toContain("Provider limits");
    expect(html).toContain("No throttling reported");
    expect(html).toContain("Throttled on handoff");
    expect(html).toContain("Too many requests");
    expect(html).toContain("remaining allowance unknown");
  });

  it("shows the provider-limits panel as loading, distinctly, before that query resolves", () => {
    reset();
    setQuery(api.library.rows, []);
    setQuery(summaryQuery, makeSummary());
    setQuery(healthQuery, makeHealth());
    // limitsAllQuery deliberately left unset in mockState.responses.
    const html = renderLibrary();
    expect(html).toContain("Provider limits");
    expect(html).toContain("x.md: loading…");
  });
});
