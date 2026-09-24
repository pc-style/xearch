import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  XmdClient,
  MAX_POSTS_PER_PAGE,
  MAX_CHAIN_CONCURRENCY,
  HISTORY_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  timeoutFor,
  readThrottle,
  resetAtFrom,
  ProviderError,
  type ProviderThrottle,
  type RawObject,
} from "../convex/lib/xmd";
import { collectXmd, splitHistoryPage, type CollectionRequest } from "../convex/lib/collect";
import { CAPTURE_MAX_BYTES, deliverCapture, utf8Bytes, type Capture } from "../convex/lib/handoff";

function requestUrl(input: Parameters<typeof fetch>[0]) {
  return input instanceof Request ? input.url : input.toString();
}

/** Serialized size, measured independently of the code under test. */
function bytes(value: RawObject) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

const profile = { id: "123", screen_name: "theo", name: "Theo" };

const request: CollectionRequest = {
  runId: "run-1",
  attempt: 1,
  kind: "bulk",
  input: "theo",
};

// Fixed clock: `receivedAt` is part of the capture bytes, so a stable clock is
// what makes a replay byte-identical and therefore id-identical.
const NOW = 1_789_900_000_000;

// Sized from the real measurement of a live `max_posts=5000` page: 3,418,004
// bytes for 1,535 posts (~2,227 bytes/post). Retained captures on this machine
// range from ~2.1 KB to ~6.2 KB per post, so this sits inside the real range.
function post(index: number): RawObject {
  return {
    id: String(1_000_000 + index),
    text: `post ${index} ${"x".repeat(2000)}`,
    author: profile,
    media: { all: [{ type: "photo", variants: [1, 2] }] },
    unknown_future_field: ["keep", "all"],
  };
}

function page(count: number): RawObject {
  return {
    profile,
    posts: Array.from({ length: count }, (_, index) => post(index)),
    meta: { count, truncated: false, floor_reached: true, source: "fxtwitter" },
    future: { untouched: true },
  };
}

/** A receiver that behaves like the contract: content-addressed, durable acks. */
function receiver() {
  const bodies: string[] = [];
  const ids: string[] = [];

  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const body = String(init?.body);
    const id = new Headers(init?.headers).get("Idempotency-Key") ?? "";
    bodies.push(body);
    ids.push(id);
    // Prove the key really is the hash of these exact bytes.
    expect(id).toBe(createHash("sha256").update(body).digest("hex"));

    return Response.json({ captureId: id, durable: true, receiptId: `receipt-${ids.length}` });
  });

  return { bodies, ids, fetcher };
}

async function collectPage(envelope: RawObject) {
  const upstream = vi.fn<typeof fetch>(async (input) =>
    Response.json(requestUrl(input).includes("/posts?") ? envelope : { profile }),
  );

  const store = receiver();
  const captures: Capture[] = [];

  const result = await collectXmd(
    new XmdClient("test-key", upstream),
    request,
    async (capture) => {
      captures.push(structuredClone(capture));

      return deliverCapture(
        "https://data.example/captures",
        "capture-token",
        capture,
        store.fetcher,
      );
    },
    async () => {},
    () => NOW,
  );

  return { result, captures, upstream, ...store };
}

describe("x.md per-request capacity", () => {
  it("asks for the provider's documented 5000-post maximum, not the old 500 cap", async () => {
    const { upstream } = await collectPage(page(2));
    const url = new URL(requestUrl(upstream.mock.calls[1][0]));
    expect(MAX_POSTS_PER_PAGE).toBe(5000);
    expect(url.searchParams.get("max_posts")).toBe("5000");
    // Deliberately left at the value production has been running, not raised
    // to the documented default of 16: upstream already retried 48 of 62 pages
    // at 8 while still finishing a whole account in 11.5s.
    expect(url.searchParams.get("concurrency")).toBe("8");
  });
  it("clamps a caller to the documented ceiling and floor on both transports", async () => {
    const seen: string[] = [];

    const fetcher = vi.fn<typeof fetch>(async (input) => {
      seen.push(new URL(requestUrl(input)).searchParams.get("max_posts") ?? "");

      return Response.json({ meta: {} });
    });

    const xmd = new XmdClient("test-key", fetcher);
    await xmd.history("theo", { maxPosts: 99_999 });
    await xmd.history("theo", { maxPosts: 0 });

    for await (const _ of xmd.bulk("theo", { maxPosts: 99_999 })) {
      /* drain */
    }

    expect(seen).toEqual(["5000", "1", "5000"]);
  });
  it("splits a page too large for one capture into parts that each deliver", async () => {
    const envelope = page(2500);
    expect(bytes(envelope)).toBeGreaterThan(CAPTURE_MAX_BYTES);
    const { result, captures, bodies, ids } = await collectPage(envelope);
    // The profile preflight is its own capture; the history page follows.
    const history = captures.filter((capture) => capture.request.resource === "bulk");
    expect(history.length).toBeGreaterThan(1);

    // Every delivered body is under deliverCapture's hard ceiling.
    for (const body of bodies) expect(utf8Bytes(body)).toBeLessThan(CAPTURE_MAX_BYTES);
    expect(new Set(ids).size).toBe(ids.length);
    // Sequence numbering stays contiguous across the split.
    expect(captures.map((capture) => capture.sequence)).toEqual(captures.map((_, i) => i));
    expect(captures.map((capture) => capture.terminal)).toEqual([
      ...captures.slice(0, -1).map(() => "more"),
      "complete",
    ]);
    const parts = history.flatMap((capture) => capture.records);
    expect(parts.map((record) => record.part)).toEqual(
      parts.map((_, index) => ({ index, of: parts.length, totalPosts: 2500 })),
    );
    // The provider's page survives the split exactly: same posts, same order,
    // same envelope around every part.
    // SAFETY: every record here came from splitting `envelope`, built above by
    // this file's own `page()`/`post()` fixtures, which always populate
    // `posts` as an array of post objects.
    expect(parts.flatMap((record) => record.payload.posts as RawObject[])).toEqual(envelope.posts);

    for (const record of parts) {
      expect(record.payload.profile).toEqual(profile);
      expect(record.payload.meta).toEqual(envelope.meta);
      expect(record.payload.future).toEqual({ untouched: true });
    }

    expect(result.postsReceived).toBe(2500);
    expect(result.floorReached).toBe(true);
  });
  it("produces identical capture ids when the same page is replayed", async () => {
    const envelope = page(2500);
    const first = await collectPage(envelope);
    const second = await collectPage(envelope);
    expect(second.ids).toEqual(first.ids);
    expect(second.bodies).toEqual(first.bodies);
  });
  it("leaves a page that fits in one capture as a single unsplit record", async () => {
    const envelope = page(3);
    const { captures } = await collectPage(envelope);
    const history = captures.filter((capture) => capture.request.resource === "bulk");
    expect(history).toHaveLength(1);
    expect(history[0].records).toHaveLength(1);
    expect(history[0].records[0].payload).toEqual(envelope);
    expect(history[0].records[0].part).toBeUndefined();
  });
  it("keeps every part inside the byte budget it was given", () => {
    const envelope = page(400);
    const parts = splitHistoryPage(envelope, 200_000);
    expect(parts.length).toBeGreaterThan(4);

    for (const part of parts) {
      const serialized = bytes(part.payload);
      expect(serialized).toBeLessThanOrEqual(200_000);
      // The size handed out is the one the slicer sliced by: never smaller than
      // what the part really serializes to, so a caller that trusts it instead
      // of measuring again can never overfill a capture.
      expect(part.bytes).toBeGreaterThanOrEqual(serialized);
      expect(part.bytes).toBeLessThanOrEqual(200_000);
    }

    // SAFETY: every part here came from splitting `envelope`, built above by
    // this file's own `page()`/`post()` fixtures, which always populate
    // `posts` as an array of post objects.
    expect(parts.flatMap((part) => part.payload.posts as RawObject[])).toEqual(envelope.posts);
    // Nothing to split: a single record, and a non-array `posts` is untouched.
    expect(splitHistoryPage({ posts: "not-an-array" }, 1)).toEqual([
      { payload: { posts: "not-an-array" }, bytes: bytes({ posts: "not-an-array" }) },
    ]);
  });
  it("slices by measured bytes, not by a posts-per-part count", () => {
    // Posts of wildly different sizes: any count-based split would put the same
    // number of posts in each part, and the fat ones would blow the budget.
    const posts = Array.from({ length: 60 }, (_, index) => ({
      id: String(index),
      text: "x".repeat(200 + ((index * 1373) % 4000)),
    }));

    const parts = splitHistoryPage({ profile, posts, meta: { count: 60 } }, 12_000);
    expect(parts.length).toBeGreaterThan(1);
    // SAFETY: every part here came from splitting the object literal built two
    // lines above, whose `posts` field is the `posts` array constructed
    // immediately before it.
    const counts = parts.map((part) => (part.payload.posts as RawObject[]).length);
    // Byte-driven slicing gives parts different post counts.
    expect(new Set(counts).size).toBeGreaterThan(1);

    for (const part of parts) expect(bytes(part.payload)).toBeLessThanOrEqual(12_000);
    // SAFETY: same fixture as `counts` above — `posts` is always an array.
    expect(parts.flatMap((part) => part.payload.posts as RawObject[])).toEqual(posts);
  });
  it("sizes a whole page exactly, without serializing it a second time", () => {
    // The single measuring pass computes the page size from the posts it
    // already measured. That arithmetic must equal the real serialized size,
    // or the fits-in-one-capture decision would drift from the receiver's.
    const envelope = page(50);
    const [only] = splitHistoryPage(envelope, 10_000_000);
    expect(only.payload).toBe(envelope);
    expect(only.bytes).toBe(bytes(envelope));
  });
});

// The exact problem body a production run received from x.md, copied verbatim
// from the retained capture
// xearch-data/search/archive/907cfe8d4202ce12e6d5b9029bf436a02579226cf6770f2d0edc14db978b7140.json
// (that file wraps it as `{error: <this>, httpStatus: 429}`; this is the HTTP body itself).
const rateLimitedBody = {
  type: "https://x.pcstyle.dev/docs/reliability#rate-limited",
  title: "Rate limit exceeded",
  status: 429,
  detail: "Too many bulk imports for this API key: 20 per 15 minutes.",
  instance: "https://mdfromx.com/api/v1/profiles/mistralai/posts?format=json&max_posts=500",
  code: "rate_limited",
  resolution: "Wait the number of seconds in the `Retry-After` header, then retry.",
  documentation_url: "https://x.pcstyle.dev/docs/reliability#errors",
  error: "Too many bulk imports for this API key: 20 per 15 minutes.",
  retry_after: 423,
};

async function throttleOf<Result>(
  response: () => Response,
  call?: (xmd: XmdClient) => Promise<Result>,
) {
  const xmd = new XmdClient(
    "test-key",
    vi.fn<typeof fetch>(async () => response()),
  );

  const error = await (call ? call(xmd) : xmd.read("profile", "theo")).then(
    () => undefined,
    (cause: unknown) => cause,
  );

  expect(error).toBeInstanceOf(ProviderError);

  // SAFETY: the assertion immediately above proves `error` is a
  // `ProviderError`; every code path this helper exercises rejects with one.
  return (error as ProviderError).throttle;
}

describe("provider throttle facts", () => {
  it("reads Retry-After from the header of a 429", async () => {
    const throttle = await throttleOf(() =>
      Response.json(
        { code: "rate_limited", detail: "slow down" },
        { status: 429, headers: { "Retry-After": "90" } },
      ),
    );

    expect(throttle).toMatchObject({
      provider: "xmd",
      operation: "profile",
      reason: "slow down",
      retryAfterMs: 90_000,
    });
  });
  it("falls back to the body's retry_after when there is no header", async () => {
    const throttle = await throttleOf(
      () => Response.json(rateLimitedBody, { status: 429 }),
      (xmd) => xmd.history("mistralai", { maxPosts: MAX_POSTS_PER_PAGE }),
    );

    expect(throttle).toMatchObject({
      provider: "xmd",
      operation: "history",
      // Verbatim provider text, not reworded.
      reason: "Too many bulk imports for this API key: 20 per 15 minutes.",
      retryAfterMs: 423_000,
    });
    // SAFETY: the `toMatchObject` assertion above proves the request throttled,
    // so `throttleOf` (which only returns from a rejection) resolved with a
    // real throttle fact rather than `undefined`.
    expect("remaining" in (throttle as ProviderThrottle)).toBe(false);
    // SAFETY: same throttled response as the assertion immediately above.
    expect("resetAt" in (throttle as ProviderThrottle)).toBe(false);
  });
  it("reports the most constraining reported allowance", () => {
    // Exactly the headers a live x.md response carried (unprefixed IETF
    // spellings), on the 429 that makes them mean something.
    const throttle = readThrottle(
      "xmd",
      "bulk",
      429,
      new Headers({
        "ratelimit-policy": '"api-ip";q=600;w=60, "import-key";q=20;w=900',
        ratelimit: '"api-ip";r=599;t=27, "import-key";r=20;t=27',
        "ratelimit-limit": "20",
        "ratelimit-remaining": "20",
        "ratelimit-reset": "27",
      }),
      undefined,
      NOW,
    );

    // The tightest of the reported allowances, and nothing about the policies
    // themselves: their quota and window were never stored or shown anywhere.
    expect(throttle).toEqual({
      provider: "xmd",
      operation: "bulk",
      observedAt: NOW,
      remaining: 20,
      resetAt: NOW + 27_000,
    });
  });
  it("leaves allowance absent — never 0 — when the response did not report it", async () => {
    const throttle = await throttleOf(() =>
      Response.json({ detail: "boom" }, { status: 503, headers: { "Retry-After": "5" } }),
    );

    expect(throttle?.retryAfterMs).toBe(5000);
    // SAFETY: the assertion immediately above proves `retryAfterMs` was read
    // off a real throttle fact, so `throttle` is not `undefined` here.
    expect("remaining" in (throttle as ProviderThrottle)).toBe(false);
    // SAFETY: same throttled response as the assertion immediately above.
    expect("resetAt" in (throttle as ProviderThrottle)).toBe(false);
    // A 429 that carried no allowance at all is still a refusal, and still
    // reports nothing it was not told.
    expect(readThrottle("xmd", "profile", 429, new Headers(), undefined, NOW)).toEqual({
      provider: "xmd",
      operation: "profile",
      observedAt: NOW,
    });
  });
  it("reads a reset value as delta-seconds or as an absolute epoch", () => {
    const scalar = (value: string) =>
      readThrottle(
        "xmd",
        "search",
        429,
        new Headers({ "RateLimit-Remaining": "4", "RateLimit-Reset": value }),
        undefined,
        NOW,
      );

    // Small value: delta-seconds from now.
    expect(scalar("27")).toMatchObject({ remaining: 4, resetAt: NOW + 27_000 });
    // Large value: an absolute epoch, in seconds or already in milliseconds.
    expect(scalar(String(Math.floor(NOW / 1000) + 900))).toMatchObject({
      resetAt: NOW + 900_000,
    });
    expect(scalar(String(NOW + 900_000))).toMatchObject({ resetAt: NOW + 900_000 });
    expect(resetAtFrom("Thu, 01 Jan 2026 00:01:00 GMT")).toBe(Date.parse("2026-01-01T00:01:00Z"));
    expect(resetAtFrom(null)).toBeUndefined();
    expect(resetAtFrom("not-a-time")).toBeUndefined();
  });
  it("falls back to the X-RateLimit-* convention when that is what arrives", () => {
    expect(
      readThrottle(
        "search",
        "search",
        429,
        new Headers({ "X-RateLimit-Remaining": "7", "X-RateLimit-Reset": "60" }),
        undefined,
        NOW,
      ),
    ).toEqual({
      provider: "search",
      operation: "search",
      observedAt: NOW,
      remaining: 7,
      resetAt: NOW + 60_000,
    });
  });
  it("names the operation each x.md call was observed on", async () => {
    const throttled = () => Response.json(rateLimitedBody, { status: 429 });
    expect(
      (await throttleOf(throttled, (x) => x.read("post", "https://x.com/theo/status/1")))
        ?.operation,
    ).toBe("post");
    expect((await throttleOf(throttled, (x) => x.read("search", "convex")))?.operation).toBe(
      "search",
    );
    expect(
      (
        await throttleOf(throttled, async (x) => {
          for await (const _ of x.bulk("theo", { maxPosts: 10 })) {
            /* drain */
          }
        })
      )?.operation,
    ).toBe("bulk");
  });
  it("reports the capture receiver's own throttling as the receiver provider", async () => {
    const capture: Capture = {
      version: 1,
      runId: "run-1",
      attempt: 1,
      sequence: 0,
      source: "x-md",
      request: { origin: "https://mdfromx.com", resource: "bulk", input: "theo" },
      records: [{ receivedAt: NOW, payload: { post: { id: "1" } } }],
      terminal: "complete",
    };

    const error = await deliverCapture(
      "https://data.example/captures",
      "capture-token",
      capture,
      vi.fn<typeof fetch>(async () =>
        Response.json(
          { detail: "Ingest queue is full", retry_after: 12 },
          {
            status: 429,
            headers: { "RateLimit-Remaining": "0", "RateLimit-Reset": "45" },
          },
        ),
      ),
    ).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(ProviderError);
    // SAFETY: the assertion immediately above proves `error` is a
    // `ProviderError`; this deliverCapture rejects with one on every 429.
    const throttle = (error as ProviderError).throttle;
    expect(throttle).toMatchObject({
      provider: "receiver",
      operation: "capture-handoff",
      reason: "Ingest queue is full",
      // The provider really said zero here; that is a reported fact, not a default.
      remaining: 0,
      retryAfterMs: 12_000,
    });
    expect(throttle?.resetAt).toBeGreaterThan(Date.now() + 44_000);
  });
});

// x.md returns these on EVERY response — successes, 404s, 500s alike — so they
// state a standing allowance and never that this call was refused over one.
const ALLOWANCE_HEADERS = {
  "RateLimit-Policy": '"api-ip";q=600;w=60, "import-key";q=20;w=900',
  RateLimit: '"api-ip";r=598;t=41, "import-key";r=19;t=873',
  "RateLimit-Limit": "20",
  "RateLimit-Remaining": "19",
  "RateLimit-Reset": "41",
};

describe("only a refusal caused by a limit counts as throttling", () => {
  it("does not call a 404 profile-not-found throttling, allowance headers and all", async () => {
    // The bug: one bad handle wrote a providerThrottleEvents row, and the
    // dashboard then reported x.md as throttled indefinitely.
    expect(
      await throttleOf(() =>
        Response.json(
          { error: { message: "Profile not found" } },
          { status: 404, headers: ALLOWANCE_HEADERS },
        ),
      ),
    ).toBeUndefined();
  });
  it("does not call a rejected API key throttling", async () => {
    expect(
      await throttleOf(() =>
        Response.json(
          { code: "unauthorized", detail: "Invalid API key." },
          { status: 401, headers: ALLOWANCE_HEADERS },
        ),
      ),
    ).toBeUndefined();
  });
  it("does not call a provider fault throttling", async () => {
    expect(
      await throttleOf(() =>
        Response.json(
          { code: "internal_error", detail: "Unexpected failure." },
          { status: 500, headers: ALLOWANCE_HEADERS },
        ),
      ),
    ).toBeUndefined();
  });
  it("does not call a 503 without a retry signal throttling", async () => {
    expect(
      await throttleOf(() =>
        Response.json(
          { code: "upstream_unavailable", detail: "Upstream is down." },
          { status: 503, headers: ALLOWANCE_HEADERS },
        ),
      ),
    ).toBeUndefined();
  });
  it("never reads throttling off a response the provider fulfilled", () => {
    expect(
      readThrottle("xmd", "history", 200, new Headers(ALLOWANCE_HEADERS), { posts: [] }, NOW),
    ).toBeUndefined();
  });
  it("reports a 429 as throttling on the status alone", async () => {
    const throttle = await throttleOf(() =>
      Response.json({ detail: "Slow down." }, { status: 429, headers: ALLOWANCE_HEADERS }),
    );

    // Qualified by the status; the allowance headers only enrich it.
    expect(throttle).toMatchObject({ provider: "xmd", reason: "Slow down.", remaining: 19 });
  });
  it("reports a 503 that carries a Retry-After as throttling", async () => {
    // x.md documents `503 upstream_rate_limited` with `Retry-After`.
    const throttle = await throttleOf(() =>
      Response.json(
        { code: "upstream_rate_limited", detail: "Upstream is rate limiting us." },
        { status: 503, headers: { ...ALLOWANCE_HEADERS, "Retry-After": "30" } },
      ),
    );

    expect(throttle).toMatchObject({
      reason: "Upstream is rate limiting us.",
      retryAfterMs: 30_000,
    });
  });
  it("reports a rate_limited problem body as throttling whatever the status says", async () => {
    // Production's own `code` and `type`, on a status that would not qualify.
    const throttle = await throttleOf(() =>
      Response.json({ ...rateLimitedBody, status: 500 }, { status: 500 }),
    );

    expect(throttle).toMatchObject({
      reason: "Too many bulk imports for this API key: 20 per 15 minutes.",
      retryAfterMs: 423_000,
    });
    expect(
      readThrottle(
        "xmd",
        "history",
        400,
        new Headers(),
        { type: "https://x.pcstyle.dev/docs/reliability#rate-limited" },
        NOW,
      ),
    ).toEqual({ provider: "xmd", operation: "history", observedAt: NOW });
  });
  it("gives a Retry-After header and a retry_after body field the same meaning", async () => {
    const header = await throttleOf(() =>
      Response.json({ code: "rate_limited" }, { status: 429, headers: { "Retry-After": "423" } }),
    );

    const body = await throttleOf(() =>
      Response.json({ code: "rate_limited", retry_after: 423 }, { status: 429 }),
    );

    expect(header?.retryAfterMs).toBe(body?.retryAfterMs);
  });
});

// x.md's cost for a continuation page is in walking the timeline back to
// `until`, not the page size: the huggingface page at 2026-01-26 timed out
// identically at every size from 5000 down to 500. The abort used to escape
// as a plain TimeoutError and every retry asked again after two minutes.
describe("a history page the provider is slow to deliver", () => {
  const timeout = () =>
    new DOMException("The operation was aborted due to timeout", "TimeoutError");

  it("is reported as a retryable provider timeout, not a generic interruption", async () => {
    const xmd = new XmdClient("test-key", async () => {
      throw timeout();
    });

    const failure = await xmd.history("theo", { maxPosts: 5000 }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(ProviderError);

    // SAFETY: the assertion immediately above proves `failure` is a
    // `ProviderError`; every code path this test exercises rejects with one.
    const providerFailure = failure as ProviderError;

    expect(providerFailure.code).toBe("provider_timeout");
    expect(providerFailure.retryable).toBe(true);
    expect(providerFailure.message).toContain("900 seconds");
  });
  it("gives history and bulk requests the long timeout and everything else the short one", () => {
    expect(timeoutFor("history")).toBe(HISTORY_TIMEOUT_MS);
    expect(timeoutFor("bulk")).toBe(HISTORY_TIMEOUT_MS);
    expect(timeoutFor("profile")).toBe(REQUEST_TIMEOUT_MS);
    expect(HISTORY_TIMEOUT_MS).toBeGreaterThan(REQUEST_TIMEOUT_MS);
  });
  it("asks x.md once more with its maximum chain concurrency when x.md ran out of time", async () => {
    const asked: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(requestUrl(input));
      if (!url.pathname.endsWith("/posts")) return Response.json({ profile });
      asked.push(url.searchParams.get("concurrency") ?? "");
      if (asked.length === 1) return new Response("gateway timeout", { status: 504 });
      return Response.json(page(3));
    });
    const store = receiver();
    const phases: string[] = [];
    const result = await collectXmd(
      new XmdClient("test-key", fetcher),
      request,
      (capture) =>
        deliverCapture("https://data.example/captures", "capture-token", capture, store.fetcher),
      async () => {},
      () => NOW,
      undefined,
      async (phase) => {
        phases.push(phase);
      },
    );
    expect(asked).toEqual(["8", String(MAX_CHAIN_CONCURRENCY)]);
    expect(result.postsReceived).toBe(3);
    expect(phases).toContain(
      `x.md ran out of time; asking again with ${MAX_CHAIN_CONCURRENCY} chains`,
    );
  });
  it("does not keep asking after the second try also ran out of time", async () => {
    const asked: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(requestUrl(input));
      if (!url.pathname.endsWith("/posts")) return Response.json({ profile });
      asked.push(url.searchParams.get("concurrency") ?? "");
      return new Response("gateway timeout", { status: 504 });
    });
    const store = receiver();
    const failure = await collectXmd(
      new XmdClient("test-key", fetcher),
      request,
      (capture) =>
        deliverCapture("https://data.example/captures", "capture-token", capture, store.fetcher),
      async () => {},
      () => NOW,
    ).catch((error: unknown) => error);
    expect((failure as ProviderError).code).toBe("http_504");
    expect((failure as ProviderError).retryable).toBe(true);
    expect(asked).toEqual(["8", String(MAX_CHAIN_CONCURRENCY)]);
  });
  it("asks for the same full page again on the next attempt rather than a smaller one", async () => {
    const asked: string[] = [];

    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(requestUrl(input));

      if (!url.pathname.endsWith("/posts")) return Response.json({ profile });
      asked.push(url.searchParams.get("max_posts") ?? "");
      throw timeout();
    });

    const store = receiver();

    const failure = await collectXmd(
      new XmdClient("test-key", fetcher),
      request,
      (capture) =>
        deliverCapture("https://data.example/captures", "capture-token", capture, store.fetcher),
      async () => {},
      () => NOW,
    ).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(ProviderError);

    // SAFETY: the assertion immediately above proves `failure` is a
    // `ProviderError`; every code path this test exercises rejects with one.
    expect((failure as ProviderError).code).toBe("provider_timeout");
    // The second ask (more chains) still wants the full page.
    expect(asked).toEqual(["5000", "5000"]);
  });
});
