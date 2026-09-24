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
import type { Doc, Id } from "../convex/_generated/dataModel";
import { Job } from "../src/Dashboard";

/**
 * CodeRabbit (PR #52, src/Dashboard.tsx:71): Cancel/Retry/Dismiss all run
 * through JobRow's own `useTask`, which surfaces a rejected mutation as a
 * `role="alert"` line. "Bring back" (restore) is a dashboard-only extra
 * rendered outside JobRow (src/JobRow.tsx never learns about it — see its
 * own doc comment), and it used to call the mutation directly with no error
 * handling at all: a failed restore (expired session, dropped connection)
 * threw an unhandled rejection and the operator never saw why the row
 * didn't come back. This asserts the fixed behavior — `restoreTask` reports
 * the failure the same way JobRow's own actions do.
 *
 * Same fake-transport harness as tests/jobRow-ui.test.ts and
 * tests/library-ui.test.ts: `convex/react`'s hooks run for real, only the
 * transport underneath is faked, keyed by function name.
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

const restoreName = getFunctionName(api.jobs.restore);

function makeFakeBaseClient(): FakeBaseConvexClient {
  return {
    url: "https://dashboard-job-test.convex.cloud",
    addOnTransitionHandler: () => () => {},
    setAuth: (_fetchToken, onChange) => onChange(true),
    setAdminAuth: () => {},
    clearAuth: () => {},
    // SAFETY: `QueryToken` is `string & { __queryToken: true }`. This fake
    // never needs collision-proof tokens (there's no real dedupe to do),
    // only a stable per-query-name key for the caller's own bookkeeping.
    subscribe: (name) => ({ queryToken: name as QueryToken, unsubscribe: () => {} }),
    localQueryResult: () => undefined,
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
    mutation: (name) =>
      name === restoreName
        ? Promise.reject(new Error("Reconnecting to your search library…"))
        : Promise.resolve(undefined),
    action: () => Promise.resolve(undefined),
    close: () => Promise.resolve(),
  };
}

// SAFETY: see tests/library-ui.test.ts's identical cast for why
// `baseClient` (an `@internal` constructor option) needs one.
const convexClient = new ConvexReactClient("https://dashboard-job-test.convex.cloud", {
  baseClient: makeFakeBaseClient(),
} as ConvexReactClientOptions);

function jobId(id: string) {
  // SAFETY: `Id<"jobs">` is `string & { __tableName: "jobs" }`, a subtype of
  // `string`; this fixture helper attaches that brand to a test-authored id.
  return id as Id<"jobs">;
}

function userId(id: string) {
  // SAFETY: same as `jobId` above, for `Id<"users">`.
  return id as Id<"users">;
}

function dismissedJob(): Doc<"jobs"> {
  const base = {
    _id: jobId("job-1"),
    _creationTime: 0,
    owner: userId("user-1"),
    kind: "live" as const,
    input: "@theo convex",
    refresh: false,
    status: "complete" as const,
    count: 0,
    attempt: 0,
    warnings: [],
    updatedAt: 0,
    dismissedAt: 0,
  };

  // SAFETY: `base` covers every required field of `Doc<"jobs">`; this is a
  // plain upcast, not a lie about its shape.
  return base as Doc<"jobs">;
}

describe("Dashboard's Job row (src/Dashboard.tsx)", () => {
  it("shows a failure message when Bring back fails, instead of an unhandled rejection", () => {
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
          createElement(Job, { job: dismissedJob(), isOperator: true }),
        ),
      );
    });

    const button = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Bring back",
    );

    expect(button).toBeDefined();

    return act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      // Let the rejected mutation promise settle before asserting.
      await Promise.resolve();
      await Promise.resolve();
    }).then(() => {
      expect(container.innerHTML).toContain("Reconnecting to your search library…");
      act(() => root.unmount());
      container.remove();
    });
  });
});
