// The site's HTTP surface for agents and crawlers, and the catch-all that
// serves the static frontend. `registerStaticRoutes` from
// @convex-dev/static-hosting answers every unknown path with the app shell
// and a 200, so agents probing for a resource conclude it exists; this
// catch-all serves the same deployed assets but answers unknown paths with a
// real 404, and lets the home page answer in Markdown when asked.

import type { HttpRouter } from "convex/server";
import { components } from "../_generated/api";
import { httpAction, type ActionCtx } from "../_generated/server";
import {
  AI_CATALOG,
  API_CATALOG,
  DOCS_SERVER_CARD,
  ROBOTS_TXT,
  SCHEMAMAP_XML,
  SERVER_CARD,
  SKILL_MD,
  SKILL_PATH,
  agentSkillsIndex,
  schemaFeedJsonl,
  sitemapXml,
} from "./discovery";
import { markdownToHtml, stripFrontmatter } from "./markdown";
import { CORS_HEADERS, DOCS_SERVER, PRODUCT_SERVER, mcpGet, serveMcp, type Json } from "./mcp";
import {
  DOCS_LLMS_TXT,
  HOME,
  LLMS_TXT,
  PAGES,
  SITE_URL,
  llmsFullTxt,
  markdownPath,
  pageMarkdown,
  type Page,
} from "./pages";

const MARKDOWN = "text/markdown; charset=utf-8";

const CACHE = "public, max-age=300";

/** Advertised on the home page: where an agent goes next. */
const HOME_LINKS = [
  '</index.md>; rel="alternate"; type="text/markdown"',
  '</sitemap.xml>; rel="sitemap"; type="application/xml"',
  '</llms.txt>; rel="describedby"; type="text/plain"',
  '</.well-known/api-catalog>; rel="api-catalog"',
  '</docs>; rel="service-doc"',
  '</mcp/server-card>; rel="service-desc"; type="application/mcp-server-card+json"',
  '</.well-known/ard.json>; rel="describedby"; type="application/json"',
].join(", ");

// Training and search crawlers that read Markdown better than an app shell.
// User-triggered agents (ChatGPT-User, Claude-User) are left out on purpose:
// they act for a person who may want the real page.
const MARKDOWN_CRAWLERS =
  /GPTBot|ClaudeBot|anthropic-ai|PerplexityBot|Google-Extended|Applebot-Extended|DeepSeekBot|CCBot/i;

function acceptQuality(accept: string, type: string): number {
  for (const part of accept.split(",")) {
    const [name, ...params] = part.trim().split(";");

    if (name.trim().toLowerCase() !== type) continue;
    const q = params.map((param) => param.trim()).find((param) => param.startsWith("q="));

    return q ? Number(q.slice(2)) || 0 : 1;
  }

  return -1;
}

/** Whether this request asked for Markdown over HTML. */
export function prefersMarkdown(request: Request): boolean {
  const accept = request.headers.get("Accept") ?? "";
  const markdown = acceptQuality(accept, "text/markdown");

  if (markdown > 0 && markdown >= acceptQuality(accept, "text/html")) return true;

  return MARKDOWN_CRAWLERS.test(request.headers.get("User-Agent") ?? "");
}

function text(body: string, contentType: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": CACHE,
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

function json(body: Json, contentType = "application/json; charset=utf-8"): Response {
  return text(JSON.stringify(body, null, 2), contentType);
}

function markdownPage(page: Page): Response {
  return text(pageMarkdown(page), MARKDOWN, {
    Link: `<${SITE_URL}${page.path}>; rel="canonical"`,
  });
}

const NAV = PAGES.map(
  (page) =>
    `<a href="${page.path}">${page.path === "/" ? "Search" : page.title.replace(/^Xearch /, "")}</a>`,
).join(" · ");

function htmlPage(page: Page): Response {
  const body = stripFrontmatter(pageMarkdown(page));

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${page.title}</title>
<meta name="description" content="${page.description}">
<link rel="canonical" href="${SITE_URL}${page.path}">
<link rel="alternate" type="text/markdown" href="${markdownPath(page)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:type" content="website">
<meta property="og:title" content="${page.title}">
<meta property="og:description" content="${page.description}">
<meta property="og:url" content="${SITE_URL}${page.path}">
<meta property="og:image" content="${SITE_URL}/og.png">
<style>
body{margin:0 auto;max-width:720px;padding:32px 20px 64px;background:#080808;color:#e9e7e3;font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:#ffc99b}h1{font-size:34px;letter-spacing:-.02em;line-height:1.15}h2{font-size:20px;margin-top:2em}
code{font:14px ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}pre{overflow-x:auto;background:#121110;border:1px solid #292827;border-radius:8px;padding:14px}
nav,footer{color:#8b8883;font-size:14px}footer{margin-top:48px}
</style>
</head>
<body>
<nav aria-label="Site"><a href="/">xearch.</a> · ${NAV}</nav>
<main>
${markdownToHtml(body)}
</main>
<footer><a href="${markdownPath(page)}">This page as Markdown</a> · <a href="/llms.txt">llms.txt</a></footer>
</body>
</html>
`;

  return text(html, "text/html; charset=utf-8", {
    Link: `<${markdownPath(page)}>; rel="alternate"; type="text/markdown"`,
  });
}

const NOT_FOUND_MARKDOWN = `# Page not found

There is nothing at this address on Xearch.

- Search posts: ${SITE_URL}/?q=your+words
- Agent and developer docs: ${SITE_URL}/docs.md
- Every page: ${SITE_URL}/llms.txt or ${SITE_URL}/sitemap.xml
`;

// Content-hashed bundle files (`index-B8aetLPT.js`) never change, so they
// can be cached for good; everything else revalidates. Mirrors
// @convex-dev/static-hosting's own rule.
function cacheControlFor(path: string): string {
  const match = path.match(/[-.]([\dA-Za-z_-]{6,32})\.[A-Za-z\d]+$/);
  const hashed = match !== null && /[\d_-]/.test(match[1]) && !path.endsWith(".html");

  return hashed ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate";
}

/** A deployed static file, or null when the deployment has none at `path`. */
async function staticAsset(
  ctx: ActionCtx,
  request: Request,
  path: string,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Promise<Response | null> {
  const asset = await ctx.runQuery(components.staticHosting.lib.resolveAssetForHttp, {
    path,
    spaFallback: false,
  });

  if (!asset) return null;
  const cacheControl = cacheControlFor(path);

  const headers = new Headers({
    "Content-Type": asset.contentType,
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });

  if (asset.etag) headers.set("ETag", asset.etag);

  if (asset.blobId && !asset.contentType.startsWith("text/html"))
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${new URL(request.url).origin}/fs/blobs/${asset.blobId}`,
        "Cache-Control": cacheControl,
      },
    });

  if (status === 200 && asset.etag) {
    const ifNoneMatch = request.headers.get("If-None-Match") ?? "";
    const normalize = (value: string) => value.trim().replace(/^W\//, "");

    if (ifNoneMatch.split(",").some((tag) => [asset.etag, "*"].includes(normalize(tag))))
      return new Response(null, { status: 304, headers });
  }

  let body: Blob | ReadableStream | null = null;

  if (asset.storageUrl) {
    const stored = await fetch(asset.storageUrl);

    if (!stored.ok || !stored.body) return null;
    body = stored.body;
  } else if (asset.appStorageId) {
    // @convex-dev/static-hosting's v1→v2 transitional path: the file still
    // lives in this app's own storage.
    body = await ctx.storage.get(asset.appStorageId);
  }

  if (!body) return null;

  return new Response(body, { status, headers });
}

// The public build maps the operator dashboard's addresses back to "/" in
// the browser (src/locationStore.ts `opsEntryPatch`), so they are real pages.
const APP_PATHS = /^\/ops(\/[a-z-]+)?\/?$/;

const serveSite = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  let path: string;

  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return new Response("Bad Request", { status: 400, headers: { "Content-Type": "text/plain" } });
  }

  const vary = { Vary: "Accept, User-Agent" };

  if (path === "/" || path === "/index.html") {
    if (prefersMarkdown(request) || url.searchParams.get("mode") === "agent")
      return text(pageMarkdown(HOME), MARKDOWN, { ...vary, Link: HOME_LINKS });

    return (
      (await staticAsset(ctx, request, "/index.html", 200, { ...vary, Link: HOME_LINKS })) ??
      new Response("Xearch is being deployed. Try again in a minute.", {
        status: 503,
        headers: { "Content-Type": "text/plain", "Retry-After": "30" },
      })
    );
  }

  if (APP_PATHS.test(path)) {
    const app = await staticAsset(ctx, request, "/index.html");

    if (app) return app;
  } else {
    const asset = await staticAsset(ctx, request, path);

    if (asset) return asset;
  }

  // A real 404. Agents get Markdown that points somewhere useful; browsers
  // get the app, which renders its own not-found page for unknown paths.
  if (!prefersMarkdown(request)) {
    const app = await staticAsset(ctx, request, "/index.html", 404, vary);

    if (app) return app;
  }

  return new Response(NOT_FOUND_MARKDOWN, {
    status: 404,
    headers: { "Content-Type": MARKDOWN, "Cache-Control": "no-store", ...vary },
  });
});

function getRoute(http: HttpRouter, path: string, respond: () => Response | Promise<Response>) {
  http.route({ path, method: "GET", handler: httpAction(async () => await respond()) });
}

export function registerAgentRoutes(http: HttpRouter): void {
  for (const page of PAGES) {
    getRoute(http, markdownPath(page), () => markdownPage(page));

    if (page.path !== "/")
      http.route({
        path: page.path,
        method: "GET",
        handler: httpAction(async (_ctx, request) =>
          prefersMarkdown(request) ? markdownPage(page) : htmlPage(page),
        ),
      });
  }

  getRoute(http, "/llms.txt", () => text(LLMS_TXT, "text/plain; charset=utf-8"));
  getRoute(http, "/llms-full.txt", () => text(llmsFullTxt(), "text/plain; charset=utf-8"));
  getRoute(http, "/docs/llms.txt", () => text(DOCS_LLMS_TXT, "text/plain; charset=utf-8"));
  getRoute(http, "/robots.txt", () => text(ROBOTS_TXT, "text/plain; charset=utf-8"));
  getRoute(http, "/sitemap.xml", () => text(sitemapXml(), "application/xml; charset=utf-8"));
  getRoute(http, "/schemamap.xml", () => text(SCHEMAMAP_XML, "application/xml; charset=utf-8"));
  getRoute(http, "/schema/pages.jsonl", () =>
    text(schemaFeedJsonl(), "application/jsonl; charset=utf-8"),
  );

  getRoute(http, "/.well-known/ard.json", () => json(AI_CATALOG));
  getRoute(http, "/.well-known/ai-catalog.json", () => json(AI_CATALOG));
  getRoute(http, "/.well-known/agent-skills/index.json", async () =>
    json(await agentSkillsIndex()),
  );
  getRoute(http, SKILL_PATH, () => text(SKILL_MD, MARKDOWN));
  getRoute(http, "/.well-known/api-catalog", () =>
    json(
      API_CATALOG,
      'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
    ),
  );
  getRoute(http, "/.well-known/mcp/server-card.json", () => json(SERVER_CARD));
  getRoute(http, "/.well-known/mcp.json", () =>
    json({
      servers: [
        { ...SERVER_CARD, card: `${SITE_URL}/mcp/server-card` },
        { ...DOCS_SERVER_CARD, card: `${SITE_URL}/docs/mcp/server-card` },
      ],
    }),
  );
  getRoute(http, "/mcp/server-card", () => json(SERVER_CARD));
  getRoute(http, "/docs/mcp/server-card", () => json(DOCS_SERVER_CARD));

  for (const [path, server] of [
    ["/mcp", PRODUCT_SERVER],
    ["/docs/mcp", DOCS_SERVER],
  ] as const) {
    http.route({
      path,
      method: "POST",
      handler: httpAction((ctx, request) => serveMcp(server, ctx, request)),
    });
    http.route({ path, method: "GET", handler: httpAction(async () => mcpGet()) });
    http.route({
      path,
      method: "OPTIONS",
      handler: httpAction(
        async () =>
          new Response(null, {
            status: 204,
            headers: { ...CORS_HEADERS, "Access-Control-Max-Age": "86400" },
          }),
      ),
    });
  }

  http.route({ pathPrefix: "/", method: "GET", handler: serveSite });
}
