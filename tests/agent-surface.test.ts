import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import staticHosting from "@convex-dev/static-hosting/test";
import schema from "../convex/schema";
import { sha256 } from "../convex/agents/discovery";
import type { Json } from "../convex/agents/core";
import { SITE_URL } from "../convex/agents/pages";

const modules = import.meta.glob("../convex/**/*.ts");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function setup() {
  const t = convexTest(schema, modules);
  staticHosting.register(t);

  return t;
}

type Rpc = {
  id?: number;
  result?: {
    protocolVersion?: string;
    serverInfo?: { name: string };
    tools?: { name: string; _meta?: { ui?: { resourceUri: string } } }[];
    contents?: { mimeType: string; text: string }[];
    structuredContent?: { posts?: { id: string; url: string }[]; nextCursor?: string };
    isError?: boolean;
  };
  error?: { code: number; message: string };
};

async function rpc(
  t: ReturnType<typeof setup>,
  method: string,
  params: { [key: string]: Json } = {},
  path = "/mcp",
): Promise<Rpc> {
  const response = await t.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  expect(response.status).toBe(200);

  return await response.json();
}

describe("agent-facing documents", () => {
  it("serves llms.txt as text, and every link in it resolves", async () => {
    const t = setup();
    const response = await t.fetch("/llms.txt");
    const body = await response.text();

    expect(response.headers.get("Content-Type")).toContain("text/plain");
    expect(body.startsWith("# Xearch")).toBe(true);
    expect(body).toContain("## When to use this");

    const links = [...body.matchAll(/\]\((https:\/\/[^)]+)\)/g)].map((match) => match[1]);

    expect(links.length).toBeGreaterThan(5);

    for (const link of links.filter((href) => href.startsWith(SITE_URL))) {
      const path = link.slice(SITE_URL.length);

      const target = await t.fetch(
        path,
        path === "/mcp" || path === "/docs/mcp"
          ? {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
            }
          : {},
      );

      expect(target.status, path).toBe(200);
    }
  });

  it("answers the home page in Markdown when asked, with Vary and Link headers", async () => {
    const t = setup();
    const response = await t.fetch("/", { headers: { Accept: "text/markdown" } });

    expect(response.headers.get("Content-Type")).toContain("text/markdown");
    expect(response.headers.get("Vary")).toContain("Accept");
    expect(response.headers.get("Link")).toContain('</sitemap.xml>; rel="sitemap"');
    expect(await response.text()).toMatch(
      /^---\ntitle: "Xearch: search public X posts"\n[^]*?\n---\n\n# Xearch\n/,
    );

    const crawler = await t.fetch("/", {
      headers: { "User-Agent": "GPTBot/1.2", Accept: "text/html" },
    });

    expect(crawler.headers.get("Content-Type")).toContain("text/markdown");

    const agentMode = await t.fetch("/?mode=agent");

    expect(agentMode.headers.get("Content-Type")).toContain("text/markdown");
    expect(await agentMode.text()).toMatch(/## Endpoints[^]*## Authentication/);
  });

  it("opens Markdown twins with frontmatter then the heading, and auth.md with its heading", async () => {
    const t = setup();

    const paths = [
      "/index.md",
      "/docs.md",
      "/docs/api.md",
      "/api/v1.md",
      "/docs/llms.txt.md",
      "/mcp.md",
    ];

    for (const path of paths) {
      const response = await t.fetch(path);

      expect(response.status, path).toBe(200);
      expect(response.headers.get("Content-Type"), path).toContain("text/markdown");
      expect(await response.text(), path).toMatch(/^---\ntitle: "[^"]+"\n[^]*?\n---\n\n# /);
    }

    expect(await (await t.fetch("/auth.md")).text()).toMatch(/^# Authentication for agents\n/);
  });

  it("returns a real 404 with Markdown guidance for unknown paths", async () => {
    const t = setup();
    const response = await t.fetch("/no/such/page", { headers: { Accept: "text/markdown" } });

    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toContain("text/markdown");
    expect(await response.text()).toContain("/llms.txt");

    const browser = await t.fetch("/no/such/page", { headers: { Accept: "text/html" } });

    // No index.html is uploaded here, so this checks the status, not the app page.
    expect(browser.status).toBe(404);

    const client = await t.fetch("/no/such/page", { headers: { Accept: "application/json" } });

    expect(client.status).toBe(404);
    expect(client.headers.get("Content-Type")).toContain("application/problem+json");
    expect((await client.json()).code).toBe("not_found");
  });

  it("answers people who open an MCP endpoint with a page, and MCP clients with a 405", async () => {
    const t = setup();
    const page = await t.fetch("/mcp", { headers: { Accept: "text/html" } });

    expect(page.status).toBe(200);
    expect(await page.text()).toContain("search_posts");
    expect((await t.fetch("/mcp", { headers: { Accept: "text/event-stream" } })).status).toBe(405);
  });

  it("serves trust pages as HTML with real content, and their Markdown twins", async () => {
    const t = setup();

    for (const path of ["/about", "/contact", "/privacy", "/docs", "/pricing"]) {
      const html = await t.fetch(path, { headers: { Accept: "text/html" } });
      const text = (await html.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

      expect(html.headers.get("Content-Type"), path).toContain("text/html");
      expect(text.length, path).toBeGreaterThan(500);

      const markdown = await t.fetch(`${path}.md`);

      expect(markdown.headers.get("Content-Type"), path).toContain("text/markdown");
    }
  });

  it("publishes an agent skills index whose digest matches the skill it serves", async () => {
    const t = setup();
    const index = await (await t.fetch("/.well-known/agent-skills/index.json")).json();
    const skill = index.skills[0];
    const body = await (await t.fetch(skill.url)).text();

    expect(skill.digest).toBe(`sha256:${await sha256(body)}`);
    // The Agent Plugins bundle (plugin.json) ships the same skill from the repo.
    expect(readFileSync("skills/search-x-posts/SKILL.md", "utf8")).toBe(body);
  });

  it("publishes the catalog, API catalog, robots and sitemap", async () => {
    const t = setup();
    const catalog = await (await t.fetch("/.well-known/ard.json")).json();

    for (const entry of catalog.entries) {
      expect(entry.identifier).toMatch(/^urn:air:xearch\.pcstyle\.tech:/);
      expect((await t.fetch(new URL(entry.url).pathname)).status, entry.url).toBe(200);
    }

    const apiCatalog = await t.fetch("/.well-known/api-catalog");

    expect(apiCatalog.headers.get("Content-Type")).toContain("application/linkset+json");
    expect(await (await t.fetch("/robots.txt")).text()).toContain("Sitemap: ");
    expect(await (await t.fetch("/sitemap.xml")).text()).toContain("<lastmod>");
  });
});

describe("MCP servers", () => {
  it("introduces itself and lists its tools and app view", async () => {
    const t = setup();
    const init = await rpc(t, "initialize", { protocolVersion: "2025-06-18" });

    expect(init.result?.protocolVersion).toBe("2025-06-18");
    expect(init.result?.serverInfo?.name).toBe("xearch");

    const tools = (await rpc(t, "tools/list")).result?.tools ?? [];

    expect(tools.map((tool) => tool.name)).toEqual([
      "search_posts",
      "list_indexed_accounts",
      "get_search_link",
    ]);

    const uri = tools[0]._meta?.ui?.resourceUri ?? "";
    const view = (await rpc(t, "resources/read", { uri })).result?.contents?.[0];

    expect(view?.mimeType).toBe("text/html;profile=mcp-app");
    expect(view?.text.startsWith("<!DOCTYPE html>")).toBe(true);
  });

  it("answers bad requests with structured JSON-RPC errors", async () => {
    const t = setup();

    expect((await rpc(t, "no/such/method")).error?.code).toBe(-32601);
    expect((await rpc(t, "tools/call", { name: "search_posts", arguments: {} })).error?.code).toBe(
      -32602,
    );
    expect((await rpc(t, "tools/call", { name: "nope" })).error?.code).toBe(-32602);

    const notification = await t.fetch("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });

    expect(notification.status).toBe(202);
    expect(
      (await t.fetch("/mcp", { headers: { Accept: "application/json, text/event-stream" } }))
        .status,
    ).toBe(405);
  });

  it("searches through the search service and returns posts", async () => {
    vi.stubEnv("SEARCH_API_URL", "https://search.test/v1/search");
    const requests: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        requests.push(String(init.body));

        return Response.json({
          rows: [
            {
              tweetId: "1",
              author: "levelsio",
              text: "pricing is hard",
              url: "https://x.com/levelsio/status/1",
              links: [],
              createdAt: 1_700_000_000_000,
              likes: 10,
            },
          ],
          total: 1,
          nextCursor: "next",
        });
      }),
    );
    const t = setup();

    const call = await rpc(t, "tools/call", {
      name: "search_posts",
      arguments: { query: "@levelsio pricing", sort: "likes" },
    });

    expect(JSON.parse(requests[0])).toMatchObject({
      query: "pricing",
      author: "levelsio",
      sort: "likes",
    });
    expect(call.result?.isError).toBeUndefined();
    expect(call.result?.structuredContent?.posts?.[0].url).toBe("https://x.com/levelsio/status/1");
    expect(call.result?.structuredContent?.nextCursor).toBe("next");
  });

  it("serves the docs over a second MCP server", async () => {
    const t = setup();

    const found = await rpc(
      t,
      "tools/call",
      { name: "search_docs", arguments: { query: "cursor" } },
      "/docs/mcp",
    );

    expect(JSON.stringify(found.result)).toContain("/docs.md");

    const page = await rpc(
      t,
      "tools/call",
      { name: "fetch_doc", arguments: { path: "/privacy" } },
      "/docs/mcp",
    );

    expect(JSON.stringify(page.result)).toContain("Privacy policy");
  });
});

function stubSearchService(): string[] {
  vi.stubEnv("SEARCH_API_URL", "https://search.test/v1/search");
  const requests: string[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      requests.push(String(init.body));

      return Response.json({
        rows: [
          {
            tweetId: "1",
            author: "levelsio",
            text: "pricing is hard",
            url: "https://x.com/levelsio/status/1",
            links: [],
            createdAt: 1_700_000_000_000,
            likes: 10,
          },
        ],
        total: 1,
        nextCursor: "next",
      });
    }),
  );

  return requests;
}

type OpenApi = {
  openapi: string;
  paths: { [path: string]: { [method: string]: { operationId: string; description: string } } };
};

describe("REST API, NLWeb and A2A", () => {
  it("searches over GET and describes itself with OpenAPI", async () => {
    const requests = stubSearchService();
    const t = setup();
    const response = await t.fetch("/api/v1/search?q=%40levelsio+pricing&sort=likes");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(JSON.parse(requests[0])).toMatchObject({
      query: "pricing",
      author: "levelsio",
      sort: "likes",
    });
    expect(body.posts[0].url).toBe("https://x.com/levelsio/status/1");
    expect(body.nextCursor).toBe("next");

    const spec: OpenApi = await (await t.fetch("/openapi.json")).json();
    const operations = Object.values(spec.paths).flatMap((path) => Object.values(path));

    expect(spec.openapi).toBe("3.1.0");
    expect(new Set(operations.map((op) => op.operationId)).size).toBe(operations.length);

    for (const op of operations) expect(op.description, op.operationId).toBeTruthy();
  });

  it("answers bad API requests with problem documents", async () => {
    const t = setup();
    const missing = await t.fetch("/api/v1/search");

    expect(missing.status).toBe(400);
    expect(missing.headers.get("Content-Type")).toContain("application/problem+json");
    expect((await missing.json()).code).toBe("invalid_request");

    const operator = await t.fetch("/api/v1/search?q=foo+lang%3Aen");

    expect([400, 503]).toContain(operator.status);
    expect((await t.fetch("/api/v2/nothing")).status).toBe(404);
    expect((await t.fetch("/api/v1/search", { method: "POST" })).status).toBe(405);
  });

  it("answers the sandbox from fixed sample posts, with paging and the same errors", async () => {
    const t = setup();
    const first = await (await t.fetch("/api/sandbox/v1/search?q=pricing&sort=likes")).json();

    expect(first.total).toBe(3);
    expect(first.posts.map((post: { id: string }) => post.id)).toEqual(["5", "2"]);

    const next = await (
      await t.fetch(`/api/sandbox/v1/search?q=pricing&sort=likes&cursor=${first.nextCursor}`)
    ).json();

    expect(next.posts.map((post: { id: string }) => post.id)).toEqual(["1"]);
    expect(next.nextCursor).toBeUndefined();
    expect((await t.fetch("/api/sandbox/v1/search?q=pricing&cursor=stale")).status).toBe(410);
    expect((await (await t.fetch("/api/sandbox/v1/accounts")).json()).accounts).toHaveLength(2);
  });

  it("runs several searches in one batch request", async () => {
    stubSearchService();
    const t = setup();

    const response = await t.fetch("/api/v1/search/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "abc" },
      body: JSON.stringify({
        searches: [{ query: "pricing" }, { query: "convex", sort: "newest" }],
      }),
    });

    const body = await response.json();

    expect(response.headers.get("Idempotency-Key")).toBe("abc");
    expect(body.results.map((result: { status: number }) => result.status)).toEqual([200, 200]);
  });

  it("answers NLWeb asks as JSON and as a stream", async () => {
    stubSearchService();
    const t = setup();

    const answer = await (
      await t.fetch("/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: { text: "pricing" } }),
      })
    ).json();

    expect(answer._meta).toMatchObject({ response_type: "answer", version: "0.55" });
    expect(answer.results[0].url).toBe("https://x.com/levelsio/status/1");

    const stream = await t.fetch("/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: { text: "pricing" }, prefer: { streaming: true } }),
    });

    const events = [...(await stream.text()).matchAll(/^event: (\w+)$/gm)].map((match) => match[1]);

    expect(stream.headers.get("Content-Type")).toContain("text/event-stream");
    expect(events).toEqual(["start", "result", "complete"]);
  });

  it("publishes an A2A agent card and answers message/send", async () => {
    stubSearchService();
    const t = setup();
    const card = await (await t.fetch("/.well-known/agent-card.json")).json();

    expect(card.url).toBe(`${SITE_URL}/a2a`);

    const reply = await (
      await t.fetch("/a2a", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "message/send",
          params: {
            message: { messageId: "m1", role: "user", parts: [{ kind: "text", text: "pricing" }] },
          },
        }),
      })
    ).json();

    expect(reply.id).toBe(7);
    expect(reply.result.kind).toBe("message");
    expect(reply.result.parts[0].text).toContain("https://x.com/levelsio/status/1");
  });
});
