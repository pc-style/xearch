import { internalAction, internalMutation, internalQuery, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { postFields } from "./schema";
import { attemptSearch, type SearchRequestBody } from "./search";
import { serviceToken } from "./lib/serviceAuth";
import type { ResultPost } from "./lib/results";

/**
 * The home page's "popular posts" wall.
 *
 * Posts live in the external search service, which is only reached through
 * a per-visitor search session — there is no "top posts" read a signed-out
 * home page could make. So an hourly cron asks the service for each imported
 * account's most-liked posts (an author-only query, which the service
 * compiles to a plain author filter) and keeps a small ranked copy here.
 * The public `posts` query then reads that copy: the same public X data the
 * account ring already shows, never anything private to an importer.
 */

/** Posts asked of the search service per account. */
const PER_ACCOUNT = 3;

/** How many posts the wall keeps in total. */
const WALL_SIZE = 36;

/** Concurrent search-service requests while refreshing. */
const CONCURRENCY = 6;

const wallPost = v.object({ ...postFields, _id: v.id("wallPosts"), rank: v.number() });

// Public and unauthenticated for the same reason `search.accounts` is: the
// wall must render before any session exists, and a post's text, handle and
// public metrics are public X data.
export const posts = query({
  args: {},
  returns: v.array(wallPost),
  handler: async (ctx) => {
    const rows = await ctx.db.query("wallPosts").withIndex("by_rank").take(WALL_SIZE);

    return rows.map(({ _creationTime, ...row }) => row);
  },
});

// One page of imported handles; `refresh` walks every page, so no account
// is left out of the wall however large the library grows.
export const handles = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(v.string()),
  handler: async (ctx, { paginationOpts }) => {
    const page = await ctx.db.query("accounts").withIndex("by_handle").paginate(paginationOpts);

    return { ...page, page: page.page.map((row) => row.handle) };
  },
});

/** The wall as it stands, for keeping an account's posts through a failed refresh. */
export const current = internalQuery({
  args: {},
  returns: v.array(v.object(postFields)),
  handler: async (ctx) => {
    const rows = await ctx.db.query("wallPosts").withIndex("by_rank").take(WALL_SIZE);

    return rows.map(({ _id, _creationTime, rank: _rank, ...post }) => post);
  },
});

export const replace = internalMutation({
  args: { rows: v.array(v.object(postFields)) },
  returns: v.null(),
  handler: async (ctx, { rows }) => {
    // The table never holds more than WALL_SIZE rows, so one bounded read
    // covers everything this replaces.
    for (const old of await ctx.db.query("wallPosts").take(WALL_SIZE * 2))
      await ctx.db.delete(old._id);

    for (const [rank, row] of rows.slice(0, WALL_SIZE).entries())
      await ctx.db.insert("wallPosts", { ...row, rank });

    return null;
  },
});

/**
 * Interleave per-account results so one prolific account can't fill the
 * wall: every account's best post first, then every account's second, and
 * so on, each round ordered by likes.
 */
export function pickWall(perAccount: ResultPost[][], size = WALL_SIZE): ResultPost[] {
  const byLikes = (a: ResultPost, b: ResultPost) => (b.likes ?? 0) - (a.likes ?? 0);
  const lists = perAccount.map((rows) => [...rows].sort(byLikes));
  const seen = new Set<string>();
  const picked: ResultPost[] = [];

  for (let round = 0; picked.length < size; round++) {
    const layer = lists.flatMap((rows) => (rows[round] ? [rows[round]] : []));

    if (!layer.length) break;

    for (const post of [...layer].sort(byLikes)) {
      if (picked.length >= size || seen.has(post.tweetId) || !post.text.trim()) continue;
      seen.add(post.tweetId);
      picked.push(post);
    }
  }

  return picked;
}

export const refresh = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const url = process.env.SEARCH_API_URL;

    if (!url) return null;
    const handles: string[] = [];

    for (let cursor: string | null = null, done = false; !done;) {
      const page: { page: string[]; isDone: boolean; continueCursor: string } = await ctx.runQuery(
        internal.wall.handles,
        {
          paginationOpts: { numItems: 200, cursor },
        },
      );

      handles.push(...page.page);
      cursor = page.continueCursor;
      done = page.isDone;
    }

    // A failed request for one account keeps that account's posts from the
    // current wall, so a partial outage never quietly drops them.
    const previous: ResultPost[] = await ctx.runQuery(internal.wall.current, {});
    const token = serviceToken("search");

    const headers: Record<string, string> = token
      ? { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
      : { "Content-Type": "application/json" };

    const perAccount: ResultPost[][] = [];
    let failed = 0;

    for (let i = 0; i < handles.length; i += CONCURRENCY) {
      const batch = await Promise.all(
        handles.slice(i, i + CONCURRENCY).map(async (author) => {
          const body: SearchRequestBody = {
            version: 1,
            query: "",
            author,
            sort: "likes",
            limit: PER_ACCOUNT,
          };

          const attempt = await attemptSearch(url, headers, body, false);

          if (attempt.kind === "ok") return attempt.result.rows;
          failed += 1;

          return previous.filter((post) => post.author.toLowerCase() === author.toLowerCase());
        }),
      );

      perAccount.push(...batch);
    }

    // Every request failed: nothing new was learned, so leave the wall as is.
    if (handles.length && failed === handles.length) return null;

    // Otherwise the result is authoritative, even when empty: no accounts
    // left, or every successful search came back with no posts (a failed
    // account already kept its previous posts above).
    await ctx.runMutation(internal.wall.replace, { rows: pickWall(perAccount) });

    return null;
  },
});
