import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  XmdClient,
  MAX_POSTS_PER_PAGE,
  readThrottle,
  resetAtFrom,
  ProviderError,
  type ProviderThrottle,
  type RawObject,
} from "../convex/lib/xmd";
import { collectXmd, splitHistoryPage, type CollectionRequest } from "../convex/lib/collect";
import { deliverCapture, type Capture } from "../convex/lib/handoff";

function requestUrl(input: Parameters<typeof fetch>[0]) {
  return input instanceof Request ? input.url : input.toString();
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
    const whole = new TextEncoder().encode(JSON.stringify(envelope)).byteLength;
    expect(whole).toBeGreaterThan(4_000_000);
    const { result, captures, bodies, ids } = await collectPage(envelope);
    // The profile preflight is its own capture; the history page follows.
    const history = captures.filter((capture) => capture.request.resource === "bulk");
    expect(history.length).toBeGreaterThan(1);
    // Every delivered body is under deliverCapture's hard 4 MB limit.
    for (const body of bodies)
      expect(new TextEncoder().encode(body).byteLength).toBeLessThan(4_000_000);
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
    for (const part of parts)
      expect(new TextEncoder().encode(JSON.stringify(part)).byteLength).toBeLessThanOrEqual(
        200_000,
      );
    expect(parts.flatMap((part) => part.posts as RawObject[])).toEqual(envelope.posts);
    // Nothing to split: a single record, and a non-array `posts` is untouched.
    expect(splitHistoryPage({ posts: "not-an-array" }, 1)).toEqual([{ posts: "not-an-array" }]);
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
async function throttleOf(response: () => Response, call?: (xmd: XmdClient) => Promise<unknown>) {
  const xmd = new XmdClient(
    "test-key",
    vi.fn<typeof fetch>(async () => response()),
  );
  const error = await (call ? call(xmd) : xmd.read("profile", "theo")).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ProviderError);
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
    expect("remaining" in (throttle as ProviderThrottle)).toBe(false);
    expect("resetAt" in (throttle as ProviderThrottle)).toBe(false);
  });
  it("records every reported policy and reports the most constraining one", () => {
    // Exactly the headers a live x.md response carried (unprefixed IETF spellings).
    const throttle = readThrottle(
      "xmd",
      "bulk",
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
    expect(throttle).toEqual({
      provider: "xmd",
      operation: "bulk",
      observedAt: NOW,
      remaining: 20,
      resetAt: NOW + 27_000,
      policies: [
        { name: "api-ip", quota: 600, windowSeconds: 60, remaining: 599, resetAt: NOW + 27_000 },
        { name: "import-key", quota: 20, windowSeconds: 900, remaining: 20, resetAt: NOW + 27_000 },
      ],
    });
  });
  it("leaves allowance absent — never 0 — when the response did not report it", async () => {
    const throttle = await throttleOf(() =>
      Response.json({ detail: "boom" }, { status: 503, headers: { "Retry-After": "5" } }),
    );
    expect(throttle?.retryAfterMs).toBe(5000);
    expect("remaining" in (throttle as ProviderThrottle)).toBe(false);
    expect("resetAt" in (throttle as ProviderThrottle)).toBe(false);
    expect("policies" in (throttle as ProviderThrottle)).toBe(false);
    expect(readThrottle("xmd", "profile", new Headers(), undefined, NOW)).toBeUndefined();
    expect(readThrottle("xmd", "profile", new Headers(), { unrelated: true }, NOW)).toBeUndefined();
  });
  it("reads a reset value as delta-seconds or as an absolute epoch", () => {
    const scalar = (value: string) =>
      readThrottle(
        "xmd",
        "search",
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
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ProviderError);
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
