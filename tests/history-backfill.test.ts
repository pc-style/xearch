import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { addDaysUTC, computeWindow } from "../convex/lib/historyWindow";

// Every scenario below inserts a history-window job, and `insertHistoryWindowJob`
// (convex/jobs.ts) schedules `internal.importer.run` via
// `ctx.scheduler.runAfter(0, ...)`. `convex-test` runs scheduled functions
// through a real `setTimeout`, so without fake timers that action can start
// running (and, absent X_MD_API_KEY/RAW_CAPTURE_URL in this test's
// environment, immediately fail and mutate the SAME account's
// `historyBackfills` row) while this file's own `await t.run(...)`
// assertions are still in flight — an intermittent race, not a real bug in
// the code under test. Fake timers never advance on their own, so that
// scheduled call simply never fires during these tests.
beforeEach(() => vi.useFakeTimers());

afterEach(() => vi.useRealTimers());

/**
 * The deep-history backfill (convex/jobs.ts, convex/lib/historyWindow.ts):
 * once a bulk import hits x.md's account-timeline floor (or the account's
 * own reported post count says there is more history than the timeline
 * gave), `jobs.finish` schedules a `kind: "live"` window job walking
 * `from:<handle> since:<date> until:<date>` backward through time, and each
 * window's own `finish` schedules the next one (or stops the backfill) —
 * see jobs.ts `maybeStartHistoryBackfill`/`launchNextWindow`/
 * `onHistoryWindowFinished`.
 */

const modules = import.meta.glob("../convex/**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  const owner = await t.run((ctx) => ctx.db.insert("users", { isAnonymous: true }));

  return { t, owner };
}

const FLOOR = "2015-05-05";

async function insertAccount(
  t: Awaited<ReturnType<typeof setup>>["t"],
  overrides: { statuses?: number; joined?: string } = {},
) {
  return t.run((ctx) =>
    ctx.db.insert("accounts", {
      handle: "theo",
      userId: "123",
      name: "Theo",
      joined: FLOOR,
      ...overrides,
    }),
  );
}

async function insertBulkJob(t: Awaited<ReturnType<typeof setup>>["t"], owner: Id<"users">) {
  return t.run((ctx) =>
    ctx.db.insert("jobs", {
      owner,
      kind: "bulk",
      input: "theo",
      status: "running",
      count: 0,
      attempt: 1,
      refresh: false,
      warnings: [],
      updatedAt: Date.now(),
      autoContinue: true,
      pages: 0,
      postsReceived: 0,
    }),
  );
}

async function insertWindowJob(
  t: Awaited<ReturnType<typeof setup>>["t"],
  owner: Id<"users">,
  accountId: Id<"accounts">,
  since: string,
  until: string,
) {
  return t.run((ctx) =>
    ctx.db.insert("jobs", {
      owner,
      kind: "live",
      input: `from:theo since:${since} until:${until}`,
      since,
      until,
      origin: "history",
      historyFor: accountId,
      status: "running",
      count: 0,
      attempt: 1,
      refresh: false,
      warnings: [],
      updatedAt: Date.now(),
      autoContinue: false,
      pages: 0,
      postsReceived: 0,
    }),
  );
}

async function backfillFor(t: Awaited<ReturnType<typeof setup>>["t"], accountId: Id<"accounts">) {
  return t.run((ctx) =>
    ctx.db
      .query("historyBackfills")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .unique(),
  );
}

async function historyJobsFor(
  t: Awaited<ReturnType<typeof setup>>["t"],
  accountId: Id<"accounts">,
) {
  return t.run((ctx) =>
    ctx.db
      .query("jobs")
      .withIndex("by_kind", (q) => q.eq("kind", "live"))
      .filter((q) => q.eq(q.field("historyFor"), accountId))
      .collect(),
  );
}

describe("jobs.finish schedules the deep-history backfill", () => {
  it("floorReached on a bulk job schedules the first window with the right query and dates", async () => {
    const { t, owner } = await setup();
    const jobId = await insertBulkJob(t, owner);

    await t.mutation(internal.jobs.finish, {
      jobId,
      attempt: 1,
      warnings: [],
      postsReceived: 1500,
      oldest: "2021-01-01T17:42:10.000Z",
      floorReached: true,
      expectedUserId: "123",
      profile: { handle: "theo", userId: "123", name: "Theo", joined: FLOOR },
    });

    const account = await t.run((ctx) =>
      ctx.db
        .query("accounts")
        .withIndex("by_user_id", (q) => q.eq("userId", "123"))
        .unique(),
    );

    expect(account).not.toBeNull();
    const backfill = await backfillFor(t, account!._id);
    // The first window's `until` starts one day after the bulk import's
    // `oldest` — x.md's `until:` is exclusive, so `until: oldest` would skip
    // whatever the bulk import didn't reach earlier on that same day.
    const expectedWindow = computeWindow(addDaysUTC("2021-01-01", 1), 30, FLOOR)!;

    expect(backfill).toMatchObject({
      status: "running",
      cursorUntil: expectedWindow.since,
      windowDays: 30,
      postsFound: 0,
    });

    const windowJobs = await historyJobsFor(t, account!._id);

    expect(windowJobs).toHaveLength(1);
    expect(windowJobs[0]).toMatchObject({
      origin: "history",
      since: expectedWindow.since,
      until: expectedWindow.until,
      input: `from:theo since:${expectedWindow.since} until:${expectedWindow.until}`,
      status: "queued",
    });
  });

  it("an account's own reported post count exceeding the timeline also triggers a backfill", async () => {
    const { t, owner } = await setup();
    const jobId = await insertBulkJob(t, owner);

    await t.mutation(internal.jobs.finish, {
      jobId,
      attempt: 1,
      warnings: [],
      postsReceived: 3200,
      oldest: "2021-01-01",
      floorReached: false,
      expectedUserId: "123",
      profile: { handle: "theo", userId: "123", name: "Theo", joined: FLOOR, statuses: 67_444 },
    });

    const account = await t.run((ctx) =>
      ctx.db
        .query("accounts")
        .withIndex("by_user_id", (q) => q.eq("userId", "123"))
        .unique(),
    );

    expect(await backfillFor(t, account!._id)).not.toBeNull();
  });

  it("never starts a second backfill for the same account", async () => {
    const { t, owner } = await setup();
    const first = await insertBulkJob(t, owner);

    await t.mutation(internal.jobs.finish, {
      jobId: first,
      attempt: 1,
      warnings: [],
      postsReceived: 1500,
      oldest: "2021-01-01",
      floorReached: true,
      expectedUserId: "123",
      profile: { handle: "theo", userId: "123", name: "Theo", joined: FLOOR },
    });

    const account = await t.run((ctx) =>
      ctx.db
        .query("accounts")
        .withIndex("by_user_id", (q) => q.eq("userId", "123"))
        .unique(),
    );

    // A second, later bulk refresh of the SAME account also hits the floor.
    const second = await insertBulkJob(t, owner);

    await t.mutation(internal.jobs.finish, {
      jobId: second,
      attempt: 1,
      warnings: [],
      postsReceived: 1600,
      oldest: "2022-01-01",
      floorReached: true,
      expectedUserId: "123",
      profile: { handle: "theo", userId: "123", name: "Theo", joined: FLOOR },
    });

    const backfills = await t.run((ctx) =>
      ctx.db
        .query("historyBackfills")
        .withIndex("by_account", (q) => q.eq("accountId", account!._id))
        .collect(),
    );

    expect(backfills).toHaveLength(1);
  });

  it("starts after the timeline's own run of posts, not a pinned post months before it", async () => {
    const { t, owner } = await setup();
    const jobId = await insertBulkJob(t, owner);

    // Earlier pages reached July 11; the last page held only a pinned post.
    await t.run((ctx) => ctx.db.patch(jobId, { oldest: "2026-07-11T01:08:34.000Z" }));
    await t.mutation(internal.jobs.finish, {
      jobId,
      attempt: 1,
      warnings: [],
      postsReceived: 1,
      newest: "2026-03-30T03:03:36.000Z",
      oldest: "2026-03-30T03:03:36.000Z",
      floorReached: true,
      expectedUserId: "123",
      profile: { handle: "theo", userId: "123", name: "Theo", joined: FLOOR },
    });

    expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({
      oldest: "2026-07-11T01:08:34.000Z",
    });

    const account = await t.run((ctx) =>
      ctx.db
        .query("accounts")
        .withIndex("by_user_id", (q) => q.eq("userId", "123"))
        .unique(),
    );

    expect(await historyJobsFor(t, account!._id)).toEqual([
      expect.objectContaining({ until: "2026-07-12" }),
    ]);
  });
});

describe("a history-window job's own finish drives the backfill forward", () => {
  async function seedRunningBackfill(
    t: Awaited<ReturnType<typeof setup>>["t"],
    owner: Id<"users">,
  ) {
    const accountId = await insertAccount(t);
    const cursorUntil = "2020-12-02";

    const backfillId = await t.run((ctx) =>
      ctx.db.insert("historyBackfills", {
        accountId,
        handle: "theo",
        owner,
        since: FLOOR,
        cursorUntil,
        windowDays: 30,
        postsFound: 0,
        status: "running",
        updatedAt: Date.now(),
      }),
    );

    const window = computeWindow(cursorUntil, 30, FLOOR)!;
    const jobId = await insertWindowJob(t, owner, accountId, window.since, window.until);

    return { accountId, backfillId, window, jobId };
  }

  it("a window that found posts schedules the next window at the same size", async () => {
    const { t, owner } = await setup();
    const { accountId, jobId, window } = await seedRunningBackfill(t, owner);

    await t.mutation(internal.jobs.finish, {
      jobId,
      attempt: 1,
      warnings: [],
      postsReceived: 42,
    });

    const backfill = await backfillFor(t, accountId);
    const expectedNext = computeWindow(window.since, 30, FLOOR)!;

    expect(backfill).toMatchObject({
      status: "running",
      windowDays: 30,
      postsFound: 42,
      cursorUntil: expectedNext.since,
    });

    const windowJobs = await historyJobsFor(t, accountId);

    expect(windowJobs).toHaveLength(2);
    const scheduled = windowJobs.find((j) => j._id !== jobId)!;

    expect(scheduled).toMatchObject({
      since: expectedNext.since,
      until: expectedNext.until,
      status: "queued",
    });
  });

  it("resumes from the oldest post when x.md stopped paging before the window's start", async () => {
    const { t, owner } = await setup();
    const { accountId, jobId } = await seedRunningBackfill(t, owner);

    await t.mutation(internal.jobs.finish, {
      jobId,
      attempt: 1,
      warnings: [],
      postsReceived: 40,
      newest: "2020-12-01T09:00:00.000Z",
      oldest: "2020-11-20T05:00:00.000Z",
    });

    expect(await backfillFor(t, accountId)).toMatchObject({
      status: "running",
      windowDays: 30,
      cursorUntil: "2020-10-22",
    });
    const scheduled = (await historyJobsFor(t, accountId)).find((j) => j._id !== jobId);

    expect(scheduled).toMatchObject({ since: "2020-10-22", until: "2020-11-21" });
  });

  it("keeps walking when the window reaching the joined date was cut short", async () => {
    const { t, owner } = await setup();
    const accountId = await insertAccount(t);

    await t.run((ctx) =>
      ctx.db.insert("historyBackfills", {
        accountId,
        handle: "theo",
        owner,
        since: FLOOR,
        cursorUntil: FLOOR,
        windowDays: 30,
        postsFound: 0,
        status: "running",
        updatedAt: Date.now(),
      }),
    );
    const jobId = await insertWindowJob(t, owner, accountId, FLOOR, addDaysUTC(FLOOR, 20));

    await t.mutation(internal.jobs.finish, {
      jobId,
      attempt: 1,
      warnings: [],
      postsReceived: 20,
      oldest: `${addDaysUTC(FLOOR, 10)}T08:00:00.000Z`,
    });

    expect(await backfillFor(t, accountId)).toMatchObject({ status: "running" });
    const scheduled = (await historyJobsFor(t, accountId)).find((j) => j._id !== jobId);

    expect(scheduled).toMatchObject({ since: FLOOR, until: addDaysUTC(FLOOR, 11) });
  });

  it("an empty window widens the next window ×4", async () => {
    const { t, owner } = await setup();
    const { accountId, jobId, window } = await seedRunningBackfill(t, owner);

    await t.mutation(internal.jobs.finish, {
      jobId,
      attempt: 1,
      warnings: [],
      postsReceived: 0,
    });

    const backfill = await backfillFor(t, accountId);

    expect(backfill?.windowDays).toBe(120);
    const expectedNext = computeWindow(window.since, 120, FLOOR)!;

    expect(backfill?.cursorUntil).toBe(expectedNext.since);
    const windowJobs = await historyJobsFor(t, accountId);
    const scheduled = windowJobs.find((j) => j._id !== jobId)!;

    expect(scheduled).toMatchObject({ since: expectedNext.since, until: expectedNext.until });
  });

  it("stops (complete) once a window reaching the account's joined date finishes", async () => {
    const { t, owner } = await setup();
    const accountId = await insertAccount(t);
    // Five days past the floor: the next window's `since` clamps to FLOOR,
    // making it the final window.
    const cursorUntil = addDaysUTC(FLOOR, 5);

    const backfillId = await t.run((ctx) =>
      ctx.db.insert("historyBackfills", {
        accountId,
        handle: "theo",
        owner,
        since: FLOOR,
        cursorUntil,
        windowDays: 30,
        postsFound: 10,
        status: "running",
        updatedAt: Date.now(),
      }),
    );

    const window = computeWindow(cursorUntil, 30, FLOOR)!;

    expect(window.since).toBe(FLOOR);
    const jobId = await insertWindowJob(t, owner, accountId, window.since, window.until);

    await t.mutation(internal.jobs.finish, {
      jobId,
      attempt: 1,
      warnings: [],
      postsReceived: 3,
    });

    const backfill = await t.run((ctx) => ctx.db.get(backfillId));

    expect(backfill).toMatchObject({ status: "complete", postsFound: 13 });
    // No further window job scheduled once the backfill has stopped.
    expect(await historyJobsFor(t, accountId)).toHaveLength(1);
  });

  it("marks the backfill stopped, with the job's error, once the window job fails for good", async () => {
    const { t, owner } = await setup();
    const { accountId, jobId } = await seedRunningBackfill(t, owner);

    // No `retryAfter`: this is a terminal failure, the same as `jobs.finish`
    // gives up on any job after MAX_PAGE_ATTEMPTS backoff attempts.
    await t.mutation(internal.jobs.finish, {
      jobId,
      attempt: 1,
      warnings: [],
      error: "x.md could not finish this request (500).",
    });

    const backfill = await backfillFor(t, accountId);

    expect(backfill).toMatchObject({
      status: "stopped",
      error: "x.md could not finish this request (500).",
    });
    expect(await historyJobsFor(t, accountId)).toHaveLength(1);
  });
});

describe("jobs.restartHistoryBackfill", () => {
  it("walks a finished backfill again from the given date", async () => {
    const { t, owner } = await setup();
    const accountId = await insertAccount(t);

    const backfillId = await t.run((ctx) =>
      ctx.db.insert("historyBackfills", {
        accountId,
        handle: "theo",
        owner,
        since: FLOOR,
        cursorUntil: FLOOR,
        windowDays: 365,
        postsFound: 30_000,
        status: "complete",
        updatedAt: Date.now(),
      }),
    );

    await t.mutation(internal.jobs.restartHistoryBackfill, {
      handle: "@Theo",
      until: "2026-07-12",
    });

    expect(await t.run((ctx) => ctx.db.get(backfillId))).toMatchObject({
      status: "running",
      windowDays: 30,
      cursorUntil: "2026-06-12",
    });
    expect(await historyJobsFor(t, accountId)).toEqual([
      expect.objectContaining({ since: "2026-06-12", until: "2026-07-12", status: "queued" }),
    ]);
  });

  it("refuses while the backfill is still running", async () => {
    const { t, owner } = await setup();
    const accountId = await insertAccount(t);

    await t.run((ctx) =>
      ctx.db.insert("historyBackfills", {
        accountId,
        handle: "theo",
        owner,
        since: FLOOR,
        cursorUntil: "2020-01-01",
        windowDays: 30,
        postsFound: 0,
        status: "running",
        updatedAt: Date.now(),
      }),
    );

    await expect(
      t.mutation(internal.jobs.restartHistoryBackfill, { handle: "theo", until: "2026-07-12" }),
    ).rejects.toThrow("still running");
  });
});

describe("manual retry/cancel on a history-window job", () => {
  // tests/setupEnv.ts lists this address on OPERATOR_EMAILS.
  async function operatorSetup() {
    const t = convexTest(schema, modules);

    const owner = await t.run((ctx) =>
      ctx.db.insert("users", {
        isAnonymous: false,
        email: "operator@test.xearch",
        emailVerificationTime: Date.now(),
      }),
    );

    return { t, owner, operator: t.withIdentity({ subject: `${owner}|s` }) };
  }

  it("refuses to retry a stopped history-window job on its own", async () => {
    const { t, owner, operator } = await operatorSetup();
    const accountId = await insertAccount(t);
    const jobId = await insertWindowJob(t, owner, accountId, "2020-11-02", "2020-12-02");

    await t.run((ctx) => ctx.db.patch(jobId, { status: "failed" }));
    await expect(operator.mutation(api.jobs.retry, { jobId })).rejects.toThrow(
      "not retried on its own",
    );
  });

  it("stops the backfill when its current window job is cancelled", async () => {
    const { t, owner, operator } = await operatorSetup();
    const { backfillId, jobId } = await seedBackfillFixture(t, owner);

    await operator.mutation(api.jobs.cancel, { jobId });
    const backfill = await t.run((ctx) => ctx.db.get(backfillId));

    expect(backfill).toMatchObject({ status: "stopped", error: "Stopped by request." });
  });

  async function seedBackfillFixture(
    t: Awaited<ReturnType<typeof setup>>["t"],
    owner: Id<"users">,
  ) {
    const accountId = await insertAccount(t);

    const backfillId = await t.run((ctx) =>
      ctx.db.insert("historyBackfills", {
        accountId,
        handle: "theo",
        owner,
        since: FLOOR,
        cursorUntil: "2020-12-02",
        windowDays: 30,
        postsFound: 0,
        status: "running",
        updatedAt: Date.now(),
      }),
    );

    const jobId = await insertWindowJob(t, owner, accountId, "2020-11-02", "2020-12-02");

    return { accountId, backfillId, jobId };
  }
});
