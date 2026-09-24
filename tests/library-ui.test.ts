// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { getFunctionName } from "convex/server";
import type { FunctionReturnType, UserIdentityAttributes } from "convex/server";
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

type OperatorConfig = FunctionReturnType<typeof api.integrations.operator>;

// Named (not anonymous) so a mutable field like `config` keeps its full
// declared union — an inferred/`satisfies` literal type would instead pin
// it to `undefined`, the only value the initializer below actually uses,
// and reject every later `mockState.config = {...}` fixture assignment.
interface MockState {
  isAuthenticated: boolean;
  connected: boolean;
  responses: Map<string, unknown>;
  // CodeRabbit (PR #48): <Library> no longer queries `api.integrations.operator`
  // itself — the integrator (src/Dashboard.tsx) passes its own `config`/
  // `liveNow` down as props instead, so this fixture feeds those directly
  // rather than through the `responses` map `setQuery` populates.
  config: OperatorConfig | undefined;
  liveNow: number;
}

const mockState: MockState = {
  isAuthenticated: true,
  connected: true,
  responses: new Map<string, unknown>(),
  config: undefined,
  liveNow: Date.now(),
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
  mockState.config = undefined;
  mockState.liveNow = Date.now();
  // AccountRow's own mount-time scroll ref reads `location.hash` — clear it
  // between tests so one test's `#account-<id>` target can never leak into
  // the next and change whether its rows try to scroll.
  window.history.replaceState(null, "", "/");
}

function setQuery<T>(ref: Parameters<typeof getFunctionName>[0], value: T) {
  mockState.responses.set(getFunctionName(ref), value);
}

function renderLibrary(): string {
  const { container, unmount } = renderLibraryToContainer();
  const html = container.innerHTML;

  unmount();

  return html;
}

/**
 * Same render as `renderLibrary`, but keeps the container mounted (and
 * attached to `document.body`, which real click dispatch needs) so a test
 * can interact with it — e.g. clicking a row's "Show history" toggle, which
 * now also reveals the publication notes AccountRow.tsx moved behind it
 * (QA finding 5, /tmp/issues-t3-dashboard-current.md #5's row-compaction
 * fix).
 */
function renderLibraryToContainer(otherImports?: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
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
        createElement(Library, {
          ensureSession: () => Promise.resolve(),
          config: mockState.config,
          liveNow: mockState.liveNow,
          onOpenQueue: () => {},
          otherImports,
        }),
      ),
    );
  });

  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

// Clicks every ".library-row-toggle" button found (there is one per
// <AccountRow>), so a test with a single fixture row can expand it without
// needing to know its position in the (now paginated) list.
function expandAllRows(container: HTMLElement) {
  const toggles = container.querySelectorAll<HTMLButtonElement>(".library-row-toggle");

  for (const toggle of toggles) act(() => toggle.click());
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
    const { container, unmount } = renderLibraryToContainer();
    // The failed badge and the searchable count stay in the row's default
    // one-line view; the "still-good corpus" note and the raw publication
    // error are publication notes, so QA finding 5's row compaction moved
    // them behind "Show history" — expand it to reach them.
    expect(container.innerHTML).toContain("Publication failed");
    expect(container.innerHTML).toContain("2,500 posts");
    expect(container.innerHTML).not.toContain("The previously confirmed index still has");
    expandAllRows(container);
    const html = container.innerHTML;
    expect(html).toContain("The previously confirmed index still has");
    expect(html).toContain("2,500 posts");
    expect(html).toContain("publish rejected: schema mismatch");
    // The exact strings to-do.md P0 calls out for removal must never appear
    // in this component tree's own output.
    expect(html).not.toContain("Downloads aren't searchable yet");
    expect(html).not.toContain("Search will be available when the search backend is connected.");
    unmount();
  });

  it("shows the deep-history backfill's own one-line summary, distinct from the searchable count", () => {
    reset();

    const running = makeRow({
      accountId: accountId("acct-backfill-running"),
      handle: "theo",
      name: "Theo",
      searchablePostCount: { kind: "known", unit: "posts", value: 4_087 },
      backfill: {
        status: "running",
        postsFound: 12_340,
        cursorUntil: "2019-03-01",
        joined: "2011-06-01",
      },
    });

    setQuery(api.library.rows, { rows: [running], truncated: false });
    setQuery(summaryQuery, makeSummary());
    setQuery(healthQuery, makeHealth());
    // QA finding 5's row compaction moved the backfill summary line behind
    // "Show history" along with the rest of a row's publication notes.
    const runningRender = renderLibraryToContainer();
    expandAllRows(runningRender.container);
    expect(runningRender.container.innerHTML).toContain(
      "Older history: 12,340 posts downloaded so far · downloading back to 2019-03-01 (joined 2011-06-01)",
    );
    runningRender.unmount();

    reset();

    const complete = makeRow({
      accountId: accountId("acct-backfill-complete"),
      handle: "theo",
      name: "Theo",
      backfill: { status: "complete", postsFound: 61_208, cursorUntil: "2006-03-21" },
    });

    setQuery(api.library.rows, { rows: [complete], truncated: false });
    setQuery(summaryQuery, makeSummary());
    setQuery(healthQuery, makeHealth());
    const completeRender = renderLibraryToContainer();
    expandAllRows(completeRender.container);
    expect(completeRender.container.innerHTML).toContain(
      "Older history download complete: 61,208 posts downloaded; search publication is separate",
    );
    completeRender.unmount();

    reset();

    const stopped = makeRow({
      accountId: accountId("acct-backfill-stopped"),
      handle: "theo",
      name: "Theo",
      backfill: {
        status: "stopped",
        postsFound: 900,
        cursorUntil: "2018-01-01",
        error: "x.md could not finish this request (500).",
      },
    });

    setQuery(api.library.rows, { rows: [stopped], truncated: false });
    setQuery(summaryQuery, makeSummary());
    setQuery(healthQuery, makeHealth());
    const stoppedRender = renderLibraryToContainer();
    expandAllRows(stoppedRender.container);
    expect(stoppedRender.container.innerHTML).toContain(
      "Older history stopped: x.md could not finish this request (500).",
    );
    stoppedRender.unmount();
  });

  // /tmp/issues.md items 1 and 2: Theo's base import reads "Download
  // complete · Last run 11m ago" while an older-history backfill is
  // actively downloading behind it, and the Active queue strip says
  // "Nothing is downloading right now" for the exact same account at the
  // exact same moment — because it only ever looked at `latestJob` (always
  // the base "bulk" import; convex/lib/accounts.ts ACCOUNT_JOB_KIND), never
  // `historyJob` (the backfill's own current window job).
  it("shows a running deep-history backfill in the Active queue and as the account row's own headline, even though its own base import is already complete", () => {
    reset();

    const theo = makeRow({
      accountId: accountId("acct-theo"),
      handle: "theo",
      name: "Theo",
      searchablePostCount: { kind: "known", unit: "posts", value: 5_138 },
      latestJob: {
        jobId: jobId("base-import"),
        status: "complete",
        updatedAt: Date.now() - 11 * 60_000,
      },
      historyJob: {
        jobId: jobId("history-window"),
        status: "running",
        updatedAt: Date.now() - 30_000,
        since: "2025-11-01",
        until: "2025-12-01",
      },
      backfill: {
        status: "running",
        postsFound: 0,
        cursorUntil: "2025-11-01",
      },
    });

    setQuery(api.library.rows, { rows: [theo], truncated: false });
    setQuery(summaryQuery, makeSummary());
    setQuery(healthQuery, makeHealth());
    const html = renderLibrary();

    // The Active queue strip now includes this account, labelled with its
    // handle and the backfill's own dated window.
    expect(html).not.toContain("Nothing is downloading right now.");
    expect(html).toContain("@theo");
    expect(html).toContain("older history 2025-11 → 2025-12");
    // The account row's own headline reflects the backfill, not the base
    // import's stale "Download complete" state.
    expect(html).toContain("Downloading older history");
  });

  // CodeRabbit (PR #63): `activeHistoryJob` can be "queued" or "running" —
  // a queued backfill has not started downloading anything yet, so it must
  // not read "Downloading older history" in either the badge or the state
  // line, the same distinction the base-import badge already makes via
  // `acquisitionStatusLabel`.
  it("labels a queued (not yet running) deep-history backfill distinctly from a running one", () => {
    reset();

    const queued = makeRow({
      accountId: accountId("acct-queued-backfill"),
      handle: "theo",
      name: "Theo",
      latestJob: { jobId: jobId("base-import"), status: "complete", updatedAt: Date.now() },
      historyJob: {
        jobId: jobId("history-window"),
        status: "queued",
        updatedAt: Date.now(),
        since: "2025-11-01",
        until: "2025-12-01",
      },
    });

    setQuery(api.library.rows, { rows: [queued], truncated: false });
    setQuery(summaryQuery, makeSummary());
    setQuery(healthQuery, makeHealth());
    const html = renderLibrary();

    expect(html).toContain("Older history queued");
    expect(html).not.toContain("Downloading older history");
  });

  // CodeRabbit (PR #63): a person can start a fresh base-import refresh
  // while an earlier backfill window is still running, so both `latestJob`
  // and `historyJob` can be active at once. The Active queue strip's Stop
  // button must target the SAME job src/library/AccountRow.tsx itself
  // displays and stops for this account (its own `activeHistoryJob` always
  // wins), or the two controls could stop two different jobs.
  it("prefers the active history job over an active base import when both are queued/running at once", () => {
    reset();

    const both = makeRow({
      accountId: accountId("acct-both-active"),
      handle: "theo",
      name: "Theo",
      latestJob: { jobId: jobId("base-import"), status: "running", updatedAt: Date.now() },
      historyJob: {
        jobId: jobId("history-window"),
        status: "running",
        updatedAt: Date.now(),
        since: "2025-11-01",
        until: "2025-12-01",
      },
    });

    setQuery(api.library.rows, { rows: [both], truncated: false });
    setQuery(summaryQuery, makeSummary());
    setQuery(healthQuery, makeHealth());
    const html = renderLibrary();

    // Exactly one active-queue row for this account, and it's the backfill
    // window's own label, not the base import's.
    expect(html).toContain("older history 2025-11 → 2025-12");
    expect(html).toContain("Downloading older history");
  });

  // CodeRabbit (PR #63, Major): src/library/QueueTimeline.tsx's "Show in
  // dashboard" sets `location.hash` right after calling `close()`, before
  // this row exists in the DOM (App.tsx mounts the Queue page and the
  // dashboard from separate, mutually exclusive branches) — the browser's
  // own native hash-scroll fires too early and never retries once the row
  // later mounts. AccountRow's own mount-time ref is what actually does the
  // scroll instead, checking the SAME `location.hash` once it has a real
  // element to scroll.
  it("scrolls its own row into view on mount when location.hash already names its account, and clears the hash after", () => {
    reset();
    const scrollIntoView = vi.fn();
    // jsdom has no real layout, so `Element.prototype.scrollIntoView` isn't
    // implemented — stub it to observe the call.
    Element.prototype.scrollIntoView = scrollIntoView;
    window.history.replaceState(null, "", "/?dashboard=1#account-acct-targeted");

    const targeted = makeRow({
      accountId: accountId("acct-targeted"),
      handle: "theo",
      name: "Theo",
    });

    setQuery(api.library.rows, { rows: [targeted], truncated: false });
    setQuery(summaryQuery, makeSummary());
    setQuery(healthQuery, makeHealth());
    renderLibrary();

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe("");
  });

  it("does not scroll a row whose account the hash does not name", () => {
    reset();
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    window.history.replaceState(null, "", "/?dashboard=1#account-someone-else");

    const other = makeRow({
      accountId: accountId("acct-not-targeted"),
      handle: "theo",
      name: "Theo",
    });

    setQuery(api.library.rows, { rows: [other], truncated: false });
    setQuery(summaryQuery, makeSummary());
    setQuery(healthQuery, makeHealth());
    renderLibrary();

    expect(scrollIntoView).not.toHaveBeenCalled();
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

    mockState.config = {
      ...baseConfig,
      handoff: true,
      handoffState: { kind: "live" as const, lastSeenAt: Date.now() },
    };
    const online = renderLibrary();
    expect(online).toContain("Online");
    expect(online).not.toContain("Not configured");

    const lastSeenAt = Date.now() - 5 * 60_000;
    mockState.config = {
      ...baseConfig,
      handoff: false,
      handoffState: { kind: "live" as const, lastSeenAt },
    };
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

  it("keeps a service's ticking 'last success' detail outside its polite live region (coordinator follow-up)", () => {
    reset();
    setQuery(api.library.rows, { rows: [], truncated: false });
    setQuery(summaryQuery, makeSummary());

    const health: ServiceStatus[] = [
      {
        service: "indexer",
        kind: "known",
        healthy: true,
        stale: false,
        observedAt: Date.now(),
        lastSuccessAt: Date.now() - 3 * 60_000,
      },
      { service: "receiver", kind: "unknown" },
      { service: "search", kind: "unknown" },
    ];

    setQuery(healthQuery, health);
    const html = renderLibrary();
    // CodeRabbit (PR #48): only the service's actual result ("Search
    // indexer: Healthy") sits in the live region — "(last success 3m ago)"
    // is recomputed on every `liveNow` re-render whether or not health
    // changed, so it must sit outside the region or it re-announces
    // unchanged status text every few seconds.
    expect(html).toContain('<span aria-live="polite">Search indexer: Healthy</span>');
    expect(html).not.toMatch(/aria-live="polite">[^<]*last success/);
    expect(html).toContain("(last success");
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

// QA finding 5 (/tmp/issues-t3-dashboard-current.md #5): "The dashboard
// remains a very long unpaginated job wall at real data volume... Put
// current work before the library and compact or paginate the library."
describe("Library section order, row compaction, and library pagination (QA finding 5)", () => {
  it("puts the active queue and other imports ahead of the account library, which renders last", () => {
    reset();
    setQuery(api.library.rows, { rows: [], truncated: false });
    setQuery(summaryQuery, makeSummary());
    setQuery(healthQuery, makeHealth());

    const { container, unmount } = renderLibraryToContainer(
      createElement(
        "section",
        { "aria-label": "Other imports" },
        createElement("h2", null, "Other imports"),
      ),
    );

    const html = container.innerHTML;
    const queueAt = html.indexOf("Active queue");
    const otherImportsAt = html.indexOf("Other imports");
    const recentAt = html.indexOf("Recent run history");
    const libraryAt = html.indexOf("Account library");

    expect(queueAt).toBeGreaterThan(-1);
    expect(otherImportsAt).toBeGreaterThan(-1);
    expect(recentAt).toBeGreaterThan(-1);
    expect(libraryAt).toBeGreaterThan(-1);
    // Active queue leads, other imports comes directly after it, and the
    // (potentially 49-row) account library is last — never buried above
    // the current-work sections the way it used to sit.
    expect(queueAt).toBeLessThan(otherImportsAt);
    expect(otherImportsAt).toBeLessThan(recentAt);
    expect(recentAt).toBeLessThan(libraryAt);
    unmount();
  });

  it("renders an account row as one compact line by default, with details behind 'Show history'", () => {
    reset();

    const row = makeRow({
      accountId: accountId("acct-compact"),
      handle: "compact",
      name: "Compact Co",
      publicationState: "failed",
      searchablePostCount: { kind: "known", unit: "posts", value: 42 },
      lastPublishedAt: Date.now(),
      lastError: { message: "publish rejected: timeout", observedAt: Date.now() },
      backfill: { status: "running", postsFound: 100, cursorUntil: "2020-01-01" },
      latestJob: { jobId: jobId("job-compact"), status: "complete", updatedAt: Date.now() },
    });

    setQuery(api.library.rows, { rows: [row], truncated: false });
    setQuery(summaryQuery, makeSummary());
    setQuery(healthQuery, makeHealth());

    const { container, unmount } = renderLibraryToContainer();
    const collapsedHtml = container.innerHTML;

    // Always visible: identity, status badges, searchable count.
    expect(collapsedHtml).toContain("@compact");
    expect(collapsedHtml).toContain("Publication failed");
    expect(collapsedHtml).toContain("42 posts");
    // Publication notes stay collapsed until "Show history" is clicked.
    expect(collapsedHtml).not.toContain("Last published");
    expect(collapsedHtml).not.toContain("publish rejected: timeout");
    expect(collapsedHtml).not.toContain("Older history");
    expect(collapsedHtml).toContain("Show history");

    expandAllRows(container);
    const expandedHtml = container.innerHTML;

    expect(expandedHtml).toContain("Last published");
    expect(expandedHtml).toContain("publish rejected: timeout");
    expect(expandedHtml).toContain("Older history");
    expect(expandedHtml).toContain("Hide history");
    unmount();
  });

  it("shows the completion caveat once above the list, not once per completed account", () => {
    reset();

    const rows = [
      makeRow({
        accountId: accountId("acct-a"),
        handle: "aaa",
        latestJob: { jobId: jobId("job-a"), status: "complete", updatedAt: Date.now() },
      }),
      makeRow({
        accountId: accountId("acct-b"),
        handle: "bbb",
        latestJob: { jobId: jobId("job-b"), status: "complete", updatedAt: Date.now() },
      }),
      makeRow({
        accountId: accountId("acct-c"),
        handle: "ccc",
        latestJob: { jobId: jobId("job-c"), status: "failed", updatedAt: Date.now() },
      }),
    ];

    setQuery(api.library.rows, { rows, truncated: false });
    setQuery(summaryQuery, makeSummary());
    setQuery(healthQuery, makeHealth());
    const html = renderLibrary();
    // RecentActivity already carries its own copy of this note (a separate
    // section, unaffected by this row-level dedupe) — the account library
    // section itself must show it exactly once, not once per completed row.
    const inAccountLibrary = html.slice(html.indexOf('id="account-library"'));

    expect(
      inAccountLibrary.match(
        /"Download complete" means x\.md finished handing over what it had for this run/g,
      ) ?? [],
    ).toHaveLength(1);
  });

  it("paginates the account library to 20 rows by default, revealing more via 'Show more'", () => {
    reset();

    const rows = Array.from({ length: 25 }, (_, i) =>
      makeRow({
        accountId: accountId(`acct-${i}`),
        handle: `user${i}`,
        name: `User ${i}`,
      }),
    );

    setQuery(api.library.rows, { rows, truncated: false });
    setQuery(summaryQuery, makeSummary());
    setQuery(healthQuery, makeHealth());

    const { container, unmount } = renderLibraryToContainer();
    expect(container.querySelectorAll(".library-row").length).toBe(20);
    const showMore = container.querySelector<HTMLButtonElement>(".library-show-more");

    expect(showMore).not.toBeNull();
    expect(showMore!.textContent).toContain("5 more");

    act(() => showMore!.click());

    expect(container.querySelectorAll(".library-row").length).toBe(25);
    expect(container.querySelector(".library-show-more")).toBeNull();
    unmount();
  });
});
