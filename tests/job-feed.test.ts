import { describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import type { FunctionReference } from "convex/server";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import type { AccountLibraryRow, DashboardSummary } from "../convex/lib/contracts";

const modules = import.meta.glob("../convex/**/*.ts");

const summaryQuery = anyApi.summary.summary as unknown as FunctionReference<
  "query",
  "public",
  { now: number },
  DashboardSummary
>;
const libraryRows = anyApi.library.rows as unknown as FunctionReference<
  "query",
  "public",
  Record<string, never>,
  { rows: AccountLibraryRow[]; truncated: boolean }
>;
const libraryHistory = anyApi.library.history as unknown as FunctionReference<
  "query",
  "public",
  { accountId: Id<"accounts"> },
  { jobId: Id<"jobs">; dismissedAt?: number }[]
>;

async function setup() {
  const t = convexTest(schema, modules);
  const alice = await t.run((ctx) => ctx.db.insert("users", { isAnonymous: true }));
  const bob = await t.run((ctx) => ctx.db.insert("users", { isAnonymous: true }));
  return {
    t,
    alice,
    bob,
    a: t.withIdentity({ subject: `${alice}|session` }),
    b: t.withIdentity({ subject: `${bob}|session` }),
  };
}

async function insertJob(
  t: Awaited<ReturnType<typeof setup>>["t"],
  owner: Id<"users">,
  args: { input: string; status?: Doc<"jobs">["status"]; kind?: Doc<"jobs">["kind"] },
) {
  return t.run((ctx) =>
    ctx.db.insert("jobs", {
      owner,
      kind: args.kind ?? "live",
      input: args.input,
      refresh: false,
      status: args.status ?? "failed",
      count: 0,
      attempt: 1,
      warnings: [],
      updatedAt: Date.now(),
    }),
  );
}

describe("clearing finished runs", () => {
  it("hides a dismissed run from the feed and the retryable count without deleting it or its receipts", async () => {
    const { t, alice, a } = await setup();
    const failed = await insertJob(t, alice, { input: "@theo one", status: "failed" });
    const kept = await insertJob(t, alice, { input: "@theo two", status: "failed" });
    await t.run((ctx) =>
      ctx.db.insert("receipts", {
        jobId: failed,
        captureId: "cap-1",
        receiptId: "r-1",
        records: 5,
      }),
    );

    const before = await a.query(summaryQuery, { now: Date.now() });
    expect(before.queue.failedRetryable).toEqual({ kind: "known", unit: "jobs", value: 2 });

    await a.mutation(api.jobs.dismiss, { jobId: failed });

    const feed = await a.query(api.jobs.list, {});
    expect(feed.map((job) => job._id)).toEqual([kept]);

    const after = await a.query(summaryQuery, { now: Date.now() });
    expect(after.queue.failedRetryable).toEqual({ kind: "known", unit: "jobs", value: 1 });

    // Nothing was deleted: the run and its durable receipt are both intact,
    // and asking for dismissed rows brings it straight back.
    expect(await t.run((ctx) => ctx.db.get(failed))).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.query("receipts").collect())).toHaveLength(1);
    const withDismissed = await a.query(api.jobs.list, { includeDismissed: true });
    expect(withDismissed.map((job) => job._id).sort()).toEqual([failed, kept].sort());
  });

  it("restores a dismissed run", async () => {
    const { t, alice, a } = await setup();
    const job = await insertJob(t, alice, { input: "@theo", status: "failed" });
    await a.mutation(api.jobs.dismiss, { jobId: job });
    expect(await a.query(api.jobs.list, {})).toHaveLength(0);
    await a.mutation(api.jobs.restore, { jobId: job });
    expect(await a.query(api.jobs.list, {})).toHaveLength(1);
  });

  it("refuses to dismiss work that is still running, so a run can never be hidden while it is still spending provider allowance", async () => {
    const { t, alice, a } = await setup();
    const running = await insertJob(t, alice, { input: "@theo", status: "running" });
    const queued = await insertJob(t, alice, { input: "@other", status: "queued" });
    await expect(a.mutation(api.jobs.dismiss, { jobId: running })).rejects.toThrow("Stop this run");
    await expect(a.mutation(api.jobs.dismiss, { jobId: queued })).rejects.toThrow("Stop this run");
  });

  it("never lets one person dismiss another person's run", async () => {
    const { t, alice, b } = await setup();
    const job = await insertJob(t, alice, { input: "@theo", status: "failed" });
    await expect(b.mutation(api.jobs.dismiss, { jobId: job })).rejects.toThrow("Job not found.");
  });

  it("keeps a dismissed run's captures counted as awaiting indexing, because hiding a row does not un-store its data", async () => {
    const { t, alice, a } = await setup();
    const bulk = await insertJob(t, alice, {
      input: "someone",
      kind: "bulk",
      status: "partial",
    });
    await t.run((ctx) =>
      ctx.db.insert("receipts", { jobId: bulk, captureId: "cap-9", receiptId: "r-9", records: 3 }),
    );
    const before = await a.query(summaryQuery, { now: Date.now() });
    expect(before.queue.savedCapturesAwaitingIndexing).toEqual({
      kind: "known",
      unit: "captures",
      value: 1,
    });
    await a.mutation(api.jobs.dismiss, { jobId: bulk });
    const after = await a.query(summaryQuery, { now: Date.now() });
    expect(after.queue.savedCapturesAwaitingIndexing).toEqual({
      kind: "known",
      unit: "captures",
      value: 1,
    });
    // The retryable counter, which is about work to do rather than data on
    // disk, does drop.
    expect(after.queue.failedRetryable).toEqual({ kind: "known", unit: "jobs", value: 0 });
  });
});

describe("an account whose every run was cleared", () => {
  it("keeps its library row and its published counts, and simply reports no latest run", async () => {
    const { t, alice, a } = await setup();
    const accountId = await t.run((ctx) =>
      ctx.db.insert("accounts", { handle: "someone", userId: "77", name: "Someone" }),
    );
    await t.run((ctx) =>
      ctx.db.insert("accountPublications", {
        accountId,
        state: "searchable",
        committedGeneration: 4,
        searchablePostCount: 950,
        updatedAt: Date.now(),
      }),
    );
    const job = await t.run((ctx) =>
      ctx.db.insert("jobs", {
        owner: alice,
        kind: "bulk",
        input: "someone",
        expectedUserId: "77",
        refresh: false,
        status: "failed",
        count: 0,
        attempt: 1,
        warnings: [],
        updatedAt: Date.now(),
      }),
    );

    await a.mutation(api.jobs.dismiss, { jobId: job });

    const library = (await a.query(libraryRows, {})).rows;
    expect(library).toHaveLength(1);
    expect(library[0].handle).toBe("someone");
    // Clearing the failed run must not erase what is actually searchable.
    expect(library[0].publicationState).toBe("searchable");
    expect(library[0].searchablePostCount).toEqual({ kind: "known", unit: "posts", value: 950 });
    // ...but the row stops advertising the run that was cleared.
    expect(library[0].latestJob).toBeUndefined();
    expect(library[0].nextAction).toEqual({ kind: "none" });

    // The history trail still has it, flagged, so it can be brought back.
    const runs = await a.query(libraryHistory, { accountId });
    expect(runs).toHaveLength(1);
    expect(runs[0].dismissedAt).toBeTypeOf("number");
  });
});

describe("one live search, one name", () => {
  it("stores `from:theo`, `@Theo` and `@theo` as the same canonical input instead of three differently-named rows", async () => {
    const { t, a } = await setup();
    vi.stubEnv("COLLECTOR_MODE", "outbound");
    vi.stubEnv("X_MD_API_KEY", "test");
    await t.mutation(internal.worker.heartbeat, { online: true });

    const first = await a.mutation(api.jobs.start, { kind: "live", input: "from:theo" });
    expect((await t.run((ctx) => ctx.db.get(first)))?.input).toBe("@theo");

    // The already-active guard matches on that exact stored string, so the
    // other two spellings now collide with the first instead of each opening
    // a new row for the same search.
    for (const spelling of ["@Theo", "@theo", "from:@theo"]) {
      await expect(
        a.mutation(api.jobs.start, { kind: "live", input: spelling }),
      ).rejects.toThrow("already active");
    }
  });

  it("keeps the rest of the query and lowercases only the handle", async () => {
    const { t, a } = await setup();
    vi.stubEnv("COLLECTOR_MODE", "outbound");
    vi.stubEnv("X_MD_API_KEY", "test");
    await t.mutation(internal.worker.heartbeat, { online: true });
    const job = await a.mutation(api.jobs.start, {
      kind: "live",
      input: "from:Theo Convex Components",
    });
    expect((await t.run((ctx) => ctx.db.get(job)))?.input).toBe("@theo Convex Components");
  });
});
