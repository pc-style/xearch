// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { getFunctionName } from "convex/server";
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
import Dashboard from "../src/Dashboard";

/**
 * The coordinator-flagged gap this closes: `jobs.start` is
 * `requireOperator`-gated server-side (convex/access.ts) exactly like
 * Cancel/Retry/Dismiss/Restore, but the dashboard's own "Start an import"
 * submit button was never gated on `isOperator` in the UI — a signed-in
 * non-operator caller would hit a bare ConvexError with no warning, unlike
 * every other provider-spending action in this app. This asserts the
 * submit button disables and the sign-in notice appears once `isOperator`
 * is known to be false, and that neither shows for an operator.
 *
 * Same fake-transport harness as tests/library-ui.test.ts,
 * tests/jobRow-ui.test.ts, and tests/dashboard-job-ui.test.ts: `convex/
 * react`'s hooks run for real, only the transport underneath is faked.
 * Every query this doesn't care about (Library's summary/health/rows/
 * limits) is left unset on purpose — Library already renders an explicit,
 * non-crashing "still loading" state for that (see library-ui.test.ts's
 * first test), which is good enough here.
 */

interface FakeBaseConvexClient {
  readonly url: string;
  addOnTransitionHandler(fn: (transition: never) => void): () => void;
  setAuth(
    fetchToken: AuthTokenFetcher,
    onChange: (isAuthenticated: boolean) => void,
    onRefreshChange?: (isRefreshing: boolean) => void,
  ): void;
  setAdminAuth(value: string): void;
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

interface MockState {
  responses: Map<string, unknown>;
}

const mockState: MockState = { responses: new Map() };

function setQuery<T>(ref: Parameters<typeof getFunctionName>[0], value: T) {
  mockState.responses.set(getFunctionName(ref), value);
}

function makeFakeBaseClient(): FakeBaseConvexClient {
  return {
    url: "https://dashboard-start-form-test.convex.cloud",
    addOnTransitionHandler: () => () => {},
    setAuth: (_fetchToken, onChange) => onChange(true),
    setAdminAuth: () => {},
    clearAuth: () => {},
    // SAFETY: `QueryToken` is `string & { __queryToken: true }`. This fake
    // never needs collision-proof tokens (there's no real dedupe to do),
    // only a stable per-query-name key for the caller's own bookkeeping.
    subscribe: (name) => ({ queryToken: name as QueryToken, unsubscribe: () => {} }),
    // SAFETY: every fixture reaches this map via `setQuery`, which only
    // ever stores the real return value of a Convex query — by
    // construction already a legal Convex `Value`.
    localQueryResult: (udfPath) => mockState.responses.get(udfPath) as Value | undefined,
    localQueryResultByToken: () => undefined,
    hasLocalQueryResultByToken: () => false,
    localQueryLogs: () => undefined,
    queryJournal: () => undefined,
    connectionState: (): ConnectionState => ({
      hasInflightRequests: false,
      isWebSocketConnected: true,
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

// SAFETY: see tests/library-ui.test.ts's identical cast for why
// `baseClient` (an `@internal` constructor option) needs one.
const convexClient = new ConvexReactClient("https://dashboard-start-form-test.convex.cloud", {
  baseClient: makeFakeBaseClient(),
} as ConvexReactClientOptions);

function reset() {
  mockState.responses = new Map();
  setQuery(api.integrations.operator, {
    indexing: true,
    search: true,
    firecrawl: true,
    openai: true,
    email: true,
    xmd: true,
    handoff: true,
    handoffState: { kind: "configured" as const, ok: true },
    collectorMode: "receiver" as const,
  });
  setQuery(api.jobs.list, { jobs: [], truncated: false });
}

interface RenderedDashboard {
  html: string;
  container: HTMLElement;
  unmount: () => void;
}

function renderDashboard(isOperator: boolean): RenderedDashboard {
  reset();
  setQuery(api.access.isOperator, isOperator);
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
            isAuthenticated: true,
            fetchAccessToken: () => Promise.resolve(null),
          }),
        },
        createElement(Dashboard, { ensureSession: () => Promise.resolve(), close: () => {} }),
      ),
    );
  });

  return {
    html: container.innerHTML,
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("Dashboard's 'Start an import' form (src/Dashboard.tsx)", () => {
  it("disables the submit button and shows the sign-in notice for a non-operator", () => {
    const { html, container, unmount } = renderDashboard(false);
    // SAFETY: `querySelector` types every result as the loosest `Element`
    // subtype for the given selector; `button.control-start` is always
    // rendered as a real `<button>` in this component's JSX, never
    // replaced with another tag, so this narrows to the concrete type this
    // test's `.disabled` assertion needs.
    const submit = container.querySelector("button.control-start") as HTMLButtonElement | null;

    expect(submit).not.toBeNull();
    expect(submit!.disabled).toBe(true);
    expect(html).toContain("This action runs from the operator dashboard.");
    unmount();
  });

  it("leaves the submit button enabled with no sign-in notice for an operator", () => {
    const { html, container, unmount } = renderDashboard(true);
    // SAFETY: same as the non-operator test above.
    const submit = container.querySelector("button.control-start") as HTMLButtonElement | null;

    expect(submit).not.toBeNull();
    expect(submit!.disabled).toBe(false);
    expect(html).not.toContain("This action runs from the operator dashboard.");
    unmount();
  });
});
