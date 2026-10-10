import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";

// `startRefresh` schedules `internal.importer.run`; fake timers keep that
// action from running (and failing without provider credentials) mid-test.
beforeEach(() => vi.useFakeTimers());

afterEach(() => vi.useRealTimers());

const modules = import.meta.glob("../convex/**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);

  await t.run((ctx) => ctx.db.insert("accounts", { handle: "theo", userId: "123", name: "Theo" }));

  return t;
}

describe("jobs.startRefresh", () => {
  it("queues a timeline import from the given date for an indexed account", async () => {
    const t = await setup();

    const [started] = await t.mutation(internal.jobs.startRefresh, {
      accounts: [{ handle: "@Theo", since: "2026-09-20" }],
    });

    expect(started.handle).toBe("theo");
    const job = await t.run((ctx) => ctx.db.get(started.jobId!));

    expect(job).toMatchObject({
      kind: "bulk",
      input: "theo",
      since: "2026-09-20",
      refresh: true,
      autoContinue: true,
      expectedUserId: "123",
      status: "queued",
      origin: "manual",
    });
  });

  it("leaves an account whose import is already queued or running", async () => {
    const t = await setup();

    await t.mutation(internal.jobs.startRefresh, { accounts: [{ handle: "theo" }] });

    const [again] = await t.mutation(internal.jobs.startRefresh, {
      accounts: [{ handle: "theo" }],
    });

    expect(again.jobId).toBeNull();
    const jobs = await t.run((ctx) => ctx.db.query("jobs").collect());

    expect(jobs).toHaveLength(1);
  });

  it("refuses an account that is not indexed", async () => {
    const t = await setup();

    await expect(
      t.mutation(internal.jobs.startRefresh, { accounts: [{ handle: "nobody" }] }),
    ).rejects.toThrow("No account @nobody");
  });
});
