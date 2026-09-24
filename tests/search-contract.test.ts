import { afterEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";

/**
 * Freezes the application's half of the search boundary against
 * docs/integration-contract.md ("Search service") so a drift in the wire
 * request/response shape, or in this app's own error/authorization
 * behavior, breaks a test here instead of surfacing first in the product.
 * See docs/publication-contract.md for the separate publication-update
 * boundary (covered by tests/publication.test.ts and friends) — not touched
 * by this file.
 */

const modules = import.meta.glob("../convex/**/*.ts");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setup() {
  const t = convexTest(schema, modules);
  const alice = await t.run((ctx) => ctx.db.insert("users", { isAnonymous: true }));

  return { t, alice, a: t.withIdentity({ subject: `${alice}|session` }) };
}

// Copied verbatim from docs/integration-contract.md's "Search service"
// section. `@theo local first` is chosen as the session's raw query
// specifically because parseQuery (convex/lib/search.ts) turns it into
// exactly this documented request's `query`/`author` split — see the first
// test below.
const DOC_SEARCH_REQUEST = {
  version: 1,
  query: "local first",
  author: "theo",
  sort: "relevance",
  limit: 20,
  cursor: "optional-opaque-cursor",
  includeStats: true,
};

const DOC_SEARCH_RESPONSE = {
  rows: [
    {
      tweetId: "123",
      author: "theo",
      text: "A display excerpt, up to 6000 characters",
      url: "https://x.com/theo/status/123",
      createdAt: 1789776000000,
      likes: 12,
      reposts: 2,
      replies: 1,
      links: ["https://example.com/article"],
      displayName: "Theo",
      avatar: "https://example.com/avatar.jpg",
    },
  ],
  nextCursor: "optional",
  warnings: [],
  stats: {
    backend: {
      totalUs: 1200,
      reloadUs: 40,
      fingerprintUs: 12,
      cursorUs: 2,
      compileUs: 18,
      retrieveUs: 980,
      rankingCalls: 240,
      materializeUs: 90,
      candidateHits: 21,
      returnedRows: 20,
      indexDocs: 100000,
      segments: 8,
    },
    api: {
      totalUs: 1500,
      authUs: 8,
      validateUs: 1,
      cursorVerifyUs: 3,
      parseUs: 7,
      permitUs: 1,
      queueUs: 15,
      engineUs: 1210,
      postprocessUs: 20,
      cursorSignUs: 9,
    },
  },
};

describe("search request/response fixtures (docs/integration-contract.md)", () => {
  it("builds the outbound request from the documented example, field for field", async () => {
    const { t, alice } = await setup();
    vi.stubEnv("SEARCH_API_URL", "https://search.example/query");
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(DOC_SEARCH_RESPONSE));
    vi.stubGlobal("fetch", fetcher);

    const sessionId = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        owner: alice,
        raw: "@theo local first",
        sort: "relevance",
        cursor: "optional-opaque-cursor",
        includeStats: true,
        status: "queued",
        rows: [],
        warnings: [],
      }),
    );

    await t.action(internal.search.execute, { sessionId });
    expect(fetcher).toHaveBeenCalledOnce();
    // SAFETY: convex/search.ts's `execute` only ever calls `fetch` with a
    // JSON.stringify'd string body (the only fetch call this action makes),
    // so `body` is a string here.
    const body = JSON.parse(fetcher.mock.calls[0][1]?.body as string);
    expect(body).toEqual(DOC_SEARCH_REQUEST);
    expect((await t.run((ctx) => ctx.db.get(sessionId)))?.stats).toEqual(DOC_SEARCH_RESPONSE.stats);
    // The documented wire contract has no scope field. search.start accepts
    // an authorized-scope argument (see the describe block below), but
    // enforcement stays entirely on this app's side — it must never leak
    // into the request the search service sees.
    expect(Object.keys(body)).not.toContain("scope");
  });

  it("decodes the documented example response exactly as published", async () => {
    const { decodeSearchResponse } = await import("../convex/lib/results");
    expect(decodeSearchResponse(DOC_SEARCH_RESPONSE)).toEqual(DOC_SEARCH_RESPONSE);
  });

  it("surfaces a network failure or an invalid page as the one frozen generic-failure message", async () => {
    const { t, alice } = await setup();
    vi.stubEnv("SEARCH_API_URL", "https://search.example/query");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw new Error("network down");
      }),
    );

    const sessionId = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        owner: alice,
        raw: "local first",
        sort: "relevance",
        status: "queued",
        rows: [],
        warnings: [],
      }),
    );

    await t.action(internal.search.execute, { sessionId });
    expect(await t.run((ctx) => ctx.db.get(sessionId))).toMatchObject({
      status: "failed",
      error:
        "The search service could not return a valid result page. Try again or check its connection.",
    });
  });
});

describe("stale search cursor — restart search, not a generic failure", () => {
  // The Rust API maps StaleCursor to HTTP 409 Conflict.
  it("surfaces a 409 on a request that carried a cursor as 'restart your search'", async () => {
    const { t, alice } = await setup();
    vi.stubEnv("SEARCH_API_URL", "https://search.example/query");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(null, { status: 409 })),
    );

    const sessionId = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        owner: alice,
        raw: "local first",
        sort: "relevance",
        cursor: "an-old-page-cursor",
        status: "queued",
        rows: [],
        warnings: [],
      }),
    );

    await t.action(internal.search.execute, { sessionId });
    expect(await t.run((ctx) => ctx.db.get(sessionId))).toMatchObject({
      status: "failed",
      error: "This search expired. Restart your search.",
    });
  });

  it("does not call a first-page 409 (no cursor sent) a stale cursor", async () => {
    const { t, alice } = await setup();
    vi.stubEnv("SEARCH_API_URL", "https://search.example/query");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(null, { status: 409 })),
    );

    const sessionId = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        owner: alice,
        raw: "local first",
        sort: "relevance",
        status: "queued",
        rows: [],
        warnings: [],
      }),
    );

    await t.action(internal.search.execute, { sessionId });
    expect(await t.run((ctx) => ctx.db.get(sessionId))).toMatchObject({
      status: "failed",
      error:
        "The search service could not return a valid result page. Try again or check its connection.",
    });
  });

  it("never inspects the cursor's own content — an opaque, unparseable cursor still round-trips verbatim", async () => {
    const { t, alice } = await setup();
    vi.stubEnv("SEARCH_API_URL", "https://search.example/query");
    const opaque = "not-json===opaque-blob";

    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ rows: [], nextCursor: "next", warnings: [] }),
    );

    vi.stubGlobal("fetch", fetcher);

    const sessionId = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        owner: alice,
        raw: "local first",
        sort: "relevance",
        cursor: opaque,
        status: "queued",
        rows: [],
        warnings: [],
      }),
    );

    await t.action(internal.search.execute, { sessionId });
    // SAFETY: same as above — convex/search.ts's `execute` only ever calls
    // `fetch` with a JSON.stringify'd string body.
    const body = JSON.parse(fetcher.mock.calls[0][1]?.body as string);
    expect(body.cursor).toBe(opaque);
  });
});

describe("authorized collection scope (fails closed)", () => {
  it("rejects a client-requested account scope — not implemented, so it must fail closed rather than silently honor or downgrade it", async () => {
    const { t, a } = await setup();
    vi.stubEnv("SEARCH_API_URL", "https://search.example/query");

    const accountId = await t.run((ctx) =>
      ctx.db.insert("accounts", { handle: "theo", userId: "999", name: "Theo" }),
    );

    await expect(
      a.mutation(api.search.start, {
        raw: "local first",
        sort: "relevance",
        scope: { kind: "account", accountId },
      }),
    ).rejects.toThrow("This search scope is not available yet.");
  });

  it("still allows the only authorized scope, explicit global", async () => {
    const { a } = await setup();
    vi.stubEnv("SEARCH_API_URL", "https://search.example/query");
    await expect(
      a.mutation(api.search.start, {
        raw: "local first",
        sort: "relevance",
        scope: { kind: "global" },
      }),
    ).resolves.toBeDefined();
  });

  it("still allows the default, scope omitted entirely, unchanged from before this argument existed", async () => {
    const { a } = await setup();
    vi.stubEnv("SEARCH_API_URL", "https://search.example/query");
    await expect(
      a.mutation(api.search.start, { raw: "local first", sort: "relevance" }),
    ).resolves.toBeDefined();
  });

  it("never persists scope onto the session document — nothing narrower than global exists to remember yet", async () => {
    const { t, a } = await setup();
    vi.stubEnv("SEARCH_API_URL", "https://search.example/query");

    const sessionId = await a.mutation(api.search.start, {
      raw: "local first",
      sort: "relevance",
      scope: { kind: "global" },
    });

    expect(await t.run((ctx) => ctx.db.get(sessionId))).not.toHaveProperty("scope");
  });
});
