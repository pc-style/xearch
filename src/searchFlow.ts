import { Effect } from "effect";
import type { Id } from "../convex/_generated/dataModel";
import type { Sort } from "../convex/lib/search";

export type SearchSessionId = Id<"sessions">;

/** The public arguments accepted by the existing `api.search.start` mutation. */
export interface SearchRequest {
  readonly raw: string;
  readonly sort: Sort;
  readonly cursor?: string;
  readonly includeStats?: boolean;
}

export interface SearchFlowDependencies {
  readonly ensureSession: () => Promise<void>;
  readonly beforeStart?: () => void;
  readonly startSearch: (request: SearchRequest) => Promise<SearchSessionId>;
}

export const searchFlow = Effect.fn("searchFlow")(function* (
  dependencies: SearchFlowDependencies,
  request: SearchRequest,
): Effect.fn.Return<SearchSessionId, unknown> {
  yield* Effect.tryPromise({
    try: () => dependencies.ensureSession(),
    catch: (error: unknown) => error,
  });
  if (dependencies.beforeStart) yield* Effect.sync(dependencies.beforeStart);
  // Callers pass a wider request (attemptId, trigger for telemetry). Convex
  // rejects unknown fields, so send only the mutation's own arguments.
  const { raw, sort, cursor, includeStats } = request;
  return yield* Effect.tryPromise({
    try: () => dependencies.startSearch({ raw, sort, cursor, includeStats }),
    catch: (error: unknown) => error,
  });
});

export const runSearchFlow = searchFlow;

export function makeSearchFlow(
  dependencies: SearchFlowDependencies,
): (request: SearchRequest) => Effect.Effect<SearchSessionId, unknown> {
  return (request) => searchFlow(dependencies, request);
}
