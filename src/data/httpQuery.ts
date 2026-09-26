import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { ConvexError, type Value } from "convex/values";
import type { AuthSource, QueryFetcher } from "./convex";

/**
 * The production `QueryFetcher` (src/data/convex.ts): one HTTPS request per
 * read through Convex's own `ConvexHttpClient`, carrying the same JWT the
 * WebSocket client holds. Nothing stays open afterwards, so a write on the
 * server can never make the read run again — the property the dashboard's
 * explicit-refresh contract rests on (src/ops/refresh.ts).
 *
 * The JWT is short-lived. A read that fails for want of a valid session is
 * retried once with a freshly refreshed token; any other failure (the query
 * itself throwing, the network) is reported as is, so a query that is
 * expensive to run is never run twice for one click.
 */
export function createHttpQueryFetcher(address: string, source: AuthSource): QueryFetcher {
  const http = new ConvexHttpClient(address);

  const read = async (name: string, args: Record<string, Value>, forceRefreshToken: boolean) => {
    const token = await source.fetchAccessToken({ forceRefreshToken });

    if (token) http.setAuth(token);
    else http.clearAuth();

    return http.query(makeFunctionReference<"query", Record<string, Value>, Value>(name), args);
  };

  return async (name, args) => {
    try {
      return await read(name, args, false);
    } catch (error) {
      if (!needsFreshSession(error)) throw error;

      return read(name, args, true);
    }
  };
}

/**
 * Whether a failed read is the session's fault rather than the query's.
 * Convex refuses a bad or expired bearer token before the function runs
 * (a plain `Error` naming authentication); the app's own gates throw a
 * `ConvexError` asking for a session (convex/access.ts `user`).
 */
export const needsFreshSession = (cause: unknown): boolean =>
  /unauthenticated|not authenticated|authentication|start a session|sign in/i.test(
    cause instanceof ConvexError ? String(cause.data) : cause instanceof Error ? cause.message : "",
  );
