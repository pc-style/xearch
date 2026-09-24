import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import type { Accessor } from "solid-js";
import { useQuery } from "../data/convex";

/**
 * `useQuery` that keeps showing the last result while a change of arguments
 * is in flight. A plain query reads `undefined` from the moment its
 * arguments change until the new subscription delivers, and a query whose
 * `now` argument ticks (convex/integrations.ts `configured`/`operator`, fed
 * by `useLiveNow` every 5s) therefore flipped every consumer back into its
 * loading state on every tick — the whole page visibly "refreshed" every
 * few seconds. This is Convex's own documented pattern for that
 * (stack.convex.dev, "Help, my app is overreacting!").
 *
 * The first load and a `"skip"` report `undefined` — a consumer can tell
 * "never loaded" from "reloading", it just never regresses from the latter
 * to the former while the query stays live.
 */
export function useStableQuery<Q extends FunctionReference<"query">>(
  ref: Q,
  args: () => FunctionArgs<Q> | "skip",
): Accessor<FunctionReturnType<Q> | undefined> {
  return useQuery(ref, args, { stable: true });
}
