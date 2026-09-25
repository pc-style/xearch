import { createSignal, type Accessor } from "solid-js";

/**
 * The home page's public reads, started by an inline script in index.html
 * while this bundle is still downloading. The live websocket subscription
 * only opens once the bundle has run, then has to connect and authenticate;
 * reading these first means the wall renders as soon as the app does.
 *
 * Only for public, argument-free queries whose JSON is their Convex value
 * (no int64 or bytes): the early read goes over Convex's plain HTTP API.
 */
declare global {
  interface Window {
    __prefetch?: Record<string, Promise<unknown> | undefined>;
  }
}

/** What the early read of `path` returned, once it has, until a caller's
 * live query takes over. `undefined` if it wasn't started or failed. */
export function prefetched<T>(path: string): Accessor<T | undefined> {
  const [value, setValue] = createSignal<T>();

  // SAFETY: index.html fetched `path` itself; its value is the same query's
  // result the caller's live subscription reads, typed by that caller.
  void window.__prefetch?.[path]?.then((result) => setValue(() => result as T | undefined));

  return value;
}
