import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import type { FunctionReference } from "convex/server";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
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
const applyUpdate = anyApi.publication.applyUpdate as FunctionReference<
  "mutation",
  "internal",
  {
    version: 1;
    providerAccountId?: string;
    handle: string;
    captureIds: string[];
    generation: number;
    reportedState: "indexing" | "searchable" | "failed";
    uniquePostCount?: number;
    uniquePostCountAsOf?: number;
    observedAt: number;
  },
  { outcome: string; rejectionReason?: string }
>;

// SAFETY: same `anyApi` `any`-typed reference as `summaryQuery` above.
const libraryHistory = anyApi.library.history as FunctionReference<
  "query",
  "public",
  { accountId: Id<"accounts"> },
  { jobId: Id<"jobs">; dismissedAt?: number }[]
>;

// SAFETY: same `anyApi` `any`-typed reference as `summaryQuery` above.
const libraryRows = anyApi.library.rows as FunctionReference<
  "query",
  "public",
  Record<string, never>,
  { rows: AccountLibraryRow[]; truncated: boolean }
>;

async function setup() {
  const t = convexTest(schema, modules);
  const alice = await t.run((ctx) => ctx.db.insert("users", { isAnonymous: true }));

  return { t, alice, a: t.withIdentity({ subject: `${alice}|session` }) };
}

function job(
  t: Awaited<ReturnType<typeof setup>>["t"],
  owner: Id<"users">,
  args: {
    input: string;
    kind?: Doc<"jobs">["kind"];
    status?: Doc<"jobs">["status"];
    dismissedAt?: number;
    expectedUserId?: string;
  },
) {
  return t.run((ctx) =>
    ctx.db.insert("jobs", {
      owner,
      kind: args.kind ?? "live",
      input: args.input,
      expectedUserId: args.expectedUserId,
      refresh: false,
      status: args.status ?? "complete",
      count: 0,
      attempt: 1,
      warnings: [],
      dismissedAt: args.dismissedAt,
      updatedAt: Date.now(),
    }),
  );
}

describe("the job feed filters before it limits", () => {
  it("still returns a full page of live runs when more than a page of newer account imports exist", async () => {
    const { t, alice, a } = await setup();

    // 25 account imports, all newer than the live runs below. Filtering the
    // kind client-side after a 20-row page would have returned nothing.
    for (let i = 0; i < 25; i++) await job(t, alice, { input: `acct${i}`, kind: "bulk" });

    for (let i = 0; i < 20; i++) await job(t, alice, { input: `@live${i}`, kind: "live" });

    const other = await a.query(api.jobs.list, { scope: "other" });
    expect(other).toHaveLength(20);
    expect(other.every((row) => row.kind !== "bulk")).toBe(true);
  });

  it("still returns a full page when more than a page of newer runs were cleared", async () => {
    const { t, alice, a } = await setup();

    for (let i = 0; i < 25; i++)
      await job(t, alice, { input: `@old${i}`, kind: "live", dismissedAt: undefined });

    for (let i = 0; i < 30; i++)
      await job(t, alice, { input: `@cleared${i}`, kind: "live", dismissedAt: Date.now() });

    const visible = await a.query(api.jobs.list, {});
    expect(visible).toHaveLength(20);
    expect(visible.every((row) => row.dismissedAt === undefined)).toBe(true);
  });
});

describe("duplicate rows for one provider id", () => {
  it("resolve to the same single account on the write path and both read paths", async () => {
    const { t, alice, a } = await setup();

    // Two legacy rows carrying the SAME provider id — duplicates of one
    // account, not two identities. Before the fix the write path patched one
    // while both read paths called it ambiguous, so the account vanished
    // from the library and from the owner's totals.
    const [first, second] = await t.run(async (ctx) => [
      await ctx.db.insert("accounts", { handle: "dup", userId: "42", name: "First Row" }),
      await ctx.db.insert("accounts", { handle: "dup", userId: "42", name: "Second Row" }),
    ]);

    await job(t, alice, { input: "dup", kind: "bulk", expectedUserId: "42" });
    await t.run((ctx) =>
      ctx.db.insert("accountPublications", {
        accountId: first,
        state: "searchable",
        committedGeneration: 1,
        searchablePostCount: 12,
        updatedAt: Date.now(),
      }),
    );

    const rows = (await a.query(libraryRows, {})).rows;
    expect(rows).toHaveLength(1);
    // The canonical row is the oldest, which is where the publication sits.
    expect(String(rows[0].accountId)).toBe(String(first));
    expect(String(rows[0].accountId)).not.toBe(String(second));

    const summary = await a.query(summaryQuery, { now: Date.now() });
    expect(summary.indexedAccounts).toEqual({ kind: "known", unit: "accounts", value: 1 });
    expect(summary.indexedPosts).toEqual({ kind: "known", unit: "posts", value: 12 });
  });

  it("keeps two DIFFERENT provider ids sharing a handle ambiguous rather than picking one", async () => {
    const { t, alice, a } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("accounts", { handle: "moved", userId: "111", name: "One" });
      await ctx.db.insert("accounts", { handle: "moved", userId: "222", name: "Two" });
    });
    // No pinned provider id, so this falls back to the handle — which two
    // real people have held. That genuinely cannot be resolved.
    await job(t, alice, { input: "moved", kind: "bulk" });
    expect((await a.query(libraryRows, {})).rows).toEqual([]);
  });
});

describe("the publication receiver and the library agree on identity", () => {
  it("applies an update for an account that has a duplicate row, instead of rejecting it forever", async () => {
    const { t, alice, a } = await setup();

    const [canonical] = await t.run(async (ctx) => [
      await ctx.db.insert("accounts", { handle: "dup", userId: "42", name: "First Row" }),
      await ctx.db.insert("accounts", { handle: "dup", userId: "42", name: "Second Row" }),
    ]);

    await job(t, alice, { input: "dup", kind: "bulk", expectedUserId: "42" });

    // The receiver used to call two rows for one provider id ambiguous and
    // answer rejected_invalid, while the library happily showed the account.
    // That account would have sat at "waiting for indexing" forever while
    // the indexer collected 422s.
    const applied = await t.mutation(applyUpdate, {
      version: 1,
      providerAccountId: "42",
      handle: "dup",
      captureIds: ["cap-1"],
      generation: 1,
      reportedState: "searchable",
      uniquePostCount: 7,
      uniquePostCountAsOf: Date.now(),
      observedAt: Date.now(),
    });

    expect(applied).toMatchObject({ outcome: "applied" });

    // It landed on the canonical row, which is the one the library shows.
    const rows = (await a.query(libraryRows, {})).rows;
    expect(rows).toHaveLength(1);
    expect(String(rows[0].accountId)).toBe(String(canonical));
    expect(rows[0].publicationState).toBe("searchable");
    expect(rows[0].searchablePostCount).toEqual({ kind: "known", unit: "posts", value: 7 });
  });
});

describe("bounded reads never pass as complete data", () => {
  it("reports unknown queue counts once the owner has more jobs than one read covers", async () => {
    const { t, alice, a } = await setup();

    // One past the 1,000-job bound `allJobs` reads. Every queue figure is
    // derived from that page, so a "known" count here would be a partial
    // presented as a total.
    for (let i = 0; i < 1001; i++)
      await job(t, alice, { input: `@q${i}`, kind: "live", status: "failed" });

    const summary = await a.query(summaryQuery, { now: Date.now() });
    expect(summary.queue.failedRetryable).toEqual({ kind: "unknown", unit: "jobs" });
    expect(summary.queue.waitingDownloads).toEqual({ kind: "unknown", unit: "jobs" });
    expect(summary.queue.activeDownloads).toEqual({ kind: "unknown", unit: "jobs" });
    expect(summary.queue.savedCapturesAwaitingIndexing).toEqual({
      kind: "unknown",
      unit: "captures",
    });
  });

  it("tells the caller when the account library itself is only a page", async () => {
    const { t, alice, a } = await setup();
    const small = await a.query(libraryRows, {});
    expect(small.truncated).toBe(false);

    // One past the 500 account-import bound.
    for (let i = 0; i < 501; i++)
      await job(t, alice, { input: `acct${i}`, kind: "bulk", expectedUserId: `${i}` });

    const capped = await a.query(libraryRows, {});
    expect(capped.truncated).toBe(true);
  });
});

describe("a caller is never refused an account that genuinely exists", () => {
  it("serves history for an account older than the bounded library page", async () => {
    const { t, alice, a } = await setup();

    const accountId = await t.run((ctx) =>
      ctx.db.insert("accounts", { handle: "oldest", userId: "9001", name: "Oldest" }),
    );

    // The account's own run goes in FIRST, so 600 newer imports push it well
    // outside the 500-job page the library lists.
    const ownRun = await job(t, alice, {
      input: "oldest",
      kind: "bulk",
      expectedUserId: "9001",
      status: "failed",
    });

    for (let i = 0; i < 600; i++)
      await job(t, alice, { input: `later${i}`, kind: "bulk", expectedUserId: `${i}` });

    // It is genuinely outside the page the library returns...
    const library = await a.query(libraryRows, {});
    expect(library.truncated).toBe(true);
    expect(library.rows.some((row) => String(row.accountId) === String(accountId))).toBe(false);

    // ...but it is still the owner's account, so its history must open.
    const runs = await a.query(libraryHistory, { accountId });
    expect(runs).toHaveLength(1);
    expect(String(runs[0].jobId)).toBe(String(ownRun));
  });

  it("refuses to serve a history it could not search through completely", async () => {
    const { t, alice, a } = await setup();

    const accountId = await t.run((ctx) =>
      ctx.db.insert("accounts", { handle: "buried", userId: "8888", name: "Buried" }),
    );

    // A run for this account exists, but far enough down that the scan
    // cannot reach it. The lookup therefore returns some jobs with
    // exhausted:false for OTHER accounts — and the account's own run may be
    // among the ones never reached. Presenting what was found as the
    // account's history would be a partial scan wearing a complete label.
    await job(t, alice, {
      input: "buried",
      kind: "bulk",
      expectedUserId: "8888",
      status: "complete",
    });

    for (let i = 0; i < 1100; i++)
      await job(t, alice, { input: "buried", kind: "bulk", expectedUserId: "8888" });

    await expect(a.query(libraryHistory, { accountId })).rejects.toThrow("full history");
  });

  it("serves an account's history to a different signed-in caller too — imports are shared, not owned", async () => {
    const { t, alice } = await setup();
    const bob = await t.run((ctx) => ctx.db.insert("users", { isAnonymous: true }));
    const b = t.withIdentity({ subject: `${bob}|session` });

    const accountId = await t.run((ctx) =>
      ctx.db.insert("accounts", { handle: "alices", userId: "4242", name: "Alice's" }),
    );

    const run = await job(t, alice, { input: "alices", kind: "bulk", expectedUserId: "4242" });
    const runs = await b.query(libraryHistory, { accountId });
    expect(runs.map((r) => String(r.jobId))).toEqual([String(run)]);
  });
});

describe("a capture the indexer could not index", () => {
  it("stays counted as awaiting indexing instead of being marked confirmed", async () => {
    const { t, alice, a } = await setup();

    const accountId = await t.run((ctx) =>
      ctx.db.insert("accounts", { handle: "flaky", userId: "321", name: "Flaky" }),
    );

    const bulk = await job(t, alice, {
      input: "flaky",
      kind: "bulk",
      expectedUserId: "321",
      status: "complete",
    });

    await t.run(async (ctx) => {
      await ctx.db.insert("receipts", {
        jobId: bulk,
        captureId: "cap-failed",
        receiptId: "r1",
        records: 10,
      });
      // The indexer reported that it could NOT index this capture. Applied,
      // so it moved the account's state — but it confirms nothing.
      await ctx.db.insert("publicationUpdates", {
        accountId,
        handle: "flaky",
        captureIds: ["cap-failed"],
        generation: 1,
        reportedState: "failed",
        error: { message: "index write failed" },
        observedAt: Date.now(),
        receivedAt: Date.now(),
        outcome: "applied",
      });
    });

    const summary = await a.query(summaryQuery, { now: Date.now() });
    expect(summary.queue.savedCapturesAwaitingIndexing).toEqual({
      kind: "known",
      unit: "captures",
      value: 1,
    });
  });
});

describe("a capped account scope", () => {
  it("reports unknown rather than presenting the part it could read as the whole", async () => {
    const { t, alice, a } = await setup();

    // One past the 500 cap allAccountJobs reads.
    for (let i = 0; i < 501; i++)
      await job(t, alice, { input: `acct${i}`, kind: "bulk", expectedUserId: `${i}` });

    const summary = await a.query(summaryQuery, { now: Date.now() });
    expect(summary.indexedPosts).toEqual({ kind: "unknown", unit: "posts" });
    expect(summary.indexedAccounts).toEqual({ kind: "unknown", unit: "accounts" });
    // The scope literal still claims the whole shared corpus, which is
    // exactly why the counts must not claim to be complete.
    expect(summary.scope).toEqual({ kind: "global" });
  });
});
