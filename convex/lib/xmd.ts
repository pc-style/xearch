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
 * One rate-limit policy exactly as the provider reported it. x.md applies
 * several at once (an `api-ip` one and an `import-key` one in the same
 * `RateLimit`/`RateLimit-Policy` headers), so the headline figures below are
 * accompanied by every policy observed rather than only the tightest.
 */
export type ProviderThrottlePolicy = {
  /** Policy name, e.g. `api-ip` or `import-key`, when the provider named it. */
  name?: string;
  /** Requests left in this policy's window (`r=`), when reported. */
  remaining?: number;
  /** The policy's quota (`q=`), when reported. */
  quota?: number;
  /** The policy's window length in seconds (`w=`), when reported. */
  windowSeconds?: number;
  /** Epoch ms this policy's window resets (`t=`), when reported. */
  resetAt?: number;
};
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
  /** Every policy the response reported, when it reported any. */
  policies?: ProviderThrottlePolicy[];
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
function throttlePolicies(headers: Headers, now: number): ProviderThrottlePolicy[] {
  const byKey = new Map<string, ProviderThrottlePolicy>();
  const merge = (key: string, patch: ProviderThrottlePolicy) => {
    const current = byKey.get(key) ?? {};
    byKey.set(key, {
      name: patch.name ?? current.name,
      remaining: patch.remaining ?? current.remaining,
      quota: patch.quota ?? current.quota,
      windowSeconds: patch.windowSeconds ?? current.windowSeconds,
      resetAt: patch.resetAt ?? current.resetAt,
    });
  };
  structuredList(headerValue(headers, "RateLimit-Policy")).forEach((item, index) =>
    merge(item.name ?? `#${index}`, {
      name: item.name,
      quota: finiteNumber(item.params.q ?? item.params.limit),
      windowSeconds: finiteNumber(item.params.w ?? item.params.window),
    }),
  );
  structuredList(headerValue(headers, "RateLimit")).forEach((item, index) =>
    merge(item.name ?? `#${index}`, {
      name: item.name,
      remaining: finiteNumber(item.params.r ?? item.params.remaining),
      resetAt: resetAtFrom(item.params.t ?? item.params.reset, now),
      quota: finiteNumber(item.params.limit),
    }),
  );
  return [...byKey.values()]
    .map((policy) => compact(policy))
    .filter(
      (policy) =>
        policy.remaining !== undefined ||
        policy.resetAt !== undefined ||
        policy.quota !== undefined,
    );
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
function retryAfterFromBody(problem: RawObject | undefined): number | undefined {
  const seconds = finiteNumber(problem?.retry_after ?? problem?.retryAfter);
  if (seconds === undefined || seconds < 0) return undefined;
  return Math.min(86_400_000, Math.max(1000, seconds * 1000));
}
/**
 * Read provider-reported limit facts off a response (and its already-decoded
 * body, when there is one). Returns undefined when the response said nothing
 * about limits — that is an absence of information, not "not throttled".
 */
export function readThrottle(
  provider: ThrottleProvider,
  operation: string,
  headers: Headers,
  body?: unknown,
  now = Date.now(),
): ProviderThrottle | undefined {
  const policies = throttlePolicies(headers, now);
  const scalarRemaining = finiteNumber(headerValue(headers, "RateLimit-Remaining"));
  const scalarReset = resetAtFrom(headerValue(headers, "RateLimit-Reset"), now);
  // Two policies can apply to one call (x.md: per-IP and per-API-key). The
  // most constraining one is what actually gates the next request.
  let tightest: ProviderThrottlePolicy | undefined;
  for (const policy of policies)
    if (
      policy.remaining !== undefined &&
      (tightest?.remaining === undefined || policy.remaining < tightest.remaining)
    )
      tightest = policy;
  let remaining = tightest?.remaining;
  let resetAt = tightest?.resetAt ?? scalarReset;
  if (scalarRemaining !== undefined && (remaining === undefined || scalarRemaining < remaining)) {
    remaining = scalarRemaining;
    resetAt = scalarReset ?? resetAt;
  }
  const problem = problemBody(body);
  const reason = problemReason(problem);
  const retryAfterMs =
    retryAfterFromHeader(headers.get("Retry-After"), now) ?? retryAfterFromBody(problem);
  if (
    reason === undefined &&
    remaining === undefined &&
    resetAt === undefined &&
    retryAfterMs === undefined &&
    policies.length === 0
  )
    return undefined;
  return compact({
    provider,
    operation,
    observedAt: now,
    reason,
    remaining,
    resetAt,
    retryAfterMs,
    policies: policies.length ? policies : undefined,
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
    const response = await this.fetcher(url, {
      headers: {
        Accept: query.format === "ndjson" ? "application/x-ndjson" : "application/json",
        ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}),
      },
      signal: signal ?? AbortSignal.timeout(120_000),
      redirect: "error",
    });
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
        readThrottle("xmd", operation, response.headers, problem),
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
    },
  ): Promise<RawObject> {
    const query: Record<string, string> = {
      format: "json",
      max_posts: String(Math.min(MAX_POSTS_PER_PAGE, Math.max(1, options.maxPosts))),
      with_replies: "true",
      with_reposts: "true",
      concurrency: CHAIN_CONCURRENCY,
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
