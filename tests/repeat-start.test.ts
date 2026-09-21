import { describe, expect, it, vi, beforeEach } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";

const modules = import.meta.glob("../convex/**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  const alice = await t.run((ctx) => ctx.db.insert("users", { isAnonymous: true }));
  const bob = await t.run((ctx) => ctx.db.insert("users", { isAnonymous: true }));
  return {
    t,
    alice,
    bob,
    a: t.withIdentity({ subject: `${alice}|s` }),
    b: t.withIdentity({ subject: `${bob}|s` }),
  };
}

const countJobs = (t: Awaited<ReturnType<typeof setup>>["t"]) =>
  t.run(async (ctx) => (await ctx.db.query("jobs").collect()).length);

/**
 * Production showed four "from:theo" live searches 11 to 15 seconds apart,
 * each returning nothing — a person clicking again because nothing visible
 * had happened. `start` only ever refused a concurrent duplicate, so every
 * one of those became its own row in the feed.
 */
describe("a repeated identical import request", () => {
  beforeEach(() => {
    vi.stubEnv("X_MD_API_KEY", "test");
    vi.stubEnv("RAW_CAPTURE_URL", "http://127.0.0.1:4319/captures");
    vi.stubEnv("COLLECTOR_MODE", "receiver");
  });

  it("returns the run it already made instead of starting another", async () => {
    const { t, a } = await setup();
    const first = await a.mutation(api.jobs.start, { kind: "live", input: "from:theo" });
    // Finished, so the "already active" guard below cannot be what stops it.
    await t.run((ctx) => ctx.db.patch(first, { status: "complete" }));
    const second = await a.mutation(api.jobs.start, { kind: "live", input: "from:theo" });
    expect(second).toBe(first);
    expect(await countJobs(t)).toBe(1);
  });

  it("still starts a real import once the window has passed", async () => {
    const { t, a } = await setup();
    const first = await a.mutation(api.jobs.start, { kind: "live", input: "from:theo" });
    await t.run((ctx) => ctx.db.patch(first, { status: "complete" }));
    // Age the run past the window rather than sleeping through it.
    await t.run(async (ctx) => {
      const job = (await ctx.db.get(first))!;
      await ctx.db.replace(first, { ...job, updatedAt: job.updatedAt - 120_000 });
    });
    vi.setSystemTime(Date.now() + 120_000);
    const second = await a.mutation(api.jobs.start, { kind: "live", input: "from:theo" });
    expect(second).not.toBe(first);
    expect(await countJobs(t)).toBe(2);
    vi.useRealTimers();
  });

  it("does not collapse a different request for the same account", async () => {
    const { t, a } = await setup();
    const first = await a.mutation(api.jobs.start, { kind: "bulk", input: "theo" });
    await t.run((ctx) => ctx.db.patch(first, { status: "complete" }));
    const withSince = await a.mutation(api.jobs.start, {
      kind: "bulk",
      input: "theo",
      since: "2025-01-01",
    });
    expect(withSince).not.toBe(first);
    // Clear it too: the pre-existing guard below refuses a *concurrent*
    // duplicate, and that is not what this test is about.
    await t.run((ctx) => ctx.db.patch(withSince, { status: "complete" }));
    const refreshed = await a.mutation(api.jobs.start, {
      kind: "bulk",
      input: "theo",
      refresh: true,
    });
    expect(refreshed).not.toBe(first);
    expect(refreshed).not.toBe(withSince);
  });

  it("never collapses an explicit continuation", async () => {
    const { t, a } = await setup();
    const first = await a.mutation(api.jobs.start, { kind: "bulk", input: "theo" });
    await t.run((ctx) =>
      ctx.db.patch(first, { status: "complete", nextUntil: "2025-01-01T00:00:00.000Z" }),
    );
    const next = await a.mutation(api.jobs.start, { kind: "bulk", input: "theo", previous: first });
    expect(next).not.toBe(first);
    expect(await countJobs(t)).toBe(2);
  });

  it("is scoped to one person — it can never hand back someone else's job", async () => {
    const { t, a, b } = await setup();
    const mine = await a.mutation(api.jobs.start, { kind: "live", input: "from:theo" });
    await t.run((ctx) => ctx.db.patch(mine, { status: "complete" }));
    const theirs = await b.mutation(api.jobs.start, { kind: "live", input: "from:theo" });
    expect(theirs).not.toBe(mine);
    expect(await t.run(async (ctx) => (await ctx.db.get(theirs))!.owner)).not.toBe(
      await t.run(async (ctx) => (await ctx.db.get(mine))!.owner),
    );
  });
});

/**
 * Between 2026-09-19 and 2026-09-21 the VM worker ran a build that dropped
 * the profile before reporting, so production finished twenty-six account
 * imports and wrote zero account rows. The profiles survived in the retained
 * raw captures; this is the path that puts them back.
 */
describe("rebuilding accounts from captured profiles", () => {
  const profiles = [
    { handle: "theo", userId: "786375418685165568", name: "Theo", avatar: "https://x/a.jpg" },
    { handle: "pcstyle53", userId: "1993812110162448386", name: "pc" },
  ];

  it("creates the missing rows and reports what it did", async () => {
    const { t } = await setup();
    expect(await t.mutation(internal.backfill.accountsFromProfiles, { profiles })).toEqual({
      created: 2,
      existing: 0,
    });
    const rows = await t.run((ctx) => ctx.db.query("accounts").collect());
    expect(rows.map((r) => r.handle).sort()).toEqual(["pcstyle53", "theo"]);
  });

  it("can be run twice without duplicating anything", async () => {
    const { t } = await setup();
    await t.mutation(internal.backfill.accountsFromProfiles, { profiles });
    expect(await t.mutation(internal.backfill.accountsFromProfiles, { profiles })).toEqual({
      created: 0,
      existing: 2,
    });
    expect(await t.run((ctx) => ctx.db.query("accounts").collect())).toHaveLength(2);
  });

  it("makes an already-finished job resolvable, which is the whole point", async () => {
    const { t, alice, a } = await setup();
    const jobId = await t.run((ctx) =>
      ctx.db.insert("jobs", {
        owner: alice,
        kind: "bulk",
        input: "theo",
        expectedUserId: "786375418685165568",
        status: "complete",
        refresh: false,
        autoContinue: false,
        pages: 3,
        postsReceived: 3155,
        count: 3155,
        attempt: 7,
        warnings: [],
        updatedAt: Date.now(),
      }),
    );
    expect((await a.query(api.library.rows, {})).rows).toHaveLength(0);
    await t.mutation(internal.backfill.accountsFromProfiles, { profiles });
    const { rows } = await a.query(api.library.rows, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].handle).toBe("theo");
    expect(jobId).toBeDefined();
  });
});
