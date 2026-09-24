import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { addDaysUTC, computeWindow } from "../convex/lib/historyWindow";

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

    expect(account).not.toBeNull();
    const backfill = await backfillFor(t, account!._id);
    const expectedWindow = computeWindow("2021-01-01", 30, FLOOR)!;

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
