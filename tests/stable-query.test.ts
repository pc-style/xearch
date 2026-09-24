// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import type { ConvexReactClientOptions } from "convex/react";
import type { Value } from "convex/values";
import { api } from "../convex/_generated/api";
import { useStableQuery } from "../src/library/stableQuery";

/**
 * The bug this guards: `useLiveNow` ticks the `now` argument of
 * convex/integrations.ts's queries every 5s, and stock `useQuery` reports
 * `undefined` for every argument change until the new result arrives, so
 * the whole page flipped back to its loading state every few seconds.
 * `useStableQuery` must hold the last result across that gap.
 */

// Results keyed by the serialized args, so an argument change with no
// result yet reads as `undefined` exactly like a real in-flight refetch.
const responses = new Map<string, Value>();

// Same shape as tests/library-ui.test.ts's fake base client (see the SAFETY
// note there): only what `ConvexReactClient` calls for a plain `useQuery`.
const baseClient = {
  url: "https://stable-query-test.convex.cloud",
  addOnTransitionHandler: () => () => {},
  setAuth: () => {},
  setAdminAuth: () => {},
  clearAuth: () => {},
  subscribe: (name: string, args?: Record<string, Value>) => ({
    queryToken: `${name}:${JSON.stringify(args ?? {})}`,
    unsubscribe: () => {},
  }),
  localQueryResult: (_udfPath: string, args?: Record<string, Value>) =>
    responses.get(JSON.stringify(args ?? {})),
  localQueryResultByToken: () => undefined,
  hasLocalQueryResultByToken: () => false,
  localQueryLogs: () => undefined,
  queryJournal: () => undefined,
  connectionState: () => ({
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

// SAFETY: `options.baseClient` is a real, working constructor option that is
// merely `@internal` and so missing from the published type — the same
// bridge tests/library-ui.test.ts documents.
const client = new ConvexReactClient("https://stable-query-test.convex.cloud", {
  baseClient,
} as ConvexReactClientOptions);

function Probe({ now }: { now: number }) {
  const result = useStableQuery(api.integrations.configured, { now });

  // Rendered as text so the assertions read the DOM, never a module binding
  // written during render.
  return createElement("output", null, result === undefined ? "undefined" : JSON.stringify(result));
}

let root: Root | undefined;
let host: HTMLElement | undefined;

function seen(): unknown {
  const text = host?.textContent ?? "undefined";

  return text === "undefined" ? undefined : JSON.parse(text);
}

function render(now: number) {
  host = document.createElement("div");
  root = createRoot(host);
  act(() => root?.render(createElement(ConvexProvider, { client }, createElement(Probe, { now }))));
}

function update(now: number) {
  act(() => root?.render(createElement(ConvexProvider, { client }, createElement(Probe, { now }))));
}

afterEach(() => {
  act(() => root?.unmount());
  responses.clear();
});

describe("useStableQuery", () => {
  it("keeps the last result while a changed argument has none yet", () => {
    const first: Value = { search: true };
    responses.set(JSON.stringify({ now: 1 }), first);
    render(1);
    expect(seen()).toEqual(first);

    // The tick: no result for the new args yet. Stock useQuery says undefined.
    update(2);
    expect(seen()).toEqual(first);

    // The next tick has a result waiting: the hook moves on to it.
    const second: Value = { search: false };
    responses.set(JSON.stringify({ now: 3 }), second);
    update(3);
    expect(seen()).toEqual(second);
  });

  it("still reports undefined before anything has ever loaded", () => {
    render(1);
    expect(seen()).toBeUndefined();
  });
});
