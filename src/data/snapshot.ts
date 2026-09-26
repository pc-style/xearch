import { createEffect, createSignal, untrack, type Accessor } from "solid-js";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { useConvex } from "./convex";

export type Snapshot<T> = {
  /** The last successful result; `undefined` before the first one lands. */
  readonly data: Accessor<T | undefined>;
  /** The last failure, cleared by the next success. */
  readonly error: Accessor<unknown>;
  /** Wall-clock ms of the last successful read. */
  readonly fetchedAt: Accessor<number | undefined>;
  readonly loading: Accessor<boolean>;
};

/**
 * A query read once, and again only when `version` changes — never because
 * the server's data moved. `args` is evaluated at the moment of each read
 * (so a `now` inside it is the instant of that read), and only its
 * `"skip"`-ness is tracked: a skip clears the result, unskipping reads once.
 *
 * The counterpart of `useQuery` for surfaces that refresh by hand: the
 * public page's bootstrap (src/App.tsx) and the Connections panel, both
 * driven by src/data/publicRefresh.ts.
 */
export function useSnapshot<Q extends FunctionReference<"query">>(
  ref: Q,
  args: () => FunctionArgs<Q> | "skip",
  version: Accessor<number>,
): Snapshot<FunctionReturnType<Q>> {
  const convex = useConvex();
  const [data, setData] = createSignal<FunctionReturnType<Q> | undefined>(undefined);
  const [error, setError] = createSignal<unknown>(undefined);
  const [fetchedAt, setFetchedAt] = createSignal<number | undefined>(undefined);
  const [loading, setLoading] = createSignal(false);
  let generation = 0;

  const read = (value: FunctionArgs<Q>) => {
    const mine = ++generation;
    setLoading(true);
    void convex.query(ref, value).then(
      (result) => {
        if (mine !== generation) return;
        setData(() => result);
        setError(undefined);
        setFetchedAt(Date.now());
        setLoading(false);
      },
      (cause: unknown) => {
        if (mine !== generation) return;
        setError(() => cause);
        setLoading(false);
      },
    );
  };

  createEffect(
    () => ({ skipped: args() === "skip", version: version() }),
    ({ skipped }) => {
      if (skipped) {
        generation++;
        setData(undefined);
        setError(undefined);
        setFetchedAt(undefined);
        setLoading(false);

        return;
      }

      const value = untrack(args);

      if (value === "skip") return;
      read(value);
    },
  );

  return {
    data,
    error,
    fetchedAt,
    loading,
  };
}
