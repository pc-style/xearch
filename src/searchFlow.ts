import type { Id } from "../convex/_generated/dataModel";
import type { Sort } from "../convex/lib/search";

export type SearchSessionId = Id<"sessions">;

/** The public arguments accepted by the existing `api.search.start` mutation. */
export interface SearchRequest {
  readonly raw: string;
  readonly sort: Sort;
  readonly cursor?: string;
  readonly includeStats?: boolean;
  readonly clientKey?: string;
}

export interface SearchFlowDependencies {
  readonly ensureSession: () => Promise<void>;
  readonly beforeStart?: () => void;
  readonly startSearch: (request: SearchRequest) => Promise<SearchSessionId>;
}

/**
 * Ensure a session, then start the search. A plain async function rather
 * than an Effect: this is the only Effect the browser ran, and it pulled
 * ~35 kB of the Effect runtime into the page for two awaits. Failures reach
 * the caller exactly as they were thrown (describeError handles non-Errors).
 */
export async function searchFlow(
  dependencies: SearchFlowDependencies,
  request: SearchRequest,
): Promise<SearchSessionId> {
  await dependencies.ensureSession();
  dependencies.beforeStart?.();
  // Callers pass a wider request (attemptId, trigger for telemetry). Convex
  // rejects unknown fields, so send only the mutation's own arguments.
  const { raw, sort, cursor, includeStats, clientKey } = request;

  return dependencies.startSearch({ raw, sort, cursor, includeStats, clientKey });
}

/**
 * Combine one page of search rows with whatever is already on screen.
 *
 * "replace" (a fresh search) discards `base` outright — the pagination
 * cursor from a previous query is meaningless once the query itself
 * changes. "append" (Load more) keeps `base` and adds only the rows this
 * page hasn't already shown, so a post that straddles a page boundary (or a
 * cursor replayed after a retry) never appears twice. Order is preserved:
 * kept rows first, then new ones in the order the page returned them.
 */
export function mergeSearchPages<T extends { tweetId: string }>(
  base: readonly T[],
  incoming: readonly T[],
  mode: "replace" | "append",
): T[] {
  const start = mode === "append" ? base : [];
  const seen = new Set(start.map((post) => post.tweetId));
  const merged = start.slice();

  for (const post of incoming) {
    if (seen.has(post.tweetId)) continue;
    seen.add(post.tweetId);
    merged.push(post);
  }

  return merged;
}
