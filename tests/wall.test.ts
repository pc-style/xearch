import { afterEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { pickWall } from "../convex/wall";
import type { ResultPost } from "../convex/lib/results";

const modules = import.meta.glob("../convex/**/*.ts");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function post(author: string, id: string, likes: number, text = `post ${id}`): ResultPost {
  return {
    tweetId: id,
    author,
    text,
    url: `https://x.com/${author}/status/${id}`,
    likes,
    links: [],
  };
}

describe("pickWall", () => {
  it("takes every account's best post before anyone's second", () => {
    const wall = pickWall([
      [post("a", "1", 900), post("a", "2", 800), post("a", "3", 700)],
      [post("b", "4", 10)],
    ]);

    expect(wall.map((p) => p.tweetId)).toEqual(["1", "4", "2", "3"]);
  });

  it("drops duplicates and text-less posts, and stops at the size", () => {
    const wall = pickWall(
      [[post("a", "1", 5), post("a", "1", 5)], [post("b", "2", 9, "  ")], [post("c", "3", 1)]],
      2,
    );

    expect(wall.map((p) => p.tweetId)).toEqual(["1", "3"]);
  });
});

describe("wall.refresh / wall.posts", () => {
  it("asks the search service for each account's most-liked posts and serves them publicly", async () => {
    vi.stubEnv("SEARCH_API_URL", "https://search.test/v1/search");
    vi.stubEnv("SEARCH_SERVICE_TOKEN", "search-token");
    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      await ctx.db.insert("accounts", { handle: "anthropicai", userId: "1", name: "Anthropic" });
      await ctx.db.insert("accounts", { handle: "openai", userId: "2", name: "OpenAI" });
    });

    const requests: unknown[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        requests.push({ body, auth: new Headers(init.headers).get("Authorization") });

        const rows =
          body.author === "openai"
            ? [post("openai", "10", 500), post("openai", "11", 40)]
            : [post("anthropicai", "20", 300)];

        return new Response(JSON.stringify({ rows }), { status: 200 });
      }),
    );

    await t.action(internal.wall.refresh, {});

    expect(requests).toContainEqual({
      body: { version: 1, query: "", author: "openai", sort: "likes", limit: 3 },
      auth: "Bearer search-token",
    });

    // Public: no identity needed, same as `search.accounts`.
    const wall = await t.query(api.wall.posts, {});

    expect(wall.map((p) => [p.tweetId, p.rank])).toEqual([
      ["10", 0],
      ["20", 1],
      ["11", 2],
    ]);
  });

  it("keeps the previous wall when the search service returns nothing", async () => {
    vi.stubEnv("SEARCH_API_URL", "https://search.test/v1/search");
    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      await ctx.db.insert("accounts", { handle: "openai", userId: "2", name: "OpenAI" });
      await ctx.db.insert("wallPosts", { ...post("openai", "1", 5), rank: 0 });
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 503 })),
    );

    await t.action(internal.wall.refresh, {});

    expect((await t.query(api.wall.posts, {})).map((p) => p.tweetId)).toEqual(["1"]);
  });

  it("keeps a failed account's posts when only some requests fail", async () => {
    vi.stubEnv("SEARCH_API_URL", "https://search.test/v1/search");
    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      await ctx.db.insert("accounts", { handle: "anthropicai", userId: "1", name: "Anthropic" });
      await ctx.db.insert("accounts", { handle: "openai", userId: "2", name: "OpenAI" });
      await ctx.db.insert("wallPosts", { ...post("openai", "1", 5), rank: 0 });
      await ctx.db.insert("wallPosts", { ...post("anthropicai", "2", 4), rank: 1 });
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) =>
        JSON.parse(String(init.body)).author === "openai"
          ? new Response("down", { status: 503 })
          : new Response(JSON.stringify({ rows: [post("anthropicai", "20", 300)] }), {
              status: 200,
            }),
      ),
    );

    await t.action(internal.wall.refresh, {});

    // anthropicai's fresh post replaces its old one; openai's old post stays.
    expect((await t.query(api.wall.posts, {})).map((p) => p.tweetId)).toEqual(["20", "1"]);
  });

  it("reaches accounts past the first page of handles", async () => {
    vi.stubEnv("SEARCH_API_URL", "https://search.test/v1/search");
    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      for (let i = 0; i < 250; i++)
        await ctx.db.insert("accounts", {
          handle: `user${String(i).padStart(3, "0")}`,
          userId: String(i),
          name: `User ${i}`,
        });
    });

    const authors = new Set<string>();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        authors.add(JSON.parse(String(init.body)).author);

        return new Response(JSON.stringify({ rows: [] }), { status: 200 });
      }),
    );

    await t.action(internal.wall.refresh, {});

    expect(authors.size).toBe(250);
    expect(authors.has("user249")).toBe(true);
  });

  it("does nothing when search isn't configured", async () => {
    const t = convexTest(schema, modules);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await t.action(internal.wall.refresh, {});

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await t.query(api.wall.posts, {})).toEqual([]);
  });
});
