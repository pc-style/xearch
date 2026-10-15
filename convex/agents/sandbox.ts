// The REST API's sandbox (/api/sandbox/v1): the same endpoints and the same
// validation as /api/v1, answered from a few fixed sample posts instead of
// the index, so an integration can be tested against data that never
// changes. Nothing here calls the search service.

import { parseQuery, type Sort } from "../lib/search";
import type { ResultPost } from "../lib/results";
import { postOut, searchLink, type SearchInput, type SearchOutcome } from "./core";

const PAGE_SIZE = 2;

const NAMES = {
  sandbox_ada: "Ada (sandbox)",
  sandbox_lin: "Lin (sandbox)",
};

function sample(
  id: string,
  author: keyof typeof NAMES,
  text: string,
  createdAt: string,
  likes: number,
): ResultPost {
  return {
    tweetId: id,
    author,
    displayName: NAMES[author],
    text,
    url: `https://example.com/sandbox/${author}/${id}`,
    createdAt: Date.parse(createdAt),
    likes,
    replies: Math.round(likes / 10),
    links: [],
  };
}

/** Sample posts. Their links point at example.com: they are not real posts. */
const POSTS = [
  sample(
    "1",
    "sandbox_ada",
    "Pricing is the hardest part of shipping a product.",
    "2026-01-01",
    120,
  ),
  sample("2", "sandbox_ada", "Raised our pricing today. Nobody left.", "2026-01-02", 340),
  sample(
    "3",
    "sandbox_ada",
    "Search should be instant. Anything slower feels broken.",
    "2026-01-03",
    45,
  ),
  sample("4", "sandbox_lin", "Shipped full-text search for our docs this week.", "2026-01-04", 80),
  sample(
    "5",
    "sandbox_lin",
    "Hot take: usage-based pricing is just pricing with extra steps.",
    "2026-01-05",
    510,
  ),
];

const ORDER: Record<Sort, (a: ResultPost, b: ResultPost) => number> = {
  relevance: () => 0,
  engagement: (a, b) => (b.likes ?? 0) + (b.replies ?? 0) - (a.likes ?? 0) - (a.replies ?? 0),
  likes: (a, b) => (b.likes ?? 0) - (a.likes ?? 0),
  newest: (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
  oldest: (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0),
};

/** `searchPosts` over the sample posts: two per page, so paging can be tested too. */
export async function sandboxSearch({ query, sort, cursor }: SearchInput): Promise<SearchOutcome> {
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
  const offset = cursor === undefined ? 0 : Number(cursor.match(/^sandbox:(\d+)$/)?.[1] ?? NaN);

  if (!Number.isInteger(offset))
    return {
      ok: false,
      failure: {
        kind: "stale_cursor",
        message: "This cursor has expired. Search again without it.",
      },
    };
  const words = parsed.text.toLowerCase().split(/\s+/).filter(Boolean);

  const matches = POSTS.filter(
    (post) =>
      (!parsed.author || post.author === parsed.author.toLowerCase()) &&
      words.every((word) => post.text.toLowerCase().includes(word)),
  ).sort(ORDER[sort]);

  const next = offset + PAGE_SIZE;

  return {
    ok: true,
    value: {
      query,
      sort,
      total: offset === 0 ? matches.length : undefined,
      nextCursor: next < matches.length ? `sandbox:${next}` : undefined,
      searchUrl: searchLink(query, sort),
      warnings: ["Sandbox: fixed sample posts, not the live index."],
      posts: matches.slice(offset, next).map(postOut),
    },
  };
}

export async function sandboxAccounts(prefix?: string) {
  const start = prefix?.replace(/^@/, "").toLowerCase();

  return Object.entries(NAMES).flatMap(([handle, name]) =>
    start && !handle.startsWith(start)
      ? []
      : [
          {
            handle,
            name,
            profileUrl: `https://example.com/sandbox/${handle}`,
            searchUrl: searchLink(`@${handle}`, "relevance"),
          },
        ],
  );
}
