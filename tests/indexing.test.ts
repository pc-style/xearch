import { describe, it, expect, vi } from "vitest";
import { XmdClient, retryDelay, publicUrl, type RawObject } from "../convex/lib/xmd";
import { collectXmd, type CollectionRequest } from "../convex/lib/collect";
import { deliverCapture, captureId, type Capture, type Receipt } from "../convex/lib/handoff";
// Sanitized reproduction of a real x.md /api/v1/profiles/{handle}/posts response
// for a request carrying `until` (a continuation page): structure and field
// names are preserved from an actual retained capture; handle, timestamps, and
// post bodies are scrubbed/synthetic. Its top-level keys are exactly
// ["meta", "posts"] -- no embedded `profile`, which first-page (no `until`)
// responses do include. See tests/fixtures/xmd-history-continuation-missing-profile.json.
import continuationMissingProfile from "./fixtures/xmd-history-continuation-missing-profile.json";

function requestUrl(input: Parameters<typeof fetch>[0]) {
  return input instanceof Request ? input.url : input.toString();
}

const profile = {
  id: "123",
  screen_name: "theo",
  name: "Theo",
  future_field: { keep: true },
};

const raw = {
  post: {
    id: "999",
    text: "Full raw payload 🧵",
    author: profile,
    quote: { id: "998" },
    media: { all: [{ type: "video", variants: [1, 2] }] },
    unknown_future_field: ["keep", "all"],
  },
  extra_event_metadata: 8,
};

const terminal = {
  meta: { truncated: true, oldest: "2026-01-01", floor_reached: false },
  profile,
  extra_summary: true,
};

const request: CollectionRequest = {
  runId: "run-1",
  attempt: 1,
  kind: "bulk",
  input: "theo",
  format: "ndjson",
};

function client(lines: RawObject[], options: { noSummary?: boolean; userId?: string } = {}) {
  const fetcher = vi.fn<typeof fetch>(async (input) =>
    requestUrl(input).includes("/posts?")
      ? new Response(lines.map((x) => JSON.stringify(x)).join("\n") + "\n")
      : Response.json({
          resource: "profile",
          profile: { ...profile, id: options.userId ?? profile.id },
        }),
  );

  return { xmd: new XmdClient("test-key", fetcher), fetcher };
}

function receiver() {
  const captures: Capture[] = [];

  const sink = vi.fn<(capture: Capture) => Promise<Receipt>>(async (capture) => {
    captures.push(structuredClone(capture));

    return {
      captureId: await captureId(JSON.stringify(capture)),
      receiptId: `receipt-${captures.length}`,
      durable: true as const,
    };
  });

  return { captures, sink, ack: vi.fn<() => Promise<void>>(async () => {}) };
}

describe("x.md raw acquisition handoff", () => {
  it("defaults backfills to JSON and preserves the complete newest-first envelope", async () => {
    const envelope = {
      profile,
      posts: [raw.post],
      meta: terminal.meta,
      future: { untouched: true },
    };

    const fetcher = vi.fn<typeof fetch>(async (input) =>
      Response.json(requestUrl(input).includes("/posts?") ? envelope : { profile }),
    );

    const r = receiver();

    const result = await collectXmd(
      new XmdClient("test-key", fetcher),
      { ...request, format: undefined, refresh: true },
      r.sink,
      r.ack,
    );

    const url = new URL(requestUrl(fetcher.mock.calls[1][0]));
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("refresh")).toBe("true");
    expect(r.captures.at(-1)?.records[0].payload).toEqual(envelope);
    expect(r.captures.at(-1)?.request.format).toBe("json");
    expect(r.captures.at(-1)?.terminal).toBe("complete");
    expect(result.nextUntil).toBe("2026-01-01");
  });
  it("retains malformed JSON history for review without declaring completion", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      Response.json(
        requestUrl(input).includes("/posts?") ? { profile, posts: [raw.post] } : { profile },
      ),
    );

    const r = receiver();
    await expect(
      collectXmd(
        new XmdClient("test-key", fetcher),
        { ...request, format: undefined },
        r.sink,
        r.ack,
      ),
    ).rejects.toMatchObject({ code: "invalid_history" });
    expect(r.captures.at(-1)?.terminal).toBe("partial");
    expect(r.captures.at(-1)?.records[0].payload.posts).toEqual([raw.post]);
  });
  it("accepts a JSON history continuation page even when x.md omits the embedded profile", async () => {
    // Root cause of runs that retain ~500 posts and then permanently stop:
    // x.md's own /posts endpoint omits its embedded `profile` field on any
    // continuation request (one carrying `until`), while still returning a
    // fully valid posts+meta payload. Identity was already pinned via the
    // dedicated profile fetch earlier in collectXmd, so this must be accepted
    // as valid partial history -- not rejected as malformed.
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      Response.json(
        requestUrl(input).includes("/posts?") ? continuationMissingProfile : { profile },
      ),
    );

    const r = receiver();

    const result = await collectXmd(
      new XmdClient("test-key", fetcher),
      {
        ...request,
        format: undefined,
        until: "2026-08-16T04:19:11.000Z",
        expectedUserId: "123",
      },
      r.sink,
      r.ack,
    );

    expect(result.postsReceived).toBe(2);
    expect(result.nextUntil).toBe("2026-08-16T03:00:00.000Z");
    expect(r.captures.at(-1)?.terminal).toBe("complete");
    expect(r.captures.at(-1)?.records.at(-1)?.payload).toEqual(continuationMissingProfile);
  });
  it("still rejects a continuation page missing posts or meta as malformed, profile or not", async () => {
    const malformed = { ...continuationMissingProfile, meta: undefined };

    const fetcher = vi.fn<typeof fetch>(async (input) =>
      Response.json(requestUrl(input).includes("/posts?") ? malformed : { profile }),
    );

    const r = receiver();
    await expect(
      collectXmd(
        new XmdClient("test-key", fetcher),
        {
          ...request,
          format: undefined,
          until: "2026-08-16T04:19:11.000Z",
          expectedUserId: "123",
        },
        r.sink,
        r.ack,
      ),
    ).rejects.toMatchObject({ code: "invalid_history" });
    expect(r.captures.at(-1)?.terminal).toBe("partial");
  });
  it("still rejects a first (non-continuation) page missing profile as invalid", async () => {
    // The `until`-gated relaxation above is scoped to continuation requests
    // only. A first-page request (no `until`) must still fail closed when
    // the provider omits `profile`, otherwise a malformed or spoofed first
    // response would silently skip identity verification entirely.
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      Response.json(
        requestUrl(input).includes("/posts?") ? continuationMissingProfile : { profile },
      ),
    );

    const r = receiver();
    await expect(
      collectXmd(
        new XmdClient("test-key", fetcher),
        { ...request, format: undefined, expectedUserId: "123" },
        r.sink,
        r.ack,
      ),
    ).rejects.toMatchObject({ code: "invalid_history" });
    expect(r.captures.at(-1)?.terminal).toBe("partial");
  });
  it("does not accept a changed identity in a JSON history response", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      Response.json(
        requestUrl(input).includes("/posts?")
          ? { profile: { ...profile, id: "456" }, posts: [], meta: {} }
          : { profile },
      ),
    );

    const r = receiver();
    await expect(
      collectXmd(
        new XmdClient("test-key", fetcher),
        { ...request, format: undefined },
        r.sink,
        r.ack,
      ),
    ).rejects.toMatchObject({ code: "identity_mismatch" });
    expect(r.captures.some((c) => c.terminal === "complete")).toBe(false);
  });
  it("preserves nested posts, profile fields, media, and unknown event metadata without normalization", async () => {
    const { xmd } = client([raw, terminal]);
    const r = receiver();
    const result = await collectXmd(xmd, request, r.sink, r.ack, () => 1234);
    expect(r.captures.flatMap((c) => c.records).find((r) => r.payload.post)?.payload).toEqual(raw);
    expect(r.captures.at(-1)?.terminal).toBe("complete");
    expect(r.captures.at(-1)?.records.at(-1)?.payload).toEqual(terminal);
    expect(result.nextUntil).toBeUndefined();
    expect(result.warnings.join(" ")).toContain("unordered stream was capped");
    expect(result.expectedUserId).toBe("123");
    expect(r.ack).toHaveBeenCalledTimes(r.captures.length);
    expect(JSON.stringify(r.captures)).not.toContain("test-key");
  });
  it("keeps a partial stream without declaring it complete", async () => {
    const { xmd } = client([raw]);
    const r = receiver();
    await expect(collectXmd(xmd, request, r.sink, r.ack)).rejects.toMatchObject({
      code: "incomplete_stream",
    });
    expect(r.captures.at(-1)?.terminal).toBe("partial");
    expect(r.captures.some((c) => c.terminal === "complete")).toBe(false);
    expect(r.captures.at(-1)?.records[0].payload).toEqual(raw);
  });
  it("hands off the provider's terminal error object intact", async () => {
    const problem = {
      error: {
        code: "upstream_failure",
        resolution: "retry",
        extra: { preserved: true },
      },
    };

    const { xmd } = client([raw, problem]);
    const r = receiver();
    await expect(collectXmd(xmd, request, r.sink, r.ack)).rejects.toMatchObject({
      code: "partial_import",
    });
    expect(r.captures.at(-1)?.records.at(-1)?.payload).toEqual(problem);
    expect(r.captures.at(-1)?.terminal).toBe("partial");
  });
  it("rejects records after a summary without acknowledging a complete run", async () => {
    const { xmd } = client([raw, terminal, raw]);
    const r = receiver();
    await expect(collectXmd(xmd, request, r.sink, r.ack)).rejects.toMatchObject({
      code: "invalid_stream",
    });
    expect(r.captures.some((c) => c.terminal === "complete")).toBe(false);
  });
  it("retains a mismatched profile, then stops before reading the wrong account history", async () => {
    const { xmd, fetcher } = client([raw, terminal]);
    const r = receiver();
    await expect(
      collectXmd(xmd, { ...request, expectedUserId: "different" }, r.sink, r.ack),
    ).rejects.toMatchObject({ code: "identity_mismatch" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(r.captures[0].records[0].payload.profile).toEqual(profile);
  });
  it("pins numeric identity before importing even if the later stream fails", async () => {
    const { xmd } = client([raw]);
    const r = receiver();
    const pin = vi.fn<() => Promise<void>>(async () => {});
    await expect(collectXmd(xmd, request, r.sink, r.ack, Date.now, pin)).rejects.toThrow(Error);
    expect(pin).toHaveBeenCalledWith("123");
  });
  it("does not acknowledge a capture when the receiver rejects it", async () => {
    const { xmd } = client([raw, terminal]);
    const ack = vi.fn<() => Promise<void>>(async () => {});
    await expect(
      collectXmd(
        xmd,
        request,
        async () => {
          throw new Error("storage unavailable");
        },
        ack,
      ),
    ).rejects.toThrow("storage unavailable");
    expect(ack).not.toHaveBeenCalled();
  });
  it("passes search degradation and continuation while preserving the raw response", async () => {
    const response = {
      posts: [raw.post],
      nextCursor: "opaque",
      degraded: true,
      future: [1, 2],
    };

    const xmd = new XmdClient(
      undefined,
      vi.fn<typeof fetch>(async () => Response.json(response)),
    );

    const r = receiver();

    const result = await collectXmd(
      xmd,
      { ...request, kind: "live", input: "convex" },
      r.sink,
      r.ack,
    );

    expect(result.nextCursor).toBe("opaque");
    expect(result.warnings[0]).toContain("web-indexed");
    expect(r.captures[0].records[0].payload).toEqual(response);
  });
  it("decodes multibyte text across arbitrary NDJSON transport chunks", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(raw) + "\n" + JSON.stringify(terminal));

    const stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3));
        c.close();
      },
    });

    const xmd = new XmdClient(
      undefined,
      vi.fn<typeof fetch>(async () => new Response(stream)),
    );

    const events = [];

    for await (const event of xmd.bulk("theo", { maxPosts: 500 })) events.push(event);
    expect(events).toEqual([raw, terminal]);
  });
  it("supports both x.md origins, refresh, and bearer auth without URL credentials", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(terminal)));
    const xmd = new XmdClient("secret", fetcher, "https://x.pcstyle.dev");

    for await (const _ of xmd.bulk("@theo", { maxPosts: 500, refresh: true })) {
      /* drain */
    }

    const [url, init] = fetcher.mock.calls[0];
    expect(requestUrl(url)).toContain("https://x.pcstyle.dev/api/v1/profiles/theo/posts?");
    expect(requestUrl(url)).toContain("refresh=true");
    expect(requestUrl(url)).not.toContain("secret");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer secret");
    expect(init?.redirect).toBe("error");
    expect(() => new XmdClient("secret", fetcher, "https://other.example")).toThrow(Error);
  });
  it("reports a retryable rate limit and respects Retry-After", async () => {
    const xmd = new XmdClient(
      undefined,
      vi.fn<typeof fetch>(async () =>
        Response.json({ code: "rate_limited" }, { status: 429, headers: { "Retry-After": "90" } }),
      ),
    );

    await expect(xmd.read("profile", "theo")).rejects.toMatchObject({
      retryable: true,
      retryAfter: 90_000,
    });
    expect(retryDelay("Thu, 01 Jan 2026 00:01:00 GMT", Date.parse("2026-01-01"))).toBe(60_000);
  });
});

describe("durable handoff receipts", () => {
  const capture: Capture = {
    version: 1,
    runId: "test",
    attempt: 1,
    sequence: 0,
    source: "x-md",
    request: {
      origin: "https://mdfromx.com",
      resource: "profile",
      input: "theo",
    },
    records: [{ receivedAt: 1, payload: raw }],
    terminal: "complete",
  };

  it("retries an uncertain transport with identical bytes and idempotency key", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockImplementationOnce(async (_, options) =>
        Response.json({
          captureId: new Headers(options?.headers).get("Idempotency-Key"),
          durable: true,
          receiptId: "ok",
        }),
      );

    await expect(
      deliverCapture("https://data.example/captures", "data-token", capture, fetcher),
    ).resolves.toMatchObject({ durable: true });
    expect(fetcher.mock.calls[0][1]?.body).toEqual(fetcher.mock.calls[1][1]?.body);
    expect(fetcher.mock.calls[0][1]?.headers).toEqual(fetcher.mock.calls[1][1]?.headers);
  });
  it.each([
    { durable: false, captureId: "wrong", receiptId: "ok" },
    { durable: true, captureId: "wrong", receiptId: "ok" },
  ])("rejects a non-durable or wrong-content receipt", async (response) => {
    await expect(
      deliverCapture(
        "https://data.example/captures",
        undefined,
        capture,
        vi.fn<typeof fetch>(async () => Response.json(response)),
      ),
    ).rejects.toMatchObject({ code: "invalid_receipt" });
  });
  it("does not follow redirects carrying service credentials", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://other.example" },
        }),
    );

    await expect(
      deliverCapture("https://data.example/captures", "secret", capture, fetcher),
    ).rejects.toMatchObject({ code: "handoff_rejected" });
    expect(fetcher.mock.calls[0][1]?.redirect).toBe("error");
  });
});

it.each([
  "http://localhost",
  "https://127.0.0.1/a",
  "https://[::1]/",
  "https://user:secret@example.com",
  "https://box.internal",
])("blocks non-public web URLs: %s", (value) => {
  expect(() => publicUrl(value)).toThrow(Error);
});
