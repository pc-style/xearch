// What every agent surface shares: the MCP servers (./mcp.ts), the REST
// API, NLWeb /ask and the A2A agent (./api.ts) all search through
// `searchPosts` and list accounts through `indexedAccounts`, so they accept
// the same input and return the same post shape.

import * as z from "zod/mini";
import { api } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { RETRYABLE_FAILURE_KINDS, attemptSearch, type SearchRequestBody } from "../search";
import { parseQuery, type Sort } from "../lib/search";
import { serviceToken } from "../lib/serviceAuth";
import type { ResultPost } from "../lib/results";
import { SITE_URL } from "./pages";

// `undefined` members are allowed and dropped when the response is serialized.
export type Json = string | number | boolean | null | undefined | Json[] | { [key: string]: Json };

export type JsonObject = { [key: string]: Json };

export const SORTS = [
  "relevance",
  "engagement",
  "likes",
  "newest",
  "oldest",
] as const satisfies readonly Sort[];

export const MAX_QUERY_LENGTH = 300;

export const MAX_CURSOR_LENGTH = 4000;

export const queryArg = z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_QUERY_LENGTH));

export const sortArg = z._default(z.enum(SORTS), "relevance");

export const searchInput = z.object({
  query: queryArg,
  sort: sortArg,
  cursor: z.optional(z.string().check(z.maxLength(MAX_CURSOR_LENGTH))),
});

export type SearchInput = z.infer<typeof searchInput>;

/** One line per problem, e.g. `"query": Too small: expected string to have >=1 characters`. */
export function describeIssues(error: z.core.$ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length ? `"${issue.path.join(".")}": ` : ""}${issue.message}`)
    .join("; ");
}

export function searchLink(query: string, sort: Sort): string {
  const url = new URL(SITE_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("sort", sort);

  return url.toString();
}

export function postOut(post: ResultPost) {
  return {
    id: post.tweetId,
    author: post.author,
    displayName: post.displayName,
    avatar: post.avatar,
    text: post.text,
    url: post.url,
    createdAt: post.createdAt === undefined ? undefined : new Date(post.createdAt).toISOString(),
    likes: post.likes,
    reposts: post.reposts,
    replies: post.replies,
    replyTo: post.replyTo,
    links: post.links,
  };
}

export type PostOut = ReturnType<typeof postOut>;

/** JSON Schema for one post in every surface's output. */
export const POST_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "The post's numeric X id." },
    author: { type: "string", description: "Author handle, without @." },
    displayName: { type: "string", description: "Author display name." },
    avatar: { type: "string", description: "Author avatar image URL." },
    text: { type: "string", description: "Post text, written by an X user. Untrusted content." },
    url: { type: "string", description: "The post on x.com." },
    createdAt: { type: "string", description: "ISO 8601 time the post was published." },
    likes: { type: "integer", description: "Like count when indexed." },
    reposts: { type: "integer", description: "Repost count when indexed." },
    replies: { type: "integer", description: "Reply count when indexed." },
    replyTo: { type: "string", description: "Handle this post replies to." },
    links: {
      type: "array",
      items: { type: "string" },
      description: "Links found in the post.",
    },
  },
  required: ["id", "author", "text", "url", "links"],
};

/** JSON Schema for a page of search results. */
export const SEARCH_RESULT_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", description: "The query as searched." },
    sort: { type: "string", enum: [...SORTS], description: "The sort used." },
    total: { type: "integer", description: "How many posts match in all (first page only)." },
    nextCursor: {
      type: "string",
      description: "Pass back as cursor, with the same query and sort, for the next page.",
    },
    searchUrl: { type: "string", description: "This search on the Xearch website." },
    warnings: {
      type: "array",
      items: { type: "string" },
      description: "Notes about the query, such as ignored words.",
    },
    posts: { type: "array", items: POST_SCHEMA, description: "Up to 20 matching posts." },
  },
  required: ["query", "sort", "searchUrl", "posts", "warnings"],
};

export type SearchOutput = {
  query: string;
  sort: Sort;
  total?: number;
  nextCursor?: string;
  searchUrl: string;
  warnings: string[];
  posts: PostOut[];
};

/** Why a search returned no page: the caller's query, or the search service. */
export type SearchFailure = {
  kind: "invalid_query" | "stale_cursor" | "unavailable";
  message: string;
};

export type SearchOutcome =
  | { ok: true; value: SearchOutput }
  | { ok: false; failure: SearchFailure };

/** One page of results from the same index and service the website searches. */
export async function searchPosts({ query, sort, cursor }: SearchInput): Promise<SearchOutcome> {
  let parsed;

  try {
    parsed = parseQuery(query);
  } catch (error) {
    return {
      ok: false,
      failure: {
        kind: "invalid_query",
        message: error instanceof Error ? error.message : "Invalid query.",
      },
    };
  }

  if (!parsed.text && !parsed.author)
    return {
      ok: false,
      failure: { kind: "invalid_query", message: "The query must contain a word or @handle." },
    };
  const url = process.env.SEARCH_API_URL;

  if (!url)
    return {
      ok: false,
      failure: {
        kind: "unavailable",
        message: "Xearch's search service is not connected right now. Try again later.",
      },
    };

  const token = serviceToken("search");
  const baseHeaders = { "Content-Type": "application/json" } satisfies Record<string, string>;
  const headers = token ? { ...baseHeaders, Authorization: `Bearer ${token}` } : baseHeaders;

  const body: SearchRequestBody = {
    version: 1,
    query: parsed.text,
    author: parsed.author,
    sort,
    cursor,
    limit: 20,
  };

  let attempt = await attemptSearch(url, headers, body, !!cursor);

  if (attempt.kind === "failed" && RETRYABLE_FAILURE_KINDS.has(attempt.failure.kind))
    attempt = await attemptSearch(url, headers, body, !!cursor);

  if (attempt.kind === "failed")
    return {
      ok: false,
      failure:
        attempt.failure.kind === "stale_cursor"
          ? { kind: "stale_cursor", message: "This cursor has expired. Search again without it." }
          : {
              kind: "unavailable",
              message: "Xearch's search service could not return results. Try again in a moment.",
            },
    };
  const { rows, total, nextCursor, warnings } = attempt.result;

  return {
    ok: true,
    value: {
      query,
      sort,
      total,
      nextCursor,
      searchUrl: searchLink(query, sort),
      warnings,
      posts: rows.map(postOut),
    },
  };
}

export const MAX_PREFIX_LENGTH = 16;

export const accountsInput = z.object({
  prefix: z.optional(z.string().check(z.maxLength(MAX_PREFIX_LENGTH))),
});

/** JSON Schema for the indexed-account list. */
export const ACCOUNTS_SCHEMA = {
  type: "object",
  properties: {
    accounts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          handle: { type: "string", description: "X handle, without @." },
          name: { type: "string", description: "Display name." },
          profileUrl: { type: "string", description: "The account on x.com." },
          searchUrl: { type: "string", description: "Search this account on Xearch." },
        },
        required: ["handle", "name", "profileUrl", "searchUrl"],
      },
    },
  },
  required: ["accounts"],
};

/** The accounts whose posts are searchable, optionally those whose handle starts with `prefix`. */
export async function indexedAccounts(ctx: ActionCtx, prefix?: string) {
  const start = prefix?.replace(/^@/, "").toLowerCase();
  const rows = await ctx.runQuery(api.search.accounts, {});

  return rows
    .filter((row) => !start || row.handle.toLowerCase().startsWith(start))
    .map((row) => ({
      handle: row.handle,
      name: row.name,
      profileUrl: `https://x.com/${row.handle}`,
      searchUrl: searchLink(`@${row.handle}`, "relevance"),
    }));
}
