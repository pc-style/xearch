import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import type { FunctionReference } from "convex/server";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import type { AccountLibraryRow, DashboardSummary } from "../convex/lib/contracts";

const modules = import.meta.glob("../convex/**/*.ts");

const summaryQuery = anyApi.summary.summary as unknown as FunctionReference<
  "query",
  "public",
  { now: number },
  DashboardSummary
>;
const applyUpdate = anyApi.publication.applyUpdate as unknown as FunctionReference<
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
const libraryRows = anyApi.library.rows as unknown as FunctionReference<
  "query",
  "public",
  Record<string, never>,
  AccountLibraryRow[]
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

    const rows = await a.query(libraryRows, {});
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
    expect(await a.query(libraryRows, {})).toEqual([]);
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
    const rows = await a.query(libraryRows, {});
    expect(rows).toHaveLength(1);
    expect(String(rows[0].accountId)).toBe(String(canonical));
    expect(rows[0].publicationState).toBe("searchable");
    expect(rows[0].searchablePostCount).toEqual({ kind: "known", unit: "posts", value: 7 });
  });
});

describe("a capped account scope", () => {
  it("reports unknown rather than presenting the part it could read as the whole", async () => {
    const { t, alice, a } = await setup();
    // One past the 500 cap ownedAccountJobs reads.
    for (let i = 0; i < 501; i++)
      await job(t, alice, { input: `acct${i}`, kind: "bulk", expectedUserId: `${i}` });

    const summary = await a.query(summaryQuery, { now: Date.now() });
    expect(summary.indexedPosts).toEqual({ kind: "unknown", unit: "posts" });
    expect(summary.indexedAccounts).toEqual({ kind: "unknown", unit: "accounts" });
    // The scope literal still claims the owner's whole set, which is exactly
    // why the counts must not claim to be complete.
    expect(summary.scope).toEqual({ kind: "owner" });
  });
});
