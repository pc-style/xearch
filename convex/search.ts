import {
  query,
  mutation,
  internalMutation,
  internalQuery,
  internalAction,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import schema, { postFields, searchStatsFields, sortValidator } from "./schema";
import { parseQuery, assertAuthorizedScope, STALE_CURSOR_STATUS } from "./lib/search";
import { decodeSearchResponse } from "./lib/results";
import { serviceToken } from "./lib/serviceAuth";
import { summaryScopeValidator } from "./lib/contracts";
import { user } from "./access";
import type { Doc } from "./_generated/dataModel";

/** Wire request body for the external search service (docs/integration-contract.md). */
type SearchRequestBody = {
  version: 1;
  query: string;
  author?: string;
  sort: Doc<"sessions">["sort"];
  cursor?: string;
  limit: number;
  includeStats?: true;
};

// The search API's own page size (`limit: 20` below, in `execute`) and
// `lib/results.ts`'s decode-time `Schema.isMaxLength(20)` both already
// bound a normal response to this. `complete` enforces it again because it
// is an internalMutation, not the only caller of which is `execute` — a
// future caller that skips the decode step must not be able to write an
// unbounded `rows` array into `sessions` (see convex/_generated/ai/
// guidelines.md "Do not store unbounded lists...", and the sessions.rows
// schema comment).
const MAX_SEARCH_ROWS = 20;

const accountSummaryValidator = v.object({
  _id: v.id("accounts"),
  handle: v.string(),
  name: v.string(),
  avatar: v.optional(v.string()),
});

// Public and deliberately unauthenticated and unscoped: the home page's
// creator ring must render before any session exists (this app's guest
// sessions are created lazily), and a handle/display-name/avatar is public
// X data, not private to whoever imported the account — see
// /tmp/issues.md A2/C2. This is a scope decision, not the bug: the actual
// fix here is narrowing the returned fields to exactly what's public and
// needed, so a schema change elsewhere (e.g. adding an internal note field
// to `accounts`) can never leak through this query by accident.
export const accounts = query({
  args: {},
  returns: v.array(accountSummaryValidator),
  handler: async (ctx) => {
    const rows = await ctx.db.query("accounts").withIndex("by_handle").take(100);

    return rows.map(({ _id, handle, name, avatar }) => ({ _id, handle, name, avatar }));
  },
});

export const start = mutation({
  args: {
    raw: v.string(),
    sort: sortValidator,
    cursor: v.optional(v.string()),
    // Optional and forward-looking: today the only value this app can
    // authorize is "global" (see assertAuthorizedScope in ./lib/search), so
    // this is never persisted on the session — there is nothing narrower to
    // remember yet. A caller that asks for anything else is rejected below
    // rather than silently downgraded.
    scope: v.optional(summaryScopeValidator),
    includeStats: v.optional(v.boolean()),
  },
  returns: v.id("sessions"),
  handler: async (ctx, args) => {
    const owner = await user(ctx);
    parseQuery(args.raw);

    if (!args.raw.trim()) throw new ConvexError("Enter a search.");

    if (!process.env.SEARCH_API_URL)
      throw new ConvexError(
        "The search service is not connected yet. Configure SEARCH_API_URL to use your corpus.",
      );
    // An empty or whitespace-only cursor is not a page token; treat it as
    // "first page" rather than handing the service a blank opaque value.
    const cursor = args.cursor?.trim() ? args.cursor : undefined;

    if ((cursor?.length ?? 0) > 4000) throw new ConvexError("Invalid cursor.");
    assertAuthorizedScope(args.scope);

    const id = await ctx.db.insert("sessions", {
      owner,
      raw: args.raw,
      sort: args.sort,
      cursor,
      includeStats: args.includeStats === true,
      status: "queued",
      rows: [],
      warnings: [],
    });

    await ctx.scheduler.runAfter(0, internal.search.execute, { sessionId: id });
    await ctx.scheduler.runAfter(60_000, internal.search.expire, {
      sessionId: id,
    });

    return id;
  },
});

export const results = query({
  args: { sessionId: v.id("sessions") },
  returns: schema.doc("sessions"),
  handler: async (ctx, { sessionId }) => {
    const owner = await user(ctx);
    const session = await ctx.db.get(sessionId);

    if (!session || session.owner !== owner) throw new ConvexError("Search session not found.");

    return session;
  },
});

export const get = internalQuery({
  args: { sessionId: v.id("sessions") },
  returns: v.union(v.null(), schema.doc("sessions")),
  handler: (ctx, { sessionId }) => ctx.db.get(sessionId),
});

export const complete = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    rows: v.array(v.object(postFields)),
    warnings: v.array(v.string()),
    nextCursor: v.optional(v.string()),
    stats: v.optional(v.object(searchStatsFields)),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { sessionId, ...rest }) => {
    const session = await ctx.db.get(sessionId);

    if (!session || session.status === "failed" || session.status === "complete") return null;

    // Defense in depth: `execute` below already asks the search API for at
    // most 20 rows and `lib/results.ts`'s decode already enforces the same
    // cap, but this is an internalMutation and nothing stops a future
    // caller from reaching it directly with more. Reject rather than
    // silently slice — a truncated page presented as a full one is the
    // exact "partial as a total" anti-pattern this codebase avoids
    // elsewhere (see convex/summary.ts's Count comments).
    if (rest.rows.length > MAX_SEARCH_ROWS) {
      await ctx.db.patch(sessionId, {
        status: "failed",
        rows: [],
        warnings: rest.warnings,
        error: `The search service returned more than ${MAX_SEARCH_ROWS} results for one page.`,
      });

      return null;
    }

    await ctx.db.patch(sessionId, {
      ...rest,
      status: rest.error ? "failed" : "complete",
    });

    return null;
  },
});

export const expire = internalMutation({
  args: { sessionId: v.id("sessions") },
  returns: v.null(),
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);

    if (session?.status === "queued" || session?.status === "running")
      await ctx.db.patch(sessionId, {
        status: "failed",
        error: "The search service timed out. Try again.",
      });

    return null;
  },
});

// How long `execute` waits before its one retry of a transient upstream
// failure. Short and single: this delays a person's search by at most this
// long, not a backoff ladder — a search request is not an acquisition job
// that can wait minutes (contrast convex/jobs.ts `finish`'s retry schedule).
const TRANSIENT_RETRY_BACKOFF_MS = 300;

// What one attempt at the search service can come back as, classified so
// `execute` can decide whether to retry and what to tell an operator.
// - "stale_cursor": the one failure this app can name specifically without
//   inspecting the (opaque) cursor itself — never retried, since retrying
//   the same expired cursor cannot succeed.
// - "network": `fetch` itself rejected (DNS, connection refused, the
//   30s AbortSignal timing out). Retried once: a single dropped connection
//   or a cold-starting upstream is exactly what one short retry recovers.
// - "server_error" (5xx): the service is up but failed the request on its
//   own side. Retried once for the same reason as "network".
// - "client_error" (4xx other than the stale-cursor status): this app built
//   a request the service rejected outright. Retrying the identical
//   request cannot change that, so this fails immediately.
// - "invalid_body": the response came back 2xx but its body was not valid
//   JSON, or valid JSON that didn't match the documented response shape.
//   Retried once — the same "maybe transient, maybe a truncated response"
//   reasoning as "network"/"server_error".
type SearchFailure =
  | { kind: "stale_cursor" }
  | { kind: "network" }
  | { kind: "server_error"; status: number }
  | { kind: "client_error"; status: number }
  | { kind: "invalid_body"; detail: string };

type SearchAttempt =
  | { kind: "ok"; result: ReturnType<typeof decodeSearchResponse> }
  | { kind: "failed"; failure: SearchFailure };

const RETRYABLE_FAILURE_KINDS = new Set<SearchFailure["kind"]>([
  "network",
  "server_error",
  "invalid_body",
]);

/** One request/response round trip against the search service, classified. */
async function attemptSearch(
  url: string,
  headers: Record<string, string>,
  requestBody: SearchRequestBody,
  hasCursor: boolean,
): Promise<SearchAttempt> {
  let response: Response;

  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { kind: "failed", failure: { kind: "network" } };
  }

  // A cursor's page window going stale is the one failure this app can tell
  // apart from a generic outage without inspecting the cursor itself (it
  // stays opaque; the search service owns it) — see STALE_CURSOR_STATUS in
  // ./lib/search. Only meaningful when this request actually carried one.
  if (response.status === STALE_CURSOR_STATUS && hasCursor)
    return { kind: "failed", failure: { kind: "stale_cursor" } };

  if (!response.ok)
    return {
      kind: "failed",
      failure:
        response.status >= 500
          ? { kind: "server_error", status: response.status }
          : { kind: "client_error", status: response.status },
    };

  let body;

  try {
    body = await response.json();
  } catch {
    return { kind: "failed", failure: { kind: "invalid_body", detail: "was not valid JSON" } };
  }

  try {
    return { kind: "ok", result: decodeSearchResponse(body) };
  } catch {
    return {
      kind: "failed",
      failure: { kind: "invalid_body", detail: "did not match the expected response shape" },
    };
  }
}

/**
 * The upstream failure class/status an operator needs to tell "the search
 * service itself is erroring (502/503/network)" apart from "this app sent a
 * request the service rejected (4xx)" — see docs/publication-contract.md's
 * general "never invent a number/reason" stance: this states exactly what
 * was observed, never a guess at the underlying cause.
 */
function describeFailure(failure: Exclude<SearchFailure, { kind: "stale_cursor" }>): string {
  switch (failure.kind) {
    case "network":
      return "a network error reaching the search service";
    case "server_error":
      return `the search service returned HTTP ${failure.status}`;
    case "client_error":
      return `the search service rejected the request (HTTP ${failure.status})`;
    case "invalid_body":
      return `the search service's response ${failure.detail}`;
  }
}

function failureMessage(failure: SearchFailure, retried: boolean): string {
  if (failure.kind === "stale_cursor") return "This search expired. Restart your search.";
  const cause = describeFailure(failure);

  // A 4xx (client_error) is never retried (see RETRYABLE_FAILURE_KINDS
  // above) because the identical request cannot succeed on a retry — so
  // "Try again" is actively wrong advice here, not just unnecessary
  // (CodeRabbit #4089340895).
  if (failure.kind === "client_error")
    return `The search service could not return a valid result page (${cause}).`;

  return retried
    ? `The search service could not return a valid result page after retrying once (${cause}). Try again.`
    : `The search service could not return a valid result page (${cause}). Try again.`;
}

export const execute = internalAction({
  args: { sessionId: v.id("sessions") },
  returns: v.null(),
  handler: async (ctx, { sessionId }): Promise<null> => {
    const session: Doc<"sessions"> | null = await ctx.runQuery(internal.search.get, { sessionId });

    if (!session || session.status !== "queued") return null;

    try {
      const parsed = parseQuery(session.raw);

      const baseHeaders = { "Content-Type": "application/json" } satisfies Record<string, string>;
      const token = serviceToken("search");
      const headers = token ? { ...baseHeaders, Authorization: `Bearer ${token}` } : baseHeaders;

      const requestBody: SearchRequestBody = {
        version: 1,
        query: parsed.text,
        author: parsed.author,
        sort: session.sort,
        cursor: session.cursor,
        limit: 20,
      };

      if (session.includeStats) requestBody.includeStats = true;

      const url = process.env.SEARCH_API_URL!;
      const hasCursor = !!session.cursor;
      let attempt = await attemptSearch(url, headers, requestBody, hasCursor);
      let retried = false;

      if (attempt.kind === "failed" && RETRYABLE_FAILURE_KINDS.has(attempt.failure.kind)) {
        await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_BACKOFF_MS));
        retried = true;
        attempt = await attemptSearch(url, headers, requestBody, hasCursor);
      }

      if (attempt.kind === "ok") {
        await ctx.runMutation(internal.search.complete, { sessionId, ...attempt.result });
      } else {
        await ctx.runMutation(internal.search.complete, {
          sessionId,
          rows: [],
          warnings: [],
          error: failureMessage(attempt.failure, retried),
        });
      }
    } catch {
      // Anything this action did not anticipate (a `parseQuery` throw on a
      // session `start` already validated, `JSON.stringify` on the request
      // body, a `runMutation` failure) — never let it crash the action or
      // leave the session stuck at "queued" past its `expire` deadline.
      await ctx.runMutation(internal.search.complete, {
        sessionId,
        rows: [],
        warnings: [],
        error:
          "The search service could not return a valid result page. Try again or check its connection.",
      });
    }

    return null;
  },
});

export const saved = query({
  args: {},
  returns: v.array(schema.doc("saved")),
  handler: async (ctx) => {
    const owner = await user(ctx);

    return ctx.db
      .query("saved")
      .withIndex("by_owner", (q) => q.eq("owner", owner))
      .order("desc")
      .take(30);
  },
});

export const save = mutation({
  args: { raw: v.string(), sort: sortValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const owner = await user(ctx);
    parseQuery(args.raw);

    if (!args.raw.trim()) throw new ConvexError("Enter a search first.");

    const saved = await ctx.db
      .query("saved")
      .withIndex("by_owner", (q) => q.eq("owner", owner))
      .take(31);

    if (saved.some((s) => s.query === args.raw.trim() && s.sort === args.sort)) return null;

    if (saved.length >= 30) throw new ConvexError("You can save 30 searches. Remove one first.");
    await ctx.db.insert("saved", {
      owner,
      query: args.raw.trim(),
      sort: args.sort,
    });

    return null;
  },
});

export const removeSaved = mutation({
  args: { id: v.id("saved") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const owner = await user(ctx);
    const row = await ctx.db.get(id);

    if (row?.owner !== owner) throw new ConvexError("Search not found.");
    await ctx.db.delete(id);

    return null;
  },
});

export const bookmarks = query({
  args: {},
  returns: v.array(v.object(postFields)),
  handler: async (ctx) => {
    const owner = await user(ctx);

    const marks = await ctx.db
      .query("bookmarks")
      .withIndex("by_owner", (q) => q.eq("owner", owner))
      .order("desc")
      .take(100);

    return marks.map((m) => m.post);
  },
});

export const bookmark = mutation({
  args: { tweetId: v.string(), sessionId: v.optional(v.id("sessions")) },
  returns: v.null(),
  handler: async (ctx, { tweetId, sessionId }) => {
    const owner = await user(ctx);

    const existing = await ctx.db
      .query("bookmarks")
      .withIndex("by_post", (q) => q.eq("owner", owner).eq("post.tweetId", tweetId))
      .unique();

    if (existing) {
      await ctx.db.delete(existing._id);

      return null;
    }

    const session = sessionId ? await ctx.db.get(sessionId) : null;
    const post = session?.owner === owner ? session.rows.find((p) => p.tweetId === tweetId) : null;

    if (!post) throw new ConvexError("Post not found in your search session.");

    if (
      (
        await ctx.db
          .query("bookmarks")
          .withIndex("by_owner", (q) => q.eq("owner", owner))
          .take(100)
      ).length >= 100
    )
      throw new ConvexError("Remove a bookmark before saving another.");
    await ctx.db.insert("bookmarks", { owner, post });

    return null;
  },
});
