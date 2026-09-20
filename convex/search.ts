import {
  query,
  mutation,
  internalMutation,
  internalQuery,
  internalAction,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { postFields, searchStatsFields, sortValidator } from "./schema";
import {
  parseQuery,
  assertAuthorizedScope,
  STALE_CURSOR_STATUS,
  StaleSearchCursorError,
} from "./lib/search";
import { decodeSearchResponse } from "./lib/results";
import { serviceToken } from "./lib/serviceAuth";
import { summaryScopeValidator } from "./lib/contracts";
import { user } from "./access";
import type { Doc } from "./_generated/dataModel";
export const accounts = query({
  args: {},
  handler: (ctx) => ctx.db.query("accounts").withIndex("by_handle").take(100),
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
  handler: async (ctx, { sessionId }) => {
    const owner = await user(ctx);
    const session = await ctx.db.get(sessionId);
    if (!session || session.owner !== owner) throw new ConvexError("Search session not found.");
    return session;
  },
});
export const get = internalQuery({
  args: { sessionId: v.id("sessions") },
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
  handler: async (ctx, { sessionId, ...rest }) => {
    const session = await ctx.db.get(sessionId);
    if (!session || session.status === "failed" || session.status === "complete") return;
    await ctx.db.patch(sessionId, {
      ...rest,
      status: rest.error ? "failed" : "complete",
    });
  },
});
export const expire = internalMutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (session?.status === "queued" || session?.status === "running")
      await ctx.db.patch(sessionId, {
        status: "failed",
        error: "The search service timed out. Try again.",
      });
  },
});
export const execute = internalAction({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }): Promise<void> => {
    const session: Doc<"sessions"> | null = await ctx.runQuery(internal.search.get, { sessionId });
    if (!session || session.status !== "queued") return;
    try {
      const parsed = parseQuery(session.raw);
      const response = await fetch(process.env.SEARCH_API_URL!, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(serviceToken("search") ? { Authorization: `Bearer ${serviceToken("search")}` } : {}),
        },
        body: JSON.stringify({
          version: 1,
          query: parsed.text,
          author: parsed.author,
          sort: session.sort,
          cursor: session.cursor,
          limit: 20,
          ...(session.includeStats ? { includeStats: true } : {}),
        }),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      // A cursor's page window going stale is the one failure this app can
      // tell apart from a generic outage without inspecting the cursor
      // itself (it stays opaque; the search service owns it) — see
      // STALE_CURSOR_STATUS in ./lib/search. Only meaningful when this
      // request actually carried a cursor.
      if (response.status === STALE_CURSOR_STATUS && session.cursor)
        throw new StaleSearchCursorError();
      if (!response.ok) throw new Error("Service unavailable");
      const result = decodeSearchResponse(await response.json());
      await ctx.runMutation(internal.search.complete, { sessionId, ...result });
    } catch (err) {
      await ctx.runMutation(internal.search.complete, {
        sessionId,
        rows: [],
        warnings: [],
        error:
          err instanceof StaleSearchCursorError
            ? "This search expired. Restart your search."
            : "The search service could not return a valid result page. Try again or check its connection.",
      });
    }
  },
});
export const saved = query({
  args: {},
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
  handler: async (ctx, args) => {
    const owner = await user(ctx);
    parseQuery(args.raw);
    if (!args.raw.trim()) throw new ConvexError("Enter a search first.");
    const saved = await ctx.db
      .query("saved")
      .withIndex("by_owner", (q) => q.eq("owner", owner))
      .take(31);
    if (saved.some((s) => s.query === args.raw.trim() && s.sort === args.sort)) return;
    if (saved.length >= 30) throw new ConvexError("You can save 30 searches. Remove one first.");
    await ctx.db.insert("saved", {
      owner,
      query: args.raw.trim(),
      sort: args.sort,
    });
  },
});
export const removeSaved = mutation({
  args: { id: v.id("saved") },
  handler: async (ctx, { id }) => {
    const owner = await user(ctx);
    const row = await ctx.db.get(id);
    if (row?.owner !== owner) throw new ConvexError("Search not found.");
    await ctx.db.delete(id);
  },
});
export const bookmarks = query({
  args: {},
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
  handler: async (ctx, { tweetId, sessionId }) => {
    const owner = await user(ctx);
    const existing = await ctx.db
      .query("bookmarks")
      .withIndex("by_post", (q) => q.eq("owner", owner).eq("post.tweetId", tweetId))
      .unique();
    if (existing) {
      await ctx.db.delete(existing._id);
      return;
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
  },
});
