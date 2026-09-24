import { z } from "zod";

const object = z.record(z.string(), z.unknown());

export type RawObject = Record<string, unknown>;

/**
 * Services this app calls that can throttle it. Mirrors
 * `throttleProviderValidator` in convex/schema.ts, restated as a plain literal
 * union so this provider-client layer never imports Convex.
 */
export type ThrottleProvider = "xmd" | "receiver" | "search";

/**
 * What a provider told us about its own limits, as facts. Every optional field
 * is present ONLY when the response genuinely carried it: an absent value stays
 * absent and is never estimated, defaulted, or filled in with a guess. Consumed
 * by convex/importer.ts to write a `providerThrottleEvents` row.
 */
export type ProviderThrottle = {
  provider: ThrottleProvider;
  /** The call it was observed on, e.g. "history", "bulk", "capture-handoff". */
  operation: string;
  /** When this app observed the response. */
  observedAt: number;
  /** The provider's own message/detail text, verbatim — never reworded. */
  reason?: string;
  /** Remaining allowance of the most constraining reported policy. */
  remaining?: number;
  /** Epoch ms that allowance window resets. */
  resetAt?: number;
  /** From `Retry-After`, else the problem body's `retry_after` seconds. */
  retryAfterMs?: number;
};

export class ProviderError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryAfter = 0,
    public retryable = false,
    public raw?: RawObject,
    /** Provider-reported limit facts, when the response carried any. */
    public throttle?: ProviderThrottle,
  ) {
    super(message);
  }
}

export function record(value: unknown): RawObject {
  return object.parse(value);
}

export function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function handle(value: string): string {
  const result = value.trim().replace(/^@/, "");

  if (!/^[A-Za-z0-9_]{1,15}$/.test(result))
    throw new Error("Enter a valid X handle, without a URL.");

  return result.toLowerCase();
}

export function publicUrl(value: string): string {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();

  // Provider-side fetching still enforces its own DNS/private-network protection.
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    host === "localhost" ||
    !host.includes(".") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.includes(":") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host)
  )
    throw new Error("Use a public HTTPS website URL.");
  url.hash = "";

  return url.toString();
}

export function statusUrl(value: string): string {
  const url = new URL(publicUrl(value));

  if (
    !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname) ||
    !/^\/[A-Za-z0-9_]{1,15}\/status\/\d+$/.test(url.pathname)
  )
    throw new Error("Paste an X post link, including /status/ and its ID.");

  return `https://x.com${url.pathname}`;
}

export function retryDelay(value: string | null, now = Date.now()): number {
  if (!value) return 30_000;
  const seconds = Number(value);

  return Math.min(
    86_400_000,
    Math.max(1000, Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now || 30_000),
  );
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;

  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : undefined;
}

const unquote = (value: string) => value.replace(/^"([\s\S]*)"$/, "$1");

/**
 * Epoch ms for a `RateLimit-Reset`-style value. The IETF field means
 * delta-seconds, but plenty of services send an absolute epoch instead, so
 * disambiguate by magnitude: under 1e9 is a delta (1e9 seconds is ~31 years),
 * 1e9..1e12 is epoch seconds, larger is already epoch ms. An HTTP date works too.
 */
export function resetAtFrom(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (value === undefined || value === null || value.trim() === "") return undefined;
  const seconds = finiteNumber(value);

  if (seconds === undefined) {
    const parsed = Date.parse(value);

    return Number.isFinite(parsed) ? parsed : undefined;
  }

  if (seconds < 0) return undefined;

  if (seconds < 1e9) return Math.round(now + seconds * 1000);

  if (seconds < 1e12) return Math.round(seconds * 1000);

  return Math.round(seconds);
}

type StructuredItem = { name?: string; params: Record<string, string> };

/** `"api-ip";q=600;w=60, "import-key";q=20;w=900` -> one item per policy. */
function structuredList(value: string | null): StructuredItem[] {
  if (!value) return [];
  const items: StructuredItem[] = [];

  for (const entry of value.split(",")) {
    const segments = entry
      .split(";")
      .map((segment) => segment.trim())
      .filter((segment) => segment !== "");

    if (!segments.length) continue;
    const item: StructuredItem = { params: {} };

    for (const segment of segments) {
      const equals = segment.indexOf("=");

      if (equals === -1) {
        if (item.name === undefined) item.name = unquote(segment);
        continue;
      }

      item.params[segment.slice(0, equals).trim().toLowerCase()] = unquote(
        segment.slice(equals + 1).trim(),
      );
    }

    items.push(item);
  }

  return items;
}

// x.md emits the unprefixed IETF spellings (verified against live response
// headers); `X-RateLimit-*` is the widespread older convention and is read only
// as a fallback.
function headerValue(headers: Headers, name: string): string | null {
  return headers.get(name) ?? headers.get(`X-${name}`);
}

/** One reported allowance: what is left, and when it comes back. */
type Allowance = { remaining?: number; resetAt?: number };

/**
 * Every allowance the response reported, as candidates. x.md applies several
 * policies at once (an `api-ip` one and an `import-key` one in the same
 * `RateLimit` header), and some services send the older scalar
 * `RateLimit-Remaining`/`-Reset` pair instead; the scalar is simply one more
 * candidate rather than a second reconciliation pass over the list. Only `r=`
 * and `t=` are read: the quota and window from `RateLimit-Policy` were never
 * stored or shown anywhere.
 */
function allowances(headers: Headers, now: number): Allowance[] {
  const candidates = structuredList(headerValue(headers, "RateLimit")).map((item) => ({
    remaining: finiteNumber(item.params.r ?? item.params.remaining),
    resetAt: resetAtFrom(item.params.t ?? item.params.reset, now),
  }));

  candidates.push({
    remaining: finiteNumber(headerValue(headers, "RateLimit-Remaining")),
    resetAt: resetAtFrom(headerValue(headers, "RateLimit-Reset"), now),
  });

  return candidates;
}

/** RFC 9457-style problem body, whether it is the body or nested under `error`. */
function problemBody(body: unknown): RawObject | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const top = body as RawObject;
  const nested = top.error;

  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? (nested as RawObject)
    : top;
}

function problemReason(problem: RawObject | undefined): string | undefined {
  if (!problem) return undefined;

  for (const key of ["detail", "message", "title", "error"]) {
    const value = string(problem[key]);

    if (value && value.trim() !== "") return value;
  }

  return undefined;
}

function retryAfterFromHeader(value: string | null, now: number): number | undefined {
  if (value === null || value.trim() === "") return undefined;

  // Only accept what `retryDelay` can genuinely read; its 30s fallback for
  // unparseable input is a default, not something the provider told us.
  return Number.isFinite(Number(value)) || Number.isFinite(Date.parse(value))
    ? retryDelay(value, now)
    : undefined;
}

function retryAfterFromBody(problem: RawObject | undefined, now: number): number | undefined {
  const seconds = finiteNumber(problem?.retry_after ?? problem?.retryAfter);

  // Delegate the clamp to `retryDelay`, exactly as the header path does, so the
  // same number of seconds can never mean two different delays.
  return seconds === undefined || seconds < 0 ? undefined : retryDelay(String(seconds), now);
}

/** `rate_limited`, `upstream_rate_limited`, `.../reliability#rate-limited`. */
const namesRateLimit = (problem: RawObject | undefined) =>
  ["code", "type"].some((key) =>
    /ratelimit|toomanyrequests/.test(
      (string(problem?.[key]) ?? "").toLowerCase().replace(/[^a-z]/g, ""),
    ),
  );

/**
 * Read provider-reported limit facts off a refused response (and its
 * already-decoded body, when there is one). Returns undefined unless the
 * provider refused *because of a limit*.
 *
 * The allowance headers cannot be that signal: x.md sends `RateLimit-Policy`,
 * `RateLimit` and `RateLimit-Remaining` on EVERY response, successes and
 * ordinary errors alike, so their presence only states a standing allowance.
 * Treating them as the qualifier turned the first bad handle — a 404 "Profile
 * not found" — into a throttle event the dashboard then reported forever.
 * A refusal caused by a limit says so in one of exactly three ways:
 *   - HTTP 429, the status that means precisely this;
 *   - a usable `Retry-After`, the provider deliberately deferring this call
 *     (x.md documents `503 upstream_rate_limited` that way; a 503 without one
 *     is an outage, not a limit);
 *   - a problem-body `code`/`type` naming a rate limit (production sends
 *     `"code":"rate_limited"`, `"type":".../reliability#rate-limited"`).
 * Remaining, reset and retry-after are then enrichment on a fact that already
 * qualified, never the thing that qualifies it.
 */
export function readThrottle(
  provider: ThrottleProvider,
  operation: string,
  status: number,
  headers: Headers,
  body?: unknown,
  now = Date.now(),
): ProviderThrottle | undefined {
  const problem = problemBody(body);
  const deferredMs = retryAfterFromHeader(headers.get("Retry-After"), now);

  // A fulfilled response is not a refusal at all.
  if (status < 400) return undefined;

  if (status !== 429 && deferredMs === undefined && !namesRateLimit(problem)) return undefined;
  // Several allowances can apply to one call (x.md: per-IP and per-API-key).
  // The most constraining one is what actually gates the next request.
  const candidates = allowances(headers, now);
  let tightest: Allowance | undefined;

  for (const candidate of candidates)
    if (
      candidate.remaining !== undefined &&
      (tightest?.remaining === undefined || candidate.remaining < tightest.remaining)
    )
      tightest = candidate;

  return compact({
    provider,
    operation,
    observedAt: now,
    reason: problemReason(problem),
    remaining: tightest?.remaining,
    resetAt: tightest?.resetAt ?? candidates.find(({ resetAt }) => resetAt !== undefined)?.resetAt,
    retryAfterMs: deferredMs ?? retryAfterFromBody(problem, now),
  });
}

/**
 * x.md's documented per-request ceiling for `max_posts`
 * (https://mdfromx.com/docs/bulk-import): "Maximum 5000; meta.truncated=true
 * when exceeded". This app used to clamp to 500, which was ours, not the
 * provider's: it made every account import fetch 500 posts at a time and spend
 * ten requests where one would do — against an allowance the provider's own
 * live headers put at 20 imports per 15 minutes per API key. A single
 * `max_posts=5000` request was verified accepted (HTTP 200, 1,535 posts,
 * `floor_reached`, 11.5s). This is a ceiling the provider documents, not a
 * budget of ours; nothing here paces or caps our own requests.
 */
export const MAX_POSTS_PER_PAGE = 5000;

/**
 * Parallel upstream chains per request. The provider documents a default of 16
 * and a maximum of 32, but a real `max_posts=5000` run at 8 already reported
 * `retried_pages: 48` out of `pages: 62` — upstream is pushing back well before
 * our fan-out is the bottleneck, and it still finished the whole account in
 * 11.5s. The binding constraint is requests per key per window, not wall clock
 * inside one request, so raising this would buy latency we do not need in
 * exchange for more upstream retries. Left at the value in production use.
 */
const CHAIN_CONCURRENCY = "8";
/**
 * The provider's documented maximum. Used only as a second try after x.md
 * itself gave up on a page (its gateway answers 504 at about two minutes):
 * the huggingface and lauren_tan pages died there at every page size, and
 * more parallel chains is the one lever left that shortens x.md's own work.
 */
export const MAX_CHAIN_CONCURRENCY = 32;
/** How long an ordinary x.md request may take before it is reported as `provider_timeout`. */
export const REQUEST_TIMEOUT_MS = 120_000;
/**
 * History pages get far longer. x.md's cost for a continuation page is in
 * walking the timeline back to `until`, not in the page size: in production
 * the huggingface page at 2026-01-26 timed out identically at 5000, 2500,
 * 1250, 625 and 500 posts. Aborting at two minutes threw away work x.md was
 * still doing and asked for it again. Fifteen minutes is inside the window a
 * job stays alive while its worker keeps reporting progress (convex/jobs.ts
 * `expire`).
 */
export const HISTORY_TIMEOUT_MS = 900_000;
/** The request timeout for one x.md call, by the operation it is reported under. */
export function timeoutFor(operation: string): number {
  return operation === "history" || operation === "bulk" ? HISTORY_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
}
export class XmdClient {
  readonly origin: string;
  constructor(
    private key?: string,
    private fetcher: typeof fetch = fetch,
    origin = "https://mdfromx.com",
  ) {
    const url = new URL(origin);

    if (
      !["https://mdfromx.com", "https://x.pcstyle.dev"].includes(url.origin) ||
      url.username ||
      url.password ||
      (url.pathname !== "/" && url.pathname !== "")
    )
      throw new Error("X_MD_BASE_URL must be https://mdfromx.com or https://x.pcstyle.dev.");
    this.origin = url.origin;
  }
  private async request(
    path: string,
    query: Record<string, string>,
    /** The call name a throttle observation is reported under. */
    operation: string,
    signal?: AbortSignal,
  ) {
    const url = new URL(path, this.origin);

    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        headers: {
          Accept: query.format === "ndjson" ? "application/x-ndjson" : "application/json",
          ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}),
        },
        signal: signal ?? AbortSignal.timeout(timeoutFor(operation)),
        redirect: "error",
      });
    } catch (error) {
      // An elapsed AbortSignal.timeout surfaces as a DOMException named
      // "TimeoutError" — a plain Error, so it used to reach the worker as
      // "Download interrupted" with no trace of the cause. In production the
      // huggingface import failed seven times this way: x.md needs more than
      // the timeout to assemble a 5000-post page for a media-heavy account,
      // and every retry asked for the same page. Naming it lets the collector
      // ask for a smaller page and the dashboard say what actually happened.
      if (error instanceof Error && error.name === "TimeoutError")
        throw new ProviderError(
          "provider_timeout",
          `x.md did not answer within ${timeoutFor(operation) / 1000} seconds (${operation}).`,
          30_000,
          true,
        );
      throw error;
    }
    if (!response.ok) {
      let code = `http_${response.status}`;
      let problem: RawObject | undefined;

      try {
        problem = record(await response.json());
        code = string(problem.code) ?? code;
      } catch {
        /* status is still actionable */
      }

      const message =
        response.status === 401
          ? "x.md rejected the API key. Check X_MD_API_KEY on the backend."
          : response.status === 429
            ? "x.md rate limit reached. The job will retry after the provider's delay."
            : `x.md could not finish this request (${response.status}, ${code}).`;

      throw new ProviderError(
        code,
        message,
        retryDelay(response.headers.get("Retry-After")),
        [408, 429, 500, 502, 503, 504].includes(response.status),
        problem ? { error: problem, httpStatus: response.status } : undefined,
        readThrottle("xmd", operation, response.status, response.headers, problem),
      );
    }

    return response;
  }
  async read(
    kind: "profile" | "search" | "post" | "following" | "followers" | "archive",
    input: string,
    cursor?: string,
  ) {
    const query: Record<string, string> = { format: "json", limit: "50" };

    if (cursor) query.cursor = cursor;
    let path: string;

    if (kind === "search") {
      path = "/api/v1/search";
      query.q = input;
      query.feed = "latest";
    } else if (kind === "post") {
      path = "/api/v1/posts";
      query.url = statusUrl(input);
      query.thread = "auto";
    } else {
      path = `/api/v1/profiles/${handle(input)}${kind === "profile" ? "" : kind === "archive" ? "/posts" : `/${kind}`}`;

      if (kind === "archive") query.index = "true";
    }

    return record(await (await this.request(path, query, kind)).json());
  }
  async history(
    input: string,
    options: {
      since?: string;
      until?: string;
      maxPosts: number;
      refresh?: boolean;
      /** Parallel upstream chains; defaults to CHAIN_CONCURRENCY, capped at the provider's maximum. */
      concurrency?: number;
    },
  ): Promise<RawObject> {
    const query: Record<string, string> = {
      format: "json",
      max_posts: String(Math.min(MAX_POSTS_PER_PAGE, Math.max(1, options.maxPosts))),
      with_replies: "true",
      with_reposts: "true",
      concurrency:
        options.concurrency === undefined
          ? CHAIN_CONCURRENCY
          : String(Math.min(MAX_CHAIN_CONCURRENCY, Math.max(1, Math.floor(options.concurrency)))),
    };

    if (options.since) query.since = options.since;

    if (options.until) query.until = options.until;

    if (options.refresh) query.refresh = "true";

    return record(
      await (
        await this.request(`/api/v1/profiles/${handle(input)}/posts`, query, "history")
      ).json(),
    );
  }
  async *bulk(
    input: string,
    options: {
      since?: string;
      until?: string;
      maxPosts: number;
      refresh?: boolean;
    },
  ): AsyncGenerator<RawObject & ({ post: RawObject } | { meta: RawObject; profile?: RawObject })> {
    const query: Record<string, string> = {
      format: "ndjson",
      max_posts: String(Math.min(MAX_POSTS_PER_PAGE, Math.max(1, options.maxPosts))),
      with_replies: "true",
      with_reposts: "true",
      concurrency: CHAIN_CONCURRENCY,
    };

    if (options.since) query.since = options.since;

    if (options.until) query.until = options.until;

    if (options.refresh) query.refresh = "true";
    const response = await this.request(`/api/v1/profiles/${handle(input)}/posts`, query, "bulk");

    if (!response.body) throw new ProviderError("empty_stream", "x.md returned no import stream.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let pending = "",
      terminal = false,
      count = 0;

    const parse = (line: string) => {
      const item = record(JSON.parse(line));

      if (item.error)
        throw new ProviderError(
          "partial_import",
          "x.md stopped before completing the import. Only acknowledged captures are retained; retry to continue.",
          0,
          false,
          item,
        );

      if (item.post) return { ...item, post: record(item.post) };

      if (item.meta)
        return {
          ...item,
          meta: record(item.meta),
          ...(item.profile ? { profile: record(item.profile) } : {}),
        };
      throw new ProviderError("invalid_stream", "x.md returned an unrecognized import record.");
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        pending += decoder.decode(value, { stream: !done });

        if (pending.length > 2_000_000)
          throw new ProviderError(
            "oversized_record",
            "An x.md import record exceeded the size limit.",
          );
        const lines = pending.split("\n");
        pending = lines.pop()!;

        if (done && pending.trim()) {
          lines.push(pending);
          pending = "";
        }

        for (const line of lines) {
          if (!line.trim()) continue;

          if (terminal)
            throw new ProviderError(
              "invalid_stream",
              "x.md sent records after the import summary.",
            );
          const item = parse(line);

          if ("meta" in item) terminal = true;
          else if (++count > options.maxPosts)
            throw new ProviderError(
              "import_limit",
              "The provider exceeded the requested import size. Collected sources were kept.",
            );
          yield item;
        }

        if (done) break;
      }

      if (!terminal)
        throw new ProviderError(
          "incomplete_stream",
          "The connection closed without an import summary. Collected sources were kept; retry to continue.",
        );
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
