import { createSignal, onSettled, type Accessor } from "solid-js";

/**
 * Read a subscribe/getSnapshot store (the `useSyncExternalStore` contract the
 * location store, the dashboard clock and search telemetry already expose)
 * as a signal. Subscribes once the owner settles and unsubscribes with it.
 */
export function fromStore<T>(
  subscribe: (listener: () => void) => () => void,
  getSnapshot: () => T,
): Accessor<T> {
  const [value, setValue] = createSignal<T>(() => getSnapshot(), { equals: false });

  onSettled(() => {
    const sync = () => setValue(() => getSnapshot());
    const stop = subscribe(sync);
    // Anything that changed between the first read and subscribing.
    sync();

    return stop;
  });

  return value;
}
