import { useQuery } from "convex/react";
import { useState } from "react";

/**
 * `useQuery` that keeps showing the last result while a change of arguments
 * is in flight. Stock `useQuery` returns `undefined` from the moment its
 * arguments change until the new subscription delivers, and a query whose
 * `now` argument ticks (convex/integrations.ts `configured`/`operator`, fed
 * by `useLiveNow` every 5s) therefore flipped every consumer back into its
 * loading state on every tick — the whole page visibly "refreshed" every
 * few seconds. This is Convex's own documented pattern for that
 * (stack.convex.dev, "Help, my app is overreacting!"); the only difference
 * is state instead of a ref so nothing is read or written during render
 * that React cannot see.
 *
 * The first load and a `"skip"` report `undefined` — a consumer can tell
 * "never loaded" from "reloading", it just never regresses from the latter
 * to the former while the query stays live.
 */
// SAFETY: this wraps `useQuery` with its exact parameters and returns either
// its result or an earlier result of the very same query reference, so the
// overloaded `typeof useQuery` signature is the precise type; the cast only
// bridges TypeScript's inability to infer overloads for a wrapping arrow.
export const useStableQuery = ((query, args) => {
  const result = useQuery(query, args);
  const [stored, setStored] = useState(result);

  // A skipped query has no result to hold on to: keeping the last one would
  // let a dashboard show configuration from a session that has ended. Clear
  // it, so a later session starts from "never loaded" again.
  if (args === "skip") {
    if (stored !== undefined) setStored(undefined);

    return undefined;
  }

  if (result !== undefined && result !== stored) setStored(result);

  return result === undefined ? stored : result;
}) as typeof useQuery;
