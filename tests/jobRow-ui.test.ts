// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
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
import type { Doc, Id } from "../convex/_generated/dataModel";
import { JobRow } from "../src/JobRow";
import { OPERATOR_SIGN_IN_NOTICE } from "../src/integrationStatus";

/**
 * A rendered-DOM test for src/JobRow.tsx — the one job row shared by the
 * header modal (src/App.tsx, public build) and the operator dashboard
 * (src/Dashboard.tsx, operator build only). Follows the same fake-transport
 * pattern as tests/library-ui.test.ts: `convex/react`'s hooks run for real
 * (`useQuery` for `api.jobs.receipts`), only the transport underneath is
 * faked, keyed by function name. No fixtures are ever set here (every job
 * below stays collapsed), so `useQuery` reads its real "still loading"
 * `undefined` — good enough, since nothing in these assertions depends on
 * the receipts list itself.
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

function makeFakeBaseClient(): FakeBaseConvexClient {
  return {
    url: "https://job-row-test.convex.cloud",
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
    mutation: () => Promise.resolve(undefined),
    action: () => Promise.resolve(undefined),
    close: () => Promise.resolve(),
  };
}

// SAFETY: `options.baseClient` is a real, working constructor option (see
// `ConvexReactClient`'s `sync` getter in
// `node_modules/convex/src/react/client.ts`) marked `@internal` and so
// missing from the published `ConvexReactClientOptions` type, not from the
// runtime — the same gap tests/library-ui.test.ts bridges the same way.
const convexClient = new ConvexReactClient("https://job-row-test.convex.cloud", {
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

function job(overrides: Partial<Doc<"jobs">>): Doc<"jobs"> {
  const base = {
    _id: jobId("job-1"),
    _creationTime: 0,
    owner: userId("user-1"),
    kind: "bulk" as const,
    input: "theo",
    refresh: false,
    status: "queued" as const,
    count: 0,
    attempt: 0,
    warnings: [],
    updatedAt: 0,
    ...overrides,
  };

  // SAFETY: `base` covers every required field of `Doc<"jobs">`; `overrides`
  // only ever narrows optional or same-shaped fields, so this is a plain
  // upcast, not a lie about its shape.
  return base as Doc<"jobs">;
}

interface RenderedRow {
  html: string;
  container: HTMLElement;
  unmount: () => void;
}

function renderRow(
  props: Omit<Parameters<typeof JobRow>[0], "job" | "now" | "isOperator"> & {
    job: Doc<"jobs">;
    now?: number;
    isOperator?: boolean;
  },
): RenderedRow {
  // Attached to `document.body`, not a detached node: React's delegated
  // event listeners (the click test below dispatches a real MouseEvent) are
  // registered on the root container, but bubbling through a node with no
  // document owner never reaches them.
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
        createElement(JobRow, { now: 0, isOperator: true, ...props }),
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

describe("JobRow (src/JobRow.tsx) rendered output", () => {
  it("labels a bulk (account history) job by handle, not the raw kind", () => {
    const { html, unmount } = renderRow({ job: job({ kind: "bulk", input: "theo" }) });

    expect(html).toContain("@theo history");
    unmount();
  });

  it("labels a post job with the handle recovered from its status URL", () => {
    const post = job({ kind: "post", input: "https://x.com/theo/status/12345" });
    const { html, unmount } = renderRow({ job: post });

    expect(html).toContain("Conversation on @theo's post");
    unmount();
  });

  it("labels a live-search job with its query, not a raw kind string", () => {
    const live = job({ kind: "live", input: "@theo convex" });
    const { html, unmount } = renderRow({ job: live });

    expect(html).toContain("Live search: @theo convex");
    unmount();
  });

  it("offers Retry for a transient failure and hides it for a permanent one", () => {
    const transientFailure = job({
      status: "failed",
      error: "x.md rate limit reached.",
      retryable: true,
    });

    const transient = renderRow({ job: transientFailure, onRetry: () => Promise.resolve() });

    expect(transient.html).toContain(">Retry<");
    expect(transient.html).not.toContain("x.md can't fetch this");
    transient.unmount();

    const permanentFailure = job({
      kind: "post",
      input: "https://x.com/theo/status/1",
      status: "failed",
      error: "x.md could not finish this request (400, invalid_thread).",
      retryable: false,
    });

    const permanent = renderRow({ job: permanentFailure, onRetry: () => Promise.resolve() });

    expect(permanent.html).not.toContain(">Retry<");
    expect(permanent.html).toContain("x.md can't fetch this");
    permanent.unmount();
  });

  it("still offers Retry for an unclassified stopped job (no ProviderError.retryable recorded)", () => {
    // `retryable` is `undefined` for any job that predates this field, or
    // that stopped for a reason that never went through `ProviderError` —
    // isPermanentFailure() only ever treats an EXPLICIT `retryable: false`
    // as permanent, so this case still offers Retry rather than silently
    // losing the button for old rows.
    const unclassified = job({ status: "partial", count: 3 });
    const { html, unmount } = renderRow({ job: unclassified, onRetry: () => Promise.resolve() });

    expect(html).toContain(">Retry<");
    unmount();
  });

  it("calls onDismiss with the job when Clear from list is clicked, and never offers it for an active job", () => {
    const onDismiss = vi.fn((_job: Doc<"jobs">) => Promise.resolve());
    const finished = renderRow({ job: job({ status: "complete" }), onDismiss });

    const button = [...finished.container.querySelectorAll("button")].find(
      (b) => b.textContent === "Clear from list",
    );

    expect(button).toBeDefined();
    act(() => button!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onDismiss).toHaveBeenCalledTimes(1);

    const [dismissed] = onDismiss.mock.calls[0]!;

    expect(dismissed._id).toBe("job-1");
    finished.unmount();

    const active = renderRow({ job: job({ status: "running" }), onDismiss });

    expect(active.html).not.toContain("Clear from list");
    active.unmount();
  });

  it("folds earlier runs of the same input into a technical-details count, without a row each", () => {
    const finished = job({ status: "complete" });
    const { html, unmount } = renderRow({ job: finished, earlierCount: 3 });

    expect(html).toContain("3 earlier runs for this same input.");
    unmount();
  });

  it("disables Cancel/Retry/Dismiss with a visible sign-in notice for a non-operator", () => {
    // Cancel/Retry/Dismiss/Restore are all `requireOperator`-gated
    // server-side (convex/access.ts, convex/jobs.ts) — a signed-in guest
    // must see why the buttons don't work, not hit a bare ConvexError.
    const retryableFailure = job({ status: "failed", retryable: true });

    const { html, container, unmount } = renderRow({
      job: retryableFailure,
      isOperator: false,
      onRetry: () => Promise.resolve(),
    });

    expect(html).toContain(OPERATOR_SIGN_IN_NOTICE);

    const retryButton = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Retry",
    );

    expect(retryButton).toBeDefined();
    expect(retryButton!.disabled).toBe(true);
    unmount();
  });
});
