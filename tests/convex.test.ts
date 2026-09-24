import { afterEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import firecrawlTest from "@firecrawl/firecrawl-convex/test";
import schema from "../convex/schema";
import { EXPIRE_GRACE_MS } from "../convex/jobs";
import { api, internal } from "../convex/_generated/api";
import { isWorkerLive, WORKER_LIVE_WINDOW_MS } from "../convex/worker";

const modules = import.meta.glob("../convex/**/*.ts");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setup() {
  const t = convexTest(schema, modules);

  const [alice, bob] = await t.run(async (ctx) => [
    await ctx.db.insert("users", { isAnonymous: true }),
    await ctx.db.insert("users", { isAnonymous: true }),
  ]);

  return {
    t,
    alice,
    bob,
    a: t.withIdentity({ subject: `${alice}|session`, email: "alice@test.xearch" }),
    b: t.withIdentity({ subject: `${bob}|session`, email: "bob@test.xearch" }),
  };
}

describe("Convex application boundaries", () => {
  it("publishes Effect-decoded search results through the existing service contract", async () => {
    const { t, a, b, alice } = await setup();
    vi.stubEnv("SEARCH_API_URL", "https://search.example/query");
    vi.stubEnv("SEARCH_SERVICE_TOKEN", "test-search-token");

    const post = {
      tweetId: "123",
      author: "example",
      text: "convex",
      url: "https://x.com/example/status/123",
      links: [],
    };

    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        rows: [{ ...post, internalOnly: true }],
        nextCursor: "next",
      }),
    );

    vi.stubGlobal("fetch", fetcher);

    const sessionId = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        owner: alice,
        raw: "@example convex",
        sort: "newest",
        status: "queued",
        rows: [],
        warnings: [],
      }),
    );

    await t.action(internal.search.execute, { sessionId });
    expect(fetcher).toHaveBeenCalledOnce();
    const init = fetcher.mock.calls[0][1];
    // SAFETY: convex/search.ts's `execute` only ever calls `fetch` with a
    // JSON.stringify'd string body (never a Blob/stream/etc — this is the
    // only fetch call this action makes), so `init.body` is a string here.
    expect(JSON.parse(init?.body as string)).toEqual({
      version: 1,
      query: "convex",
      author: "example",
      sort: "newest",
      limit: 20,
    });
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-search-token");
    expect(await a.query(api.search.results, { sessionId })).toMatchObject({
      status: "complete",
      rows: [post],
      warnings: [],
      nextCursor: "next",
    });
    await expect(b.query(api.search.results, { sessionId })).rejects.toThrow("not found");
  });
  it("fails search safely when the service exceeds the Effect page limit", async () => {
    const { t, a, alice } = await setup();
    vi.stubEnv("SEARCH_API_URL", "https://search.example/query");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Response.json({
          rows: Array.from({ length: 21 }, () => ({
            tweetId: "123",
            author: "example",
            text: "convex",
            url: "https://x.com/example/status/123",
            links: [],
          })),
        }),
      ),
    );

    const sessionId = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        owner: alice,
        raw: "convex",
        sort: "relevance",
        status: "queued",
        rows: [],
        warnings: [],
      }),
    );

    await t.action(internal.search.execute, { sessionId });
    expect(await a.query(api.search.results, { sessionId })).toMatchObject({
      status: "failed",
      rows: [],
      error: expect.stringContaining("valid result page"),
    });
  });
  it("rejects an unauthorized production worker", async () => {
    const { t } = await setup();
    vi.stubEnv("COLLECTOR_MODE", "outbound");
    vi.stubEnv("COLLECTOR_TOKEN", "test-worker-secret");
    await expect(t.action(api.worker.poll, { token: "wrong" })).rejects.toThrow(
      "authentication failed",
    );
    expect(await t.run((ctx) => ctx.db.query("collector").collect())).toEqual([]);
  });
  it("leases only one due job to the outbound worker", async () => {
    const { t, alice } = await setup();
    vi.stubEnv("COLLECTOR_MODE", "outbound");
    vi.stubEnv("COLLECTOR_TOKEN", "test-worker-secret");

    const ids = await t.run(async (ctx) => {
      const base = {
        owner: alice,
        kind: "profile" as const,
        status: "queued" as const,
        count: 0,
        attempt: 0,
        refresh: false,
        warnings: [],
        updatedAt: Date.now(),
      };

      return [
        await ctx.db.insert("jobs", {
          ...base,
          input: "later",
          readyAt: Date.now() + 60000,
        }),
        await ctx.db.insert("jobs", { ...base, input: "now" }),
      ];
    });

    const first = await t.action(api.worker.poll, {
      token: "test-worker-secret",
    });

    expect(first?._id).toBe(ids[1]);
    expect(await t.action(api.worker.poll, { token: "test-worker-secret" })).toBeNull();
    expect((await t.run((ctx) => ctx.db.get(ids[0])))?.status).toBe("queued");
  });
  it("shows offline workers as unavailable and disables new imports", async () => {
    const { t, a } = await setup();
    vi.stubEnv("COLLECTOR_MODE", "outbound");
    vi.stubEnv("X_MD_API_KEY", "test");
    await t.mutation(internal.worker.heartbeat, { online: false });
    const now = Date.now();
    expect(await a.query(api.integrations.configured, { now })).toMatchObject({
      indexing: false,
    });
    // Collector mode and handoff state are operator facts, so they are only
    // on the session-gated query now — never on the public bootstrap.
    expect(await a.query(api.integrations.operator, { now })).toMatchObject({
      handoff: false,
      indexing: false,
      collectorMode: "outbound",
    });
    await expect(a.mutation(api.jobs.start, { kind: "profile", input: "theo" })).rejects.toThrow(
      "worker is offline",
    );
    await t.mutation(internal.worker.heartbeat, { online: true });
    expect(await a.query(api.integrations.operator, { now: Date.now() })).toMatchObject({
      handoff: true,
      indexing: true,
    });
  });
  it("presence decays purely from `lastSeen`, with no scheduled expire: a worker that stops heartbeating without an explicit shutdown reads offline again once the liveness window passes, and an explicit shutdown reads offline immediately regardless of freshness", async () => {
    const { t, a } = await setup();
    vi.stubEnv("COLLECTOR_MODE", "outbound");
    vi.stubEnv("X_MD_API_KEY", "test");
    const start = Date.now();
    await t.mutation(internal.worker.heartbeat, { online: true });
    expect(await a.query(api.integrations.configured, { now: start })).toMatchObject({
      indexing: true,
    });
    // Fresh: still live just before the 45s window elapses.
    expect(await a.query(api.integrations.configured, { now: start + 44_000 })).toMatchObject({
      indexing: true,
    });
    // Stale: no new heartbeat arrived, so a caller's own later clock (not a
    // new write) is what flips this — the exact case a scheduled `expire`
    // used to exist for, and no longer needs to.
    expect(await a.query(api.integrations.configured, { now: start + 46_000 })).toMatchObject({
      indexing: false,
    });
    // An explicit shutdown reads offline immediately, even at the same
    // instant, without waiting out the freshness window.
    await t.mutation(internal.worker.heartbeat, { online: false });
    expect(await a.query(api.integrations.configured, { now: Date.now() })).toMatchObject({
      indexing: false,
    });
  });
  it("blocks public email sending from unverified guest identities", async () => {
    const { t, a, alice } = await setup();
    vi.stubEnv("REQUIRE_VERIFIED_EMAIL", "true");

    const sessionId = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        owner: alice,
        raw: "convex",
        sort: "relevance",
        status: "complete",
        rows: [],
        warnings: [],
      }),
    );

    await expect(
      a.mutation(api.email.send, {
        sessionId,
        recipient: "someone@example.com",
      }),
    ).rejects.toThrow("verified email");
  });
  it("continues older pages in the same import and keeps real post counts", async () => {
    const { t, alice } = await setup();

    const jobId = await t.run((ctx) =>
      ctx.db.insert("jobs", {
        owner: alice,
        kind: "bulk",
        input: "theo",
        status: "running",
        count: 2,
        attempt: 1,
        pageAttempt: 1,
        refresh: false,
        warnings: [],
        updatedAt: Date.now(),
        autoContinue: true,
        pages: 0,
        postsReceived: 0,
      }),
    );

    const finish = {
      jobId,
      attempt: 1,
      warnings: [],
      postsReceived: 500,
      oldest: "2026-06-01",
      nextUntil: "2026-06-01",
    };

    await t.mutation(internal.jobs.finish, finish);
    await t.mutation(internal.jobs.finish, finish);
    expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({
      status: "queued",
      until: "2026-06-01",
      postsReceived: 500,
      pages: 1,
      pageAttempt: 0,
    });
    expect(await t.mutation(internal.jobs.claim, { jobId })).toBeNull();
    await t.run((ctx) => ctx.db.patch(jobId, { readyAt: 0 }));
    await t.mutation(internal.jobs.claim, { jobId });
    await t.mutation(internal.jobs.finish, {
      jobId,
      attempt: 2,
      warnings: [],
      postsReceived: 83,
      oldest: "2026-01-01",
      floorReached: true,
    });
    expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({
      status: "complete",
      postsReceived: 583,
      pages: 2,
      floorReached: true,
    });
  });
  it("stops instead of looping when the history boundary does not move", async () => {
    const { t, alice } = await setup();

    const jobId = await t.run((ctx) =>
      ctx.db.insert("jobs", {
        owner: alice,
        kind: "bulk",
        input: "theo",
        status: "running",
        count: 2,
        attempt: 1,
        refresh: false,
        warnings: [],
        updatedAt: Date.now(),
        autoContinue: true,
        until: "2026-06-01",
      }),
    );

    await t.mutation(internal.jobs.finish, {
      jobId,
      attempt: 1,
      warnings: [],
      postsReceived: 1,
      nextUntil: "2026-06-01",
    });
    const job = await t.run((ctx) => ctx.db.get(jobId));
    expect(job?.status).toBe("complete");
    expect(job?.error).toContain("did not return an older page");
    expect(job?.nextUntil).toBeUndefined();
  });
  it("requeues a bulk import with a further nextUntil on its own — nobody calls jobs.start to get the next page", async () => {
    const { t, alice } = await setup();

    const jobId = await t.run((ctx) =>
      ctx.db.insert("jobs", {
        owner: alice,
        kind: "bulk",
        input: "theo",
        status: "running",
        count: 2,
        attempt: 1,
        pageAttempt: 1,
        refresh: false,
        warnings: [],
        updatedAt: Date.now(),
        autoContinue: true,
        until: "2026-06-01",
        pages: 0,
        postsReceived: 0,
      }),
    );

    await t.mutation(internal.jobs.finish, {
      jobId,
      attempt: 1,
      warnings: [],
      postsReceived: 500,
      oldest: "2026-05-01",
      nextUntil: "2026-05-01",
    });
    const job = await t.run((ctx) => ctx.db.get(jobId));
    // Requeued as the SAME job, not left "complete" waiting on a button:
    // there is no `jobs.start` call anywhere in this test.
    expect(job).toMatchObject({
      status: "queued",
      until: "2026-05-01",
      nextUntil: "2026-05-01",
      pageAttempt: 0,
    });
    expect(job?.readyAt).toBeDefined();
    // And it is genuinely claimable once its readyAt arrives — proof the
    // requeue actually leads somewhere, not just a status flip.
    await t.run((ctx) => ctx.db.patch(jobId, { readyAt: 0 }));
    expect(await t.mutation(internal.jobs.claim, { jobId })).not.toBeNull();
  });
  it("requeues a non-bulk kind with a nextCursor on its own, and the next attempt reads that cursor", async () => {
    const { t, alice } = await setup();

    const jobId = await t.run((ctx) =>
      ctx.db.insert("jobs", {
        owner: alice,
        kind: "live",
        input: "@theo",
        status: "running",
        count: 5,
        attempt: 1,
        pageAttempt: 1,
        refresh: false,
        warnings: [],
        updatedAt: Date.now(),
      }),
    );

    await t.mutation(internal.jobs.finish, {
      jobId,
      attempt: 1,
      warnings: [],
      nextCursor: "cursor-page-2",
    });
    const job = await t.run((ctx) => ctx.db.get(jobId));
    expect(job).toMatchObject({
      status: "queued",
      nextCursor: "cursor-page-2",
      // convex/importer.ts reads `job.cursor` for the NEXT attempt — this is
      // what makes the requeued run actually ask for the next page instead
      // of repeating the one it just fetched.
      cursor: "cursor-page-2",
      pageAttempt: 0,
    });
    expect(job?.readyAt).toBeDefined();
  });
  it("backs off a retryable failure with growing delay, and stops as a failed job after 10 attempts", async () => {
    const { t, alice } = await setup();

    const jobId = await t.run((ctx) =>
      ctx.db.insert("jobs", {
        owner: alice,
        kind: "live",
        input: "@theo",
        status: "queued",
        count: 0,
        attempt: 0,
        refresh: false,
        warnings: [],
        updatedAt: Date.now(),
        readyAt: 0,
      }),
    );

    const now = Date.parse("2026-01-01T00:00:00.000Z");

    for (let pageAttempt = 1; pageAttempt <= 10; pageAttempt++) {
      vi.setSystemTime(now);
      await t.mutation(internal.jobs.claim, { jobId });
      await t.mutation(internal.jobs.finish, {
        jobId,
        attempt: pageAttempt,
        warnings: [],
        error: "provider hiccup",
        retryAfter: 1_000,
      });
      const job = await t.run((ctx) => ctx.db.get(jobId));

      if (pageAttempt < 10) {
        // Backoff grows with each attempt (30s * 2^pageAttempt), capped at
        // 15 minutes — by pageAttempt 5 the formula (960s) has already
        // exceeded the cap, proving the cap actually applies.
        const expectedDelay = Math.min(15 * 60_000, 30_000 * 2 ** pageAttempt);
        expect(job?.status).toBe("queued");
        expect(job?.readyAt).toBe(now + expectedDelay);
        await t.run((ctx) => ctx.db.patch(jobId, { readyAt: 0 }));
      } else {
        // The 10th attempt is the last one retried on its own; a person has
        // to retry from here.
        expect(job?.status).toBe("failed");
        expect(job?.error).toBe("provider hiccup");
        expect(job?.readyAt).toBeUndefined();
      }
    }

    vi.useRealTimers();
  });
  it("lets any signed-in caller cancel a job someone else started, and still rejects progress from a stopped worker", async () => {
    const { t, a, b, alice } = await setup();

    const jobId = await t.run((ctx) =>
      ctx.db.insert("jobs", {
        owner: alice,
        kind: "profile",
        input: "theo",
        status: "running",
        count: 0,
        attempt: 1,
        refresh: false,
        warnings: [],
        updatedAt: Date.now(),
      }),
    );

    // Imports are shared infrastructure, not personal data: bob (a
    // different signed-in caller) can see the job's receipts and cancel it,
    // even though alice started it.
    await expect(b.query(api.jobs.receipts, { jobId })).resolves.toEqual([]);
    await b.mutation(api.jobs.cancel, { jobId });
    await expect(
      t.mutation(internal.jobs.progress, {
        jobId,
        attempt: 1,
        phase: "Fetching",
      }),
    ).rejects.toThrow("no longer active");
    await t.mutation(internal.jobs.finish, { jobId, attempt: 1, warnings: [] });
    expect((await a.query(api.jobs.list, {})).jobs[0].status).toBe("cancelled");
  });
  it("still refuses an unauthenticated caller entirely", async () => {
    const { t, alice } = await setup();

    const jobId = await t.run((ctx) =>
      ctx.db.insert("jobs", {
        owner: alice,
        kind: "profile",
        input: "theo",
        status: "running",
        count: 0,
        attempt: 1,
        refresh: false,
        warnings: [],
        updatedAt: Date.now(),
      }),
    );

    await expect(t.mutation(api.jobs.cancel, { jobId })).rejects.toThrow();
    await expect(t.query(api.jobs.receipts, { jobId })).rejects.toThrow();
  });
  it("keeps saved searches private and rejects cross-user removal", async () => {
    const { a, b } = await setup();
    await a.mutation(api.search.save, {
      raw: "@theo convex",
      sort: "relevance",
    });
    const rows = await a.query(api.search.saved, {});
    expect(rows).toHaveLength(1);
    expect(await b.query(api.search.saved, {})).toEqual([]);
    await expect(b.mutation(api.search.removeSaved, { id: rows[0]._id })).rejects.toThrow(
      "Search not found",
    );
  });
  it("will not expose search results or bookmark another user's session", async () => {
    const { t, alice, b } = await setup();

    const sessionId = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        owner: alice,
        raw: "convex",
        sort: "relevance",
        status: "complete",
        rows: [
          {
            tweetId: "123",
            author: "theo",
            text: "convex",
            url: "https://x.com/theo/status/123",
            links: [],
          },
        ],
        warnings: [],
      }),
    );

    await expect(b.query(api.search.results, { sessionId })).rejects.toThrow(
      "Search session not found",
    );
    await expect(b.mutation(api.search.bookmark, { sessionId, tweetId: "123" })).rejects.toThrow(
      "Post not found",
    );
  });
  it("advances indexing progress once per receipt and refuses stale workers", async () => {
    const { t, alice } = await setup();

    const jobId = await t.run((ctx) =>
      ctx.db.insert("jobs", {
        owner: alice,
        kind: "bulk",
        input: "theo",
        refresh: false,
        status: "running",
        count: 0,
        attempt: 1,
        warnings: [],
        updatedAt: 0,
      }),
    );

    const ack = {
      jobId,
      attempt: 1,
      captureId: "sha256",
      receiptId: "r1",
      count: 25,
    };

    await t.mutation(internal.jobs.ack, ack);
    await t.mutation(internal.jobs.ack, ack);
    expect(await t.run(async (ctx) => (await ctx.db.get(jobId))!.count)).toBe(25);
    await expect(t.mutation(internal.jobs.ack, { ...ack, attempt: 2 })).rejects.toThrow(
      "no longer active",
    );
    // Still being reported on: expire re-arms instead of presuming it dead.
    await t.mutation(internal.jobs.expire, { jobId, attempt: 1 });
    expect(await t.run(async (ctx) => (await ctx.db.get(jobId))!.status)).toBe("running");
    // Nothing has touched it for longer than the grace period: presumed dead.
    await t.run(async (ctx) => {
      await ctx.db.patch(jobId, { updatedAt: Date.now() - EXPIRE_GRACE_MS - 1 });
    });
    await t.mutation(internal.jobs.expire, { jobId, attempt: 1 });
    expect(await t.run(async (ctx) => (await ctx.db.get(jobId))!.status)).toBe("partial");
  });
  it("gates collection on both the x.md credential and downstream receiver", async () => {
    const { a } = await setup();
    vi.stubEnv("X_MD_API_KEY", "test");
    vi.stubEnv("RAW_CAPTURE_URL", "");
    await expect(a.mutation(api.jobs.start, { kind: "bulk", input: "theo" })).rejects.toThrow(
      "raw-capture receiver",
    );
  });
  it("reads the Firecrawl component's unwrapped document and caches the UI preview", async () => {
    const { t, a } = await setup();
    firecrawlTest.register(t);
    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test");
    vi.stubEnv("RAW_CAPTURE_URL", "");

    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        success: true,
        data: {
          markdown: "# Real page shape",
          metadata: { title: "Page title" },
        },
      }),
    );

    vi.stubGlobal("fetch", fetcher);
    expect(
      await a.action(api.integrations.readLink, {
        url: "https://example.com/page",
      }),
    ).toEqual({
      url: "https://example.com/page",
      title: "Page title",
      text: "# Real page shape",
      collectedAt: expect.any(Number),
    });
    await a.action(api.integrations.readLink, {
      url: "https://example.com/page",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects unauthenticated paid actions before calling a provider", async () => {
    const { t } = await setup();
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      t.action(api.integrations.readLink, { url: "https://example.com" }),
    ).rejects.toThrow("Start a session");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("bounds stored web previews and preserves their collection time on cache hits", async () => {
    const { t, a } = await setup();
    firecrawlTest.register(t);
    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test");
    vi.stubEnv("RAW_CAPTURE_URL", "");

    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        success: true,
        data: {
          markdown: "a".repeat(5000),
          metadata: { title: "Long article" },
        },
      }),
    );

    vi.stubGlobal("fetch", fetcher);

    const first = await a.action(api.integrations.readLink, {
      url: "https://example.com/long",
    });

    const cached = await a.action(api.integrations.readLink, {
      url: "https://example.com/long",
    });

    expect(first.text).toContain("Preview shortened");
    expect(first.text.length).toBeLessThan(4200);
    expect(cached).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await t.run((ctx) => ctx.db.query("pages").first())).toMatchObject({
      collectedAt: first.collectedAt,
      text: first.text,
    });
  });
  it("retains an explicit author even when OpenAI omits it", async () => {
    const { a } = await setup();
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Response.json({
          output: [
            {
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    text: "convex",
                    author: "",
                    explanation: "Shorter keywords",
                  }),
                },
              ],
            },
          ],
        }),
      ),
    );
    expect(
      await a.action(api.integrations.interpret, {
        raw: "@theo posts about convex",
      }),
    ).toMatchObject({ query: "@theo convex" });
  });
  it("rejects OpenAI changing an explicit author", async () => {
    const { a } = await setup();
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Response.json({
          output: [
            {
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    text: "convex",
                    author: "someone_else",
                    explanation: "Changed",
                  }),
                },
              ],
            },
          ],
        }),
      ),
    );
    await expect(a.action(api.integrations.interpret, { raw: "@theo convex" })).rejects.toThrow(
      "different author",
    );
  });
  it("rejects unsupported hard filters before an OpenAI request", async () => {
    const { a } = await setup();
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    await expect(a.action(api.integrations.interpret, { raw: "convex -is:reply" })).rejects.toThrow(
      "operators",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("convex/worker.ts's isWorkerLive (the derived-presence helper that replaced the scheduled `expire` mutation)", () => {
  it("is not live when there is no row at all", () => {
    expect(isWorkerLive(null, Date.now())).toBe(false);
    expect(isWorkerLive(undefined, Date.now())).toBe(false);
  });

  it("is live while `lastSeen` is within the window and `online` is true", () => {
    const now = Date.now();
    expect(isWorkerLive({ online: true, lastSeen: now - (WORKER_LIVE_WINDOW_MS - 1) }, now)).toBe(
      true,
    );
  });

  it("goes stale on its own once the window passes, with no new write required", () => {
    const lastSeen = Date.now();
    expect(isWorkerLive({ online: true, lastSeen }, lastSeen + WORKER_LIVE_WINDOW_MS - 1)).toBe(
      true,
    );
    expect(isWorkerLive({ online: true, lastSeen }, lastSeen + WORKER_LIVE_WINDOW_MS)).toBe(false);
  });

  it("reads offline immediately on an explicit `online: false`, regardless of how fresh `lastSeen` is", () => {
    const now = Date.now();
    expect(isWorkerLive({ online: false, lastSeen: now }, now)).toBe(false);
  });
});
