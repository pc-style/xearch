// Shared harness for the rendered-DOM tests: mounts a Solid component into
// jsdom (callers declare `// @vitest-environment jsdom`), optionally under a
// fake Convex app whose queries answer from fixtures keyed by function name.
import { createComponent, flush, type Component } from "solid-js";
import { render } from "@solidjs/web";
import { getFunctionName, type FunctionReference } from "convex/server";
import type { ConnectionState, QueryToken } from "convex/browser";
import type { Value } from "convex/values";
import { ConvexContext, type ConvexApp, type SyncClient } from "../src/data/convex";

export const CONNECTED: ConnectionState = {
  hasInflightRequests: false,
  isWebSocketConnected: true,
  timeOfOldestInflightRequest: null,
  hasEverConnected: true,
  connectionCount: 1,
  connectionRetries: 0,
  inflightMutations: 0,
  inflightActions: 0,
};

export interface FakeConvexOptions {
  /** Query results by function reference; anything absent reads as loading. */
  readonly results?: ReadonlyArray<readonly [FunctionReference<"query">, Value]>;
  /** Or answer by function name (and arguments) at read time, for fixtures
   * filled later. */
  readonly query?: (name: string, args: Record<string, Value>) => Value | undefined;
  readonly isAuthenticated?: boolean;
  readonly connection?: ConnectionState;
  readonly mutation?: (name: string, args: Record<string, Value>) => Promise<Value>;
  readonly action?: (name: string, args: Record<string, Value>) => Promise<Value>;
}

export function fakeConvex(options: FakeConvexOptions = {}): ConvexApp & {
  readonly subscribed: string[];
} {
  const results = new Map(options.results?.map(([ref, value]) => [getFunctionName(ref), value]));
  const subscribed: string[] = [];
  const connection = options.connection ?? CONNECTED;

  // Only the `SyncClient` members src/data/convex.ts calls, answered from the
  // fixtures above; no network, and auth calls are no-ops.
  const sync: SyncClient = {
    subscribe: (name) => {
      subscribed.push(name);

      // SAFETY: `QueryToken` is a branded string; this fake only needs a
      // stable per-name key, not collision-proof tokens.
      return { queryToken: name as QueryToken, unsubscribe: () => {} };
    },
    localQueryResult: (name, args) =>
      options.query ? options.query(name, args ?? {}) : results.get(name),
    addOnTransitionHandler: () => () => true,
    mutation: (name, args) => (options.mutation ?? (() => Promise.resolve(null)))(name, args ?? {}),
    action: (name, args) => (options.action ?? (() => Promise.resolve(null)))(name, args ?? {}),
    setAuth: () => {},
    clearAuth: () => {},
    connectionState: () => connection,
    subscribeToConnectionState: () => () => {},
  };

  return {
    subscribed,
    sync,
    listen: () => () => {},
    connection: () => connection,
    isLoading: () => false,
    isAuthenticated: () => options.isAuthenticated ?? true,
    actions: {
      signIn: () => Promise.resolve({ signingIn: true }),
      signOut: () => Promise.resolve(),
    },
  };
}

export interface Mounted {
  readonly container: HTMLElement;
  /** The rendered markup, after flushing pending updates. */
  html(): string;
  unmount(): void;
}

/** Mount `Comp` into a container attached to the document (events bubble). */
export function mount<P extends object>(Comp: Component<P>, props: P, convex?: ConvexApp): Mounted {
  const container = document.createElement("div");
  document.body.appendChild(container);

  const dispose = render(() => {
    const view = () => createComponent(Comp, props);

    return convex
      ? createComponent(ConvexContext, {
          value: convex,
          get children() {
            return view();
          },
        })
      : view();
  }, container);

  flush();

  return {
    container,
    html() {
      flush();

      return container.innerHTML;
    },
    unmount() {
      dispose();
      container.remove();
    },
  };
}

/** Solid's placeholder comments (where a `<Show>` or list can later insert). */
export const stripMarkers = (html: string) => html.replace(/<!--[^]*?-->/g, "");

/** Mount, read the markup, unmount: the old `renderToStaticMarkup` shape
 * (marker comments removed, as React's static markup had none). */
export function renderHtml<P extends object>(
  Comp: Component<P>,
  props: P,
  convex?: ConvexApp,
): string {
  const mounted = mount(Comp, props, convex);
  const html = stripMarkers(mounted.html());
  mounted.unmount();

  return html;
}

/** Let promise continuations and effects run, then apply Solid's queue. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await Promise.resolve();
    flush();
  }
}
