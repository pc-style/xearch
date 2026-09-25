import { describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import type { FunctionReference } from "convex/server";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import type { AccountLibraryRow, DashboardSummary } from "../convex/lib/contracts";

const modules = import.meta.glob("../convex/**/*.ts");

// SAFETY: `anyApi.*` references are typed as `FunctionReference<any, any, any, any>`
// (convex/server's untyped API-builder), so every field is `any` and a
// single assertion to the concrete signature below is a narrowing
// TypeScript already allows structurally; convex-test rejects the reference
// outright at call time if the module/function name does not actually exist.
const summaryQuery = anyApi.summary.summary as FunctionReference<
  "query",
  "public",
  { now: number },
  DashboardSummary
>;

// SAFETY: same `anyApi` `any`-typed reference as `summaryQuery` above.
const libraryRows = anyApi.library.rows as FunctionReference<
  "query",
  "public",
  Record<string, never>,
  { rows: AccountLibraryRow[]; truncated: boolean }
>;

// SAFETY: same `anyApi` `any`-typed reference as `summaryQuery` above.
const libraryHistory = anyApi.library.history as FunctionReference<
  "query",
  "public",
  { accountId: Id<"accounts"> },
  { jobId: Id<"jobs">; dismissedAt?: number }[]
>;

async function setup() {
  const t = convexTest(schema, modules);

  // Verified email lives on the `users` row (`emailVerificationTime`), never
  // on the identity/JWT `email` claim — convex/access.ts `requireOperator`
  // only ever trusts the row (CodeRabbit #4089340875, CWE-863).
  const alice = await t.run((ctx) =>
    ctx.db.insert("users", {
      isAnonymous: false,
      email: "alice@test.xearch",
      emailVerificationTime: Date.now(),
    }),
  );

  const bob = await t.run((ctx) =>
    ctx.db.insert("users", {
      isAnonymous: false,
      email: "bob@test.xearch",
      emailVerificationTime: Date.now(),
    }),
  );

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
  it("keeps older active failures visible when newer finished runs fill the page", async () => {
    const { t, alice, a } = await setup();
    const failed = await insertJob(t, alice, { input: "failed", status: "failed" });
    const partial = await insertJob(t, alice, { input: "partial", status: "partial" });

    for (let i = 0; i < 101; i++)
      await insertJob(t, alice, { input: `finished-${i}`, status: "complete" });

    const ordinary = await a.query(api.jobs.list, { limit: 100 });
    expect(ordinary.jobs.some((job) => job._id === failed)).toBe(false);

    const prioritized = await a.query(api.jobs.list, { limit: 100, activeFirst: true });
    expect(prioritized.jobs.slice(0, 2).map((job) => job._id)).toEqual([partial, failed]);
    expect(prioritized.jobs).toHaveLength(100);
  });

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

    const feed = (await a.query(api.jobs.list, {})).jobs;
    expect(feed.map((job) => job._id)).toEqual([kept]);

    const after = await a.query(summaryQuery, { now: Date.now() });
    expect(after.queue.failedRetryable).toEqual({ kind: "known", unit: "jobs", value: 1 });

    // Nothing was deleted: the run and its durable receipt are both intact,
    // and asking for dismissed rows brings it straight back.
    expect(await t.run((ctx) => ctx.db.get(failed))).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.query("receipts").collect())).toHaveLength(1);
    const withDismissed = (await a.query(api.jobs.list, { includeDismissed: true })).jobs;
    expect(withDismissed.map((job) => job._id).sort()).toEqual([failed, kept].sort());
  });

  it("restores a dismissed run", async () => {
    const { t, alice, a } = await setup();
    const job = await insertJob(t, alice, { input: "@theo", status: "failed" });
    await a.mutation(api.jobs.dismiss, { jobId: job });
    expect((await a.query(api.jobs.list, {})).jobs).toHaveLength(0);
    await a.mutation(api.jobs.restore, { jobId: job });
    expect((await a.query(api.jobs.list, {})).jobs).toHaveLength(1);
  });

  it("refuses to dismiss work that is still running, so a run can never be hidden while it is still spending provider allowance", async () => {
    const { t, alice, a } = await setup();
    const running = await insertJob(t, alice, { input: "@theo", status: "running" });
    const queued = await insertJob(t, alice, { input: "@other", status: "queued" });
    await expect(a.mutation(api.jobs.dismiss, { jobId: running })).rejects.toThrow("Stop this run");
    await expect(a.mutation(api.jobs.dismiss, { jobId: queued })).rejects.toThrow("Stop this run");
  });

  it("lets any signed-in person dismiss a run someone else started — imports are shared, not personal", async () => {
    const { t, alice, b } = await setup();
    const job = await insertJob(t, alice, { input: "@theo", status: "failed" });
    await b.mutation(api.jobs.dismiss, { jobId: job });
    expect((await t.run((ctx) => ctx.db.get(job)))?.dismissedAt).toBeTypeOf("number");
  });

  it("still refuses an unauthenticated caller entirely", async () => {
    const { t, alice } = await setup();
    const job = await insertJob(t, alice, { input: "@theo", status: "failed" });
    await expect(t.mutation(api.jobs.dismiss, { jobId: job })).rejects.toThrow();
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

describe("dismissInput (clearing a whole duplicate group at once)", () => {
  // Regression: a client that only knows the ids on its current page of
  // `jobs.list` (JOB_FEED_LIMIT, currently 20) can't dismiss what it never
  // loaded — found on commit 4144bcd, which dismissed by a client-collected
  // id list and left anything past the first page behind. `dismissInput`
  // walks every job for the exact (kind, input) server-side instead, so the
  // count dismissed is never limited by what any one page returned.
  it("dismisses every terminal run of the same kind+input, however many there are, and never touches a running one", async () => {
    const { t, alice, a } = await setup();
    const DUPLICATE_COUNT = 25;

    const ids = await Promise.all(
      Array.from({ length: DUPLICATE_COUNT }, (_, i) =>
        insertJob(t, alice, {
          input: "@theo",
          kind: "live",
          status: i % 2 === 0 ? "failed" : "complete",
        }),
      ),
    );

    // A currently-active run for the exact same input must survive: hiding
    // it would make it unstoppable from the UI while it still spends
    // provider allowance (the same guard `jobs.dismiss` applies).
    const running = await insertJob(t, alice, { input: "@theo", kind: "live", status: "running" });

    // A different input/kind must be untouched by this call.
    const other = await insertJob(t, alice, { input: "@convex", kind: "live", status: "failed" });

    const dismissedCount = await a.mutation(api.jobs.dismissInput, {
      kind: "live",
      input: "@theo",
    });

    expect(dismissedCount).toBe(DUPLICATE_COUNT);

    for (const id of ids) {
      const job = await t.run((ctx) => ctx.db.get(id));

      expect(job?.dismissedAt).toBeDefined();
    }

    const stillRunning = await t.run((ctx) => ctx.db.get(running));

    expect(stillRunning?.dismissedAt).toBeUndefined();

    const untouched = await t.run((ctx) => ctx.db.get(other));

    expect(untouched?.dismissedAt).toBeUndefined();

    // Nothing was deleted — same contract as the single-job `dismiss`.
    expect(await t.run((ctx) => ctx.db.query("jobs").collect())).toHaveLength(DUPLICATE_COUNT + 2);
  });

  it("refuses an anonymous (non-operator) caller", async () => {
    const { t, alice } = await setup();

    await insertJob(t, alice, { input: "@theo", kind: "live", status: "failed" });
    const anon = await t.run((ctx) => ctx.db.insert("users", { isAnonymous: true }));
    const guest = t.withIdentity({ subject: `${anon}|session` });

    await expect(
      guest.mutation(api.jobs.dismissInput, { kind: "live", input: "@theo" }),
    ).rejects.toThrow();
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

    // Every other spelling normalizes to that same stored string, so each
    // one comes back as the run already in flight rather than opening a
    // second row for the same search. Getting the same id back IS the proof
    // they canonicalized: nothing else could return it.
    //
    // This used to throw "already active" at the person instead. Being shown
    // an error for retyping a search you just ran is not a guarantee worth
    // keeping — see jobs.ts REPEAT_WINDOW_MS.
    for (const spelling of ["@Theo", "@theo", "from:@theo"]) {
      expect(await a.mutation(api.jobs.start, { kind: "live", input: spelling })).toBe(first);
    }

    expect(await t.run(async (ctx) => (await ctx.db.query("jobs").collect()).length)).toBe(1);
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

describe("the imported corpus is shared across owners", () => {
  it("lets a different signed-in user see and continue a bulk import someone else started", async () => {
    const { t, alice, b } = await setup();

    const accountId = await t.run((ctx) =>
      ctx.db.insert("accounts", { handle: "theo", userId: "1", name: "Theo" }),
    );

    const job = await insertJob(t, alice, { input: "theo", kind: "bulk", status: "complete" });
    await t.run((ctx) =>
      ctx.db.patch(job, {
        expectedUserId: "1",
        nextUntil: "2025-01-01T00:00:00.000Z",
      }),
    );

    // bob (a different anonymous user) sees alice's job in the shared feed —
    // jobs are shared infrastructure, not personal data.
    const feed = (await b.query(api.jobs.list, {})).jobs;
    expect(feed.map((j) => j._id)).toContain(job);

    // ...and in the account library, same as alice would.
    const library = (await b.query(libraryRows, {})).rows;
    expect(library.map((r) => r.accountId)).toContain(accountId);

    // ...and can pick up the same import without hitting "Continuation does
    // not belong to this indexing job" — that check no longer looks at who
    // started the run it continues.
    vi.stubEnv("X_MD_API_KEY", "test");
    vi.stubEnv("RAW_CAPTURE_URL", "http://127.0.0.1:4319/captures");
    vi.stubEnv("COLLECTOR_MODE", "receiver");

    const next = await b.mutation(api.jobs.start, {
      kind: "bulk",
      input: "theo",
      previous: job,
    });

    expect(next).not.toBe(job);
  });
});
