// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { getFunctionName } from "convex/server";
import type { UserIdentityAttributes } from "convex/server";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import type { ConvexReactClientOptions } from "convex/react";
import type { Value } from "convex/values";
import type {
  AuthTokenFetcher,
  ConnectionState,
  MutationOptions,
  QueryJournal,
  QueryToken,
} from "convex/browser";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import type { AccountLibraryRow, DashboardSummary } from "../convex/lib/contracts";
import type { ServiceStatus } from "../convex/summary";
import { summaryQuery, healthQuery } from "../src/library/summaryApi";
import { limitsAllQuery } from "../src/library/limitsApi";
import type { ProviderLimit } from "../convex/limits";
import Library from "../src/library/Library";

/**
 * A rendered-DOM smoke test for src/library/*.tsx (to-do.md P0 "Replace the
 * job wall with an account library"). Previous verifier passes on this unit
 * found tsc/lint-level evidence only and no proof the component tree
 * actually renders its claimed states — this fills that gap by rendering
 * <Library> against a *real* `ConvexReactClient` and asserting on the
 * actual rendered DOM, not on the source text.
 *
 * No module mocking: `convex/react`'s hooks (`useQuery`, `useMutation`,
 * `useConvexAuth`, `useConvexConnectionState`) all run for real. What's
 * faked is only the transport underneath them — a `BaseConvexClientInterface`
 * implementation (see `node_modules/convex/src/browser/sync/client.ts`) that
 * answers `localQueryResult`/`connectionState`/`mutation` from this file's
 * own per-function fixture map, keyed by `getFunctionName` exactly the way
 * `ConvexReactClient.watchQuery` itself keys queries (see
 * `node_modules/convex/src/react/client.ts`). `useConvexAuth` needs a real
 * `ConvexProviderWithAuth` (`node_modules/convex/src/react/ConvexAuthState.tsx`)
 * above the tree, which resolves auth via a `useEffect` — so this renders
 * with `react-dom/client`'s `createRoot` inside `act()` (jsdom environment)
 * rather than `renderToStaticMarkup`, so that effect gets to flush before
 * each assertion.
 */

const mockState = {
  isAuthenticated: true,
  connected: true,
  responses: new Map<string, unknown>(),
};

/**
 * Mirrors `BaseConvexClientInterface`
 * (`node_modules/convex/src/browser/sync/client.ts`) — the surface
 * `ConvexReactClient` calls on whatever it's given as `options.baseClient`.
 * That interface itself is `@internal` and stripped from this package's
 * published `.d.ts`, so it can't be imported; every member here is typed
 * against the same public types (`Value`, `ConnectionState`, `QueryToken`,
 * ...) the real interface uses, so a shape drift between this and the
 * installed `convex` version still fails at the `ConvexReactClientOptions`
 * cast below or at a call site's argument types.
 */
interface FakeBaseConvexClient {
  readonly url: string;
  // `fn` is stored for `PaginatedQueryClient`'s constructor to hold onto but
  // this fake never calls it (no usePaginatedQuery in this component tree,
  // and no live transitions to deliver) — `never` says exactly that: a
  // callback this fake guarantees it will not invoke, as opposed to
  // `unknown`'s "accepts anything, unparsed".
  addOnTransitionHandler(fn: (transition: never) => void): () => void;
  setAuth(
    fetchToken: AuthTokenFetcher,
    onChange: (isAuthenticated: boolean) => void,
    onRefreshChange?: (isRefreshing: boolean) => void,
  ): void;
  setAdminAuth(value: string, fakeUserIdentity?: UserIdentityAttributes): void;
  clearAuth(): void;
  subscribe(
    name: string,
    args?: Record<string, Value>,
  ): { queryToken: QueryToken; unsubscribe: () => void };
  localQueryResult(udfPath: string, args?: Record<string, Value>): Value | undefined;
  localQueryResultByToken(queryToken: QueryToken): Value | undefined;
  hasLocalQueryResultByToken(queryToken: QueryToken): boolean;
  localQueryLogs(udfPath: string, args?: Record<string, Value>): string[] | undefined;
  queryJournal(name: string, args?: Record<string, Value>): QueryJournal | undefined;
  connectionState(): ConnectionState;
  subscribeToConnectionState(cb: (connectionState: ConnectionState) => void): () => void;
  mutation(
    name: string,
    args?: Record<string, Value>,
    options?: MutationOptions,
  ): Promise<Value | undefined>;
  action(name: string, args?: Record<string, Value>): Promise<Value | undefined>;
  close(): Promise<void>;
}

function makeFakeBaseClient(): FakeBaseConvexClient {
  return {
    url: "https://library-ui-test.convex.cloud",
    addOnTransitionHandler: () => () => {},
    setAuth: (_fetchToken, onChange) => {
      // Real clients confirm the token with the server asynchronously; this
      // fake has no server, so it reports the fixture's authenticated state
      // back synchronously, which is what drives `useConvexAuth()`'s result
      // through `ConvexProviderWithAuth`'s own `useEffect`.
      onChange(mockState.isAuthenticated);
    },
    setAdminAuth: () => {},
    clearAuth: () => {},
    subscribe: (name) => ({
      // SAFETY: `QueryToken` is `string & { __queryToken: true }`. This fake
      // never needs collision-proof tokens (there's no real dedupe to do),
      // only a stable per-query-name key for the caller's own bookkeeping.
      queryToken: name as QueryToken,
      unsubscribe: () => {},
    }),
    localQueryResult: (udfPath) =>
      // SAFETY: every fixture reaches this map via `setQuery`, which only
      // ever stores the real return value of a Convex query (a
      // `DashboardSummary`, `ServiceStatus[]`, `ProviderLimit[]`, or a
      // `library.rows` page) — by construction already a legal Convex
      // `Value`. This just recovers that type past the map's `unknown` slot.
      mockState.responses.get(udfPath) as Value | undefined,
    localQueryResultByToken: () => undefined,
    hasLocalQueryResultByToken: () => false,
    localQueryLogs: () => undefined,
    queryJournal: () => undefined,
    connectionState: (): ConnectionState => ({
      hasInflightRequests: false,
      isWebSocketConnected: mockState.connected,
      timeOfOldestInflightRequest: null,
      hasEverConnected: true,
      connectionCount: 1,
      connectionRetries: 0,
      inflightMutations: 0,
      inflightActions: 0,
    }),
    subscribeToConnectionState: () => () => {},
    mutation: () => Promise.resolve(undefined),
    action: () => Promise.resolve(undefined),
    close: () => Promise.resolve(),
  };
}

// SAFETY: `options.baseClient` is a real, working constructor option (see
// `ConvexReactClient`'s `sync` getter in
// `node_modules/convex/src/react/client.ts`, which uses it in place of
// constructing a real `BaseConvexClient`) — it's marked `@internal` and so
// is missing from the published `ConvexReactClientOptions` type, not from
// the runtime. This cast bridges that published-types gap the same way
// `src/library/summaryApi.tsx`'s `anyApi.summary.summary as FunctionReference<...>`
// bridges codegen not having caught up yet.
const convexClient = new ConvexReactClient("https://library-ui-test.convex.cloud", {
  baseClient: makeFakeBaseClient(),
} as ConvexReactClientOptions);

function accountId(id: string) {
  // SAFETY: `Id<"accounts">` is `string & { __tableName: "accounts" }`; the
  // branded type is a subtype of `string`, so this fixture helper's job is
  // exactly to attach that brand to a plain test-authored string.
  return id as Id<"accounts">;
}

function jobId(id: string) {
  // SAFETY: `Id<"jobs">` is `string & { __tableName: "jobs" }`, a subtype of
  // `string`; this fixture helper attaches that brand to a test-authored id.
  return id as Id<"jobs">;
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
    // Nothing has told us about outstanding indexer work, which is
    // "unknown" per unit — never a known zero. See convex/lib/contracts.ts
    // providerQueuedWorkValidator.
    providerQueuedWork: {
      posts: { kind: "unknown", unit: "posts" },
      captures: { kind: "unknown", unit: "captures" },
      jobs: { kind: "unknown", unit: "jobs" },
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

function setQuery<T>(ref: Parameters<typeof getFunctionName>[0], value: T) {
  mockState.responses.set(getFunctionName(ref), value);
}

function renderLibrary(): string {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(
        ConvexProviderWithAuth,
        {
          client: convexClient,
          useAuth: () => ({
            isLoading: false,
            isAuthenticated: mockState.isAuthenticated,
            fetchAccessToken: () => Promise.resolve(null),
          }),
        },
        createElement(Library, { ensureSession: () => Promise.resolve() }),
      ),
    );
  });
  const html = container.innerHTML;

  act(() => {
    root.unmount();
  });

  return html;
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
    setQuery(api.library.rows, { rows: [], truncated: false });
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
    setQuery(api.library.rows, { rows: [row], truncated: false });
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

    setQuery(api.library.rows, { rows: [failedButIndexed], truncated: false });
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

  it("shows a real throttle fact, never jobs.error, and never a permanent 'no throttling' row (B2)", () => {
    reset();
    setQuery(api.library.rows, { rows: [], truncated: false });
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
    expect(html).toContain("Throttled on handoff");
    expect(html).toContain("Too many requests");
    expect(html).toContain("remaining allowance unknown");
    // Only the actually-throttled provider gets a row — the two clear
    // providers are not shown as a permanent "all fine" badge (B2 "hide
    // provider limits unless something is actually throttled").
    expect(html).not.toContain("No throttling reported");
  });

  it("shows no provider-limits panel at all once nothing is throttled or while it is still loading (B2)", () => {
    reset();
    setQuery(api.library.rows, { rows: [], truncated: false });
    setQuery(summaryQuery, makeSummary());
    setQuery(healthQuery, makeHealth());
    setQuery(limitsAllQuery, [
      { kind: "none", provider: "xmd" },
      { kind: "none", provider: "receiver" },
      { kind: "none", provider: "search" },
    ]);
    const resolvedClear = renderLibrary();
    expect(resolvedClear).not.toContain("Provider limits");

    // limitsAllQuery deliberately left unset for this render -> still loading.
    reset();
    setQuery(api.library.rows, { rows: [], truncated: false });
    setQuery(summaryQuery, makeSummary());
    setQuery(healthQuery, makeHealth());
    const stillLoading = renderLibrary();
    expect(stillLoading).not.toContain("Provider limits");
  });

  it("renders one merged status block with connections, health, and no env var names (B2)", () => {
    reset();
    setQuery(api.library.rows, { rows: [], truncated: false });
    setQuery(summaryQuery, makeSummary());
    setQuery(healthQuery, makeHealth());
    const html = renderLibrary();
    expect(html).toContain("Status");
    expect(html).toContain("x.md");
    expect(html).toContain("AgentMail");
    expect(html).not.toContain("SEARCH_API_URL");
    expect(html).not.toContain("X_MD_API_KEY");
    expect(html).not.toContain("AGENTMAIL_API_KEY");
    // The old duplicated disclaimer paragraphs (B1) are gone.
    expect(html).not.toContain("Health is an observed fact");
    expect(html).not.toContain("Configuration status, not a live health check");
  });

  it("labels the download worker by liveness, never by 'Configured'/'Not configured' (coordinator follow-up)", () => {
    reset();
    setQuery(api.library.rows, { rows: [], truncated: false });
    setQuery(summaryQuery, makeSummary());
    setQuery(healthQuery, makeHealth());
    const baseConfig = {
      indexing: true,
      search: true,
      firecrawl: true,
      openai: true,
      email: true,
      xmd: true,
      collectorMode: "outbound" as const,
    };

    setQuery(api.integrations.operator, {
      ...baseConfig,
      handoff: true,
      handoffState: { kind: "live" as const, lastSeenAt: Date.now() },
    });
    const online = renderLibrary();
    expect(online).toContain("Online");
    expect(online).not.toContain("Not configured");

    const lastSeenAt = Date.now() - 5 * 60_000;
    setQuery(api.integrations.operator, {
      ...baseConfig,
      handoff: false,
      handoffState: { kind: "live" as const, lastSeenAt },
    });
    const offline = renderLibrary();
    // CodeRabbit (PR #48): `workerLastSeenAt` is the last heartbeat
    // observed, not the moment the worker went offline — "last seen", not
    // "since".
    expect(offline).toContain("Offline");
    expect(offline).toContain("last seen");
    expect(offline).not.toContain("Offline since");
    // A real configuration fact (x.md's key being set) must still say
    // "Configured" — only the worker's own liveness row switches vocabulary.
    expect(offline).toContain("Configured");
    expect(offline).not.toContain("Not connected");

    // CodeRabbit (PR #48): only the stable status word sits inside the
    // polite live region — the still-ticking "last seen Xm ago" detail
    // must be outside it, or a 30s clock refresh alone would re-announce an
    // unchanged connection status to a screen reader.
    const workerRowMatch = offline.match(
      /Download worker<\/span><span class="library-muted">(.*?)<\/span><\/div>/,
    );
    expect(workerRowMatch).not.toBeNull();
    const workerRowHtml = workerRowMatch![1];
    expect(workerRowHtml).toContain('<span aria-live="polite">Offline</span>');
    expect(workerRowHtml).not.toMatch(/aria-live="polite">[^<]*last seen/);
  });

  it("hides a queued-work tile until the indexer actually reports that unit, and shows it once it does (A4)", () => {
    reset();
    setQuery(api.library.rows, { rows: [], truncated: false });
    setQuery(healthQuery, makeHealth());
    // Default fixture: every providerQueuedWork unit is "unknown" — nothing
    // has ever reported pendingWork. None of the three tiles should render.
    setQuery(summaryQuery, makeSummary());
    const hidden = renderLibrary();
    expect(hidden).not.toContain("Queued posts");
    expect(hidden).not.toContain("Queued captures");
    expect(hidden).not.toContain("Queued indexer jobs");
    expect(hidden).not.toContain("not yet known");

    // Once one unit is actually reported (even as a known 0), only that
    // tile appears — the other two, still never reported, stay hidden.
    setQuery(
      summaryQuery,
      makeSummary({
        providerQueuedWork: {
          posts: { kind: "known", unit: "posts", value: 12 },
          captures: { kind: "unknown", unit: "captures" },
          jobs: { kind: "unknown", unit: "jobs" },
        },
      }),
    );
    const oneKnown = renderLibrary();
    expect(oneKnown).toContain("Queued posts");
    expect(oneKnown).not.toContain("Queued captures");
    expect(oneKnown).not.toContain("Queued indexer jobs");
  });

  it("never repeats a stat tile's own number on a second line (A3)", () => {
    reset();
    setQuery(api.library.rows, { rows: [], truncated: false });
    setQuery(healthQuery, makeHealth());
    setQuery(
      summaryQuery,
      makeSummary({ indexedPosts: { kind: "known", unit: "posts", value: 9_006 } }),
    );
    const html = renderLibrary();
    // The big number appears exactly once — not once as the tile's value and
    // again as a "9,006 posts" sub-line underneath it.
    expect(html.match(/9,006/g) ?? []).toHaveLength(1);
  });
});
