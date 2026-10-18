import { afterEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { parseSearch } from "../convex/lib/search";
import { decodeSemanticResponse } from "../convex/lib/semanticResults";
import { parseLocation, previewPatch } from "../src/locationStore";
import { isAlreadySaved } from "../src/sortOptions";

/**
 * The app's half of semantic search (docs/semantic-architecture.md): a mode
 * beside keyword search, sent to its own private API with its own token,
 * with no sort but similarity, no next page, and a visible warning while the
 * index is still catching up. Keyword search must not change at all.
 */

const modules = import.meta.glob("../convex/**/*.ts");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setup() {
  const t = convexTest(schema, modules);
  const alice = await t.run((ctx) => ctx.db.insert("users", { isAnonymous: true }));

  return { t, alice, a: t.withIdentity({ subject: `${alice}|session` }) };
}

function connectSemantic() {
  vi.stubEnv("SEARCH_API_URL", "https://search.example/search");
  vi.stubEnv("SEARCH_SERVICE_TOKEN", "keyword-token");
  vi.stubEnv("SEMANTIC_API_URL", "https://search.example/semantic/v1/search");
  vi.stubEnv("SEMANTIC_SEARCH_TOKEN", "semantic-token");
}

const post = {
  tweetId: "1599192650053488640",
  author: "theo",
  text: "Do you think we can use AI and ML to rewrite the TypeScript compiler in Rust? #Web3",
  url: "https://x.com/theo/status/1599192650053488640",
  createdAt: 1670112000000,
  likes: 900,
  links: [],
  // Fields the stored post carries that the app does not show are dropped.
  views: 12000,
};

function response(overrides: { pending?: number; captures?: Record<string, number> } = {}) {
  return {
    hits: [{ post, score: 0.71 }],
    model: "BAAI/bge-small-en-v1.5",
    generation: "g",
    coverage: {
      posts: 1000,
      pending: overrides.pending ?? 0,
      acknowledged: 1000 - (overrides.pending ?? 0),
      coverage: 1,
      queueLagMs: 0,
      captures: overrides.captures ?? { complete: 40 },
      staged: 0,
      stages: { complete: 40 },
      scannedAtMs: 1,
      reconciledAtMs: 1,
    },
    coverageKind: "acknowledged",
    underfilled: true,
    candidateBound: 160,
    timings: { embeddingMs: 12, retrievalMs: 3 },
  };
}

describe("semantic query rules", () => {
  it("leaves keyword parsing exactly as it was", () => {
    expect(parseSearch("@theo -rust OR go", undefined)).toEqual(
      parseSearch("@theo -rust OR go", "keyword"),
    );
    expect(parseSearch("@theo", "keyword")).toMatchObject({ author: "theo", text: "" });
  });

  it("takes plain language and one author", () => {
    expect(parseSearch("from:theo rewriting a compiler with AI", "semantic")).toMatchObject({
      author: "theo",
      text: "rewriting a compiler with AI",
    });
    expect(parseSearch('"type-safe" (sort of) C++ tooling', "semantic").text).toBe(
      '"type-safe" (sort of) C++ tooling',
    );
  });

  it("refuses operators an embedding cannot honour, and an author with no words", () => {
    expect(() => parseSearch("@theo", "semantic")).toThrow(/needs words/);
    expect(() => parseSearch("rust -python", "semantic")).toThrow(/keyword search/);
    expect(() => parseSearch("rust OR go", "semantic")).toThrow(/keyword search/);
  });
});

describe("semantic response decoding", () => {
  it("keeps the posts, drops undisplayed fields, and warns while indexing", () => {
    expect(decodeSemanticResponse(response())).toEqual({
      rows: [{ ...post, views: undefined }].map(({ views: _views, ...rest }) => rest),
      warnings: [],
    });
    expect(
      decodeSemanticResponse(response({ pending: 1200, captures: { complete: 30, failed: 1 } }))
        .warnings,
    ).toEqual([
      "Semantic search is still indexing (1,200 posts still being embedded, 1 capture not read yet), so some matching posts may be missing.",
    ]);
  });

  it("counts display string limits as Unicode code points", () => {
    const bounded = { ...post, text: "😀".repeat(6000), displayName: "😀".repeat(100) };

    expect(
      decodeSemanticResponse({ ...response(), hits: [{ post: bounded, score: 0.5 }] }).rows[0],
    ).toMatchObject({ text: bounded.text, displayName: bounded.displayName });
    expect(() =>
      decodeSemanticResponse({
        ...response(),
        hits: [{ post: { ...bounded, text: bounded.text + "x" }, score: 0.5 }],
      }),
    ).toThrow();
  });

  it("rejects malformed or oversized responses", () => {
    const many = { ...response(), hits: Array.from({ length: 21 }, () => ({ post, score: 0.5 })) };

    expect(() => decodeSemanticResponse(many)).toThrow();
    expect(() =>
      decodeSemanticResponse({ ...response(), hits: [{ post: { ...post, url: "http://x" } }] }),
    ).toThrow();
    expect(() =>
      decodeSemanticResponse({ ...response(), coverage: { posts: -1, pending: 0, captures: {} } }),
    ).toThrow();
  });
});

describe("semantic search sessions", () => {
  it("sends natural text and the author to the semantic API with its own token", async () => {
    vi.useFakeTimers();
    const { t, a } = await setup();
    connectSemantic();

    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json(response({ pending: 5, captures: { complete: 40 } })),
    );

    vi.stubGlobal("fetch", fetcher);

    const sessionId = await a.mutation(api.search.start, {
      raw: "@theo rewriting a compiler with AI",
      sort: "relevance",
      mode: "semantic",
    });

    // Fake timers hold the scheduled run, so this is the only one.
    await t.action(internal.search.execute, { sessionId });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];

    expect(url).toBe("https://search.example/semantic/v1/search");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer semantic-token");
    // SAFETY: execute only sends JSON.stringify'd bodies.
    expect(JSON.parse(init?.body as string)).toEqual({
      text: "rewriting a compiler with AI",
      author: "theo",
      limit: 20,
    });
    const session = await t.run((ctx) => ctx.db.get(sessionId));

    expect(session).toMatchObject({ status: "complete", mode: "semantic" });
    expect(session?.rows.map((row) => row.tweetId)).toEqual([post.tweetId]);
    expect(session?.nextCursor).toBeUndefined();
    expect(session?.total).toBeUndefined();
    expect(session?.warnings[0]).toMatch(/still indexing \(5 posts/);
  });

  it("keeps keyword sessions on the keyword API, recorded as keyword", async () => {
    vi.useFakeTimers();
    const { t, a } = await setup();
    connectSemantic();
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ rows: [], warnings: [] }));

    vi.stubGlobal("fetch", fetcher);

    const sessionId = await a.mutation(api.search.start, { raw: "local first", sort: "likes" });

    // Fake timers hold the scheduled run, so this is the only one.
    await t.action(internal.search.execute, { sessionId });
    expect(fetcher.mock.calls[0][0]).toBe("https://search.example/search");
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("Authorization")).toBe(
      "Bearer keyword-token",
    );
    expect(await t.run((ctx) => ctx.db.get(sessionId))).toMatchObject({ mode: "keyword" });
  });

  it("refuses other sorts, pages, and an unconnected semantic API", async () => {
    const { a } = await setup();
    connectSemantic();

    await expect(
      a.mutation(api.search.start, { raw: "compilers", sort: "newest", mode: "semantic" }),
    ).rejects.toThrow(/relevance/);
    await expect(
      a.mutation(api.search.start, {
        raw: "compilers",
        sort: "relevance",
        mode: "semantic",
        cursor: "forged",
      }),
    ).rejects.toThrow(/one page/);

    vi.stubEnv("SEMANTIC_SEARCH_TOKEN", "");
    await expect(
      a.mutation(api.search.start, { raw: "compilers", sort: "relevance", mode: "semantic" }),
    ).rejects.toThrow(/not connected/);
  });

  it("saves the same words once per mode", async () => {
    const { a } = await setup();

    await a.mutation(api.search.save, { raw: "compilers", sort: "relevance" });
    await a.mutation(api.search.save, { raw: "compilers", sort: "relevance", mode: "semantic" });
    await a.mutation(api.search.save, { raw: "compilers", sort: "relevance", mode: "semantic" });
    const saved = await a.query(api.search.saved, {});

    expect(saved.map((s) => s.mode).sort()).toEqual(["keyword", "semantic"]);
    expect(isAlreadySaved(saved, "compilers", "relevance", "semantic")).toBe(true);
    expect(
      isAlreadySaved([{ query: "compilers", sort: "relevance" }], "compilers", "relevance"),
    ).toBe(true);
  });

  it("reports whether semantic search is connected", async () => {
    const { t } = await setup();

    expect((await t.query(api.integrations.configured, { now: 0 })).semantic).toBe(false);
    connectSemantic();
    expect((await t.query(api.integrations.configured, { now: 0 })).semantic).toBe(true);
  });
});

describe("semantic mode in the address", () => {
  it("round-trips mode=semantic and treats old links as keyword", () => {
    expect(previewPatch("https://xearch.invalid/?q=x", { mode: "semantic" })).toBe(
      "/?q=x&mode=semantic",
    );
    expect(previewPatch("https://xearch.invalid/?q=x&mode=semantic", { mode: "keyword" })).toBe(
      "/?q=x",
    );
    expect(parseLocation("https://xearch.invalid/?q=x&sort=likes")).toMatchObject({
      mode: "keyword",
      sort: "likes",
    });
    expect(parseLocation("https://xearch.invalid/?q=x&sort=likes&mode=semantic")).toMatchObject({
      mode: "semantic",
      sort: "relevance",
    });
  });
});
