import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";

const modules = import.meta.glob("../convex/**/*.ts");

const HOUR = 3_600_000;

function setup() {
  return convexTest(schema, modules);
}

// A verified email on the test-only OPERATOR_EMAILS list (tests/setupEnv.ts).
async function operator(t: ReturnType<typeof setup>) {
  const userId: Id<"users"> = await t.run((ctx) =>
    ctx.db.insert("users", {
      isAnonymous: false,
      email: "operator@test.xearch",
      emailVerificationTime: Date.now(),
    }),
  );

  return { a: t.withIdentity({ subject: `${userId}|session` }), userId };
}

function jobFields(owner: Id<"users">, fields: Partial<Doc<"jobs">>) {
  return {
    owner,
    kind: "bulk" as const,
    input: "bob",
    refresh: false,
    status: "complete" as const,
    count: 0,
    attempt: 1,
    warnings: [],
    updatedAt: Date.now(),
    ...fields,
  };
}

describe("ops.accounts", () => {
  it("refuses a session that is not an operator", async () => {
    const t = setup();
    const userId = await t.run((ctx) => ctx.db.insert("users", { isAnonymous: true }));
    const guest = t.withIdentity({ subject: `${userId}|session` });

    await expect(guest.query(api.ops.accountsSnapshot, {})).rejects.toThrow(
      "Sign in as an operator",
    );
    await expect(guest.query(api.ops.activitySnapshot, { now: Date.now() })).rejects.toThrow(
      "Sign in as an operator",
    );
  });

  it("lists accounts with no run on record, and derives runs, reach and backfill for the rest", async () => {
    const t = setup();
    const { a, userId } = await operator(t);
    const now = Date.now();

    const bob = await t.run((ctx) =>
      ctx.db.insert("accounts", {
        handle: "bob",
        userId: "222",
        name: "Bob",
        joined: "2012-03-01",
      }),
    );

    await t.run((ctx) =>
      ctx.db.insert("accounts", { handle: "quiet", userId: "333", name: "Quiet" }),
    );

    await t.run(async (ctx) => {
      await ctx.db.insert(
        "jobs",
        jobFields(userId, {
          expectedUserId: "222",
          status: "complete",
          oldest: "2019-05-04T10:00:00.000Z",
          postsReceived: 3200,
          floorReached: true,
          updatedAt: now - 2 * HOUR,
        }),
      );
      await ctx.db.insert(
        "jobs",
        jobFields(userId, {
          expectedUserId: "222",
          refresh: true,
          status: "failed",
          error: "x.md 502",
          updatedAt: now - HOUR,
        }),
      );
      await ctx.db.insert("accountPublications", {
        accountId: bob,
        state: "searchable",
        committedGeneration: 1,
        searchablePostCount: 3100,
        lastPublishedAt: now - 90 * 60_000,
        pendingWork: { unit: "captures", count: 2 },
        updatedAt: now,
      });
      await ctx.db.insert("historyBackfills", {
        accountId: bob,
        handle: "bob",
        owner: userId,
        since: "2012-03-01",
        cursorUntil: "2018-01-01",
        windowDays: 90,
        postsFound: 40,
        status: "running",
        updatedAt: now,
      });
    });

    // The window that moved `cursorUntil` to 2018-01-01 is still running:
    // only its `until` has been reached so far.
    const windowJob = await t.run((ctx) =>
      ctx.db.insert(
        "jobs",
        jobFields(userId, {
          kind: "live",
          input: "from:bob since:2018-01-01 until:2018-04-01",
          origin: "history",
          historyFor: bob,
          since: "2018-01-01",
          until: "2018-04-01",
          status: "running",
          updatedAt: now,
        }),
      ),
    );

    const { rows, truncated } = await a.query(api.ops.accountsSnapshot, {});

    expect(truncated).toBe(false);
    expect(rows.map((r) => r.handle).sort()).toEqual(["bob", "quiet"]);

    const quiet = rows.find((r) => r.handle === "quiet")!;

    expect(quiet.publication).toBeNull();
    expect(quiet.latestRun).toBeUndefined();

    const row = rows.find((r) => r.handle === "bob")!;

    expect(row.joined).toBe("2012-03-01");
    expect(row.latestRun).toMatchObject({ status: "failed", error: "x.md 502", refresh: true });
    expect(row.lastCompletedAt).toBe(now - 2 * HOUR);
    // The running window has reached 2018-04-01, past the run's 2019 floor,
    // but not yet the 2018-01-01 its launch already wrote to `cursorUntil`.
    expect(row.oldestCollected).toBe("2018-04-01");
    expect(row.backfill).toMatchObject({ status: "running", postsFound: 40 });
    expect(row.publication).toMatchObject({
      state: "searchable",
      searchablePostCount: 3100,
      pendingWork: { unit: "captures", count: 2 },
    });

    // Once that window finishes, its `since` has been walked.
    await t.run((ctx) => ctx.db.patch(windowJob, { status: "complete" }));

    const after = (await a.query(api.ops.accountsSnapshot, {})).rows.find(
      (r) => r.handle === "bob",
    )!;

    expect(after.oldestCollected).toBe("2018-01-01");
  });
});

describe("jobs.list", () => {
  it("falls back to the default page size for a limit that is not a finite number", async () => {
    const t = setup();
    const { a, userId } = await operator(t);

    await t.run(async (ctx) => {
      for (let i = 0; i < 25; i += 1) await ctx.db.insert("jobs", jobFields(userId, {}));
    });

    expect((await a.query(api.jobs.list, { limit: Number.NaN })).jobs).toHaveLength(20);
    expect((await a.query(api.jobs.list, { limit: Infinity })).jobs).toHaveLength(20);
    expect((await a.query(api.jobs.list, { limit: 3 })).jobs).toHaveLength(3);
  });
});

describe("ops.activity", () => {
  it("counts the last day's downloads per hour, searches, runs and x.md limits", async () => {
    const t = setup();
    const { a, userId } = await operator(t);

    await t.run(async (ctx) => {
      const bulk = await ctx.db.insert("jobs", jobFields(userId, { status: "failed" }));
      const profile = await ctx.db.insert("jobs", jobFields(userId, { kind: "profile" }));

      await ctx.db.insert("receipts", {
        jobId: bulk,
        captureId: "c1",
        receiptId: "r1",
        records: 50,
      });
      await ctx.db.insert("receipts", {
        jobId: profile,
        captureId: "c2",
        receiptId: "r2",
        records: 1,
      });

      // One query, and its "Load more" page, which is not a second query.
      for (const cursor of [undefined, "page2"])
        await ctx.db.insert("sessions", {
          owner: userId,
          raw: "convex",
          sort: "newest",
          cursor,
          status: "complete",
          rows: [],
          warnings: [],
        });
      await ctx.db.insert("providerThrottleEvents", {
        provider: "xmd",
        operation: "history",
        reason: "429",
        observedAt: Date.now(),
      });
    });

    const now = Date.now() + 1000;
    const result = await a.query(api.ops.activitySnapshot, { now });

    expect(result.downloads.hours).toHaveLength(24);
    expect(result.downloads.hours.at(-1)).toMatchObject({ posts: 50, other: 1 });
    expect(result.downloads.hours.slice(0, 23).every((h) => h.posts === 0 && h.other === 0)).toBe(
      true,
    );
    expect(result.jobs).toEqual({
      byKind: expect.arrayContaining([
        { kind: "bulk", count: 1 },
        { kind: "profile", count: 1 },
      ]),
      failed: 1,
      truncated: false,
    });
    expect(result.search).toMatchObject({ queries: 1, failed: 0, timedSample: 0 });
    expect(result.search.medianMs).toBeUndefined();
    expect(result.throttles).toEqual({ xmd: 1, truncated: false });

    // A day later all of it has aged out.
    const later = await a.query(api.ops.activitySnapshot, { now: now + 25 * HOUR });

    expect(later.downloads.hours.every((h) => h.posts === 0 && h.other === 0)).toBe(true);
    expect(later.jobs.byKind).toEqual([]);
    expect(later.throttles.xmd).toBe(0);
  });
});
