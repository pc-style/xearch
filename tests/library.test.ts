import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

const modules = import.meta.glob("../convex/**/*.ts");

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
    a: t.withIdentity({ subject: `${alice}|session` }),
    b: t.withIdentity({ subject: `${bob}|session` }),
  };
}

type Kind = "bulk" | "live" | "post" | "profile" | "following" | "followers" | "archive";
type Status = "queued" | "running" | "complete" | "partial" | "failed" | "cancelled";

async function insertAccount(
  t: Awaited<ReturnType<typeof setup>>["t"],
  args: { handle: string; userId: string; name?: string; avatar?: string },
) {
  return t.run((ctx) =>
    ctx.db.insert("accounts", {
      handle: args.handle,
      userId: args.userId,
      name: args.name ?? args.handle,
      avatar: args.avatar,
    }),
  );
}

async function insertJob(
  t: Awaited<ReturnType<typeof setup>>["t"],
  owner: Id<"users">,
  args: {
    kind?: Kind;
    input: string;
    expectedUserId?: string;
    status?: Status;
    count?: number;
    postsReceived?: number;
    nextUntil?: string;
    nextCursor?: string;
    readyAt?: number;
    error?: string;
    phase?: string;
    attempt?: number;
    updatedAt?: number;
  },
) {
  return t.run((ctx) =>
    ctx.db.insert("jobs", {
      owner,
      kind: args.kind ?? "bulk",
      input: args.input,
      expectedUserId: args.expectedUserId,
      refresh: false,
      status: args.status ?? "complete",
      count: args.count ?? 0,
      postsReceived: args.postsReceived,
      nextUntil: args.nextUntil,
      nextCursor: args.nextCursor,
      readyAt: args.readyAt,
      error: args.error,
      phase: args.phase,
      attempt: args.attempt ?? 1,
      warnings: [],
      updatedAt: args.updatedAt ?? Date.now(),
    }),
  );
}

async function insertPublication(
  t: Awaited<ReturnType<typeof setup>>["t"],
  args: {
    accountId: Id<"accounts">;
    state: "downloaded" | "waiting_for_indexing" | "indexing" | "searchable" | "failed";
    committedGeneration?: number;
    searchablePostCount?: number;
    searchablePostCountAsOf?: number;
    lastPublishedAt?: number;
    lastError?: { message: string; observedAt: number; generation: number };
  },
) {
  return t.run((ctx) =>
    ctx.db.insert("accountPublications", {
      accountId: args.accountId,
      state: args.state,
      committedGeneration: args.committedGeneration ?? 1,
      searchablePostCount: args.searchablePostCount,
      searchablePostCountAsOf: args.searchablePostCountAsOf,
      lastPublishedAt: args.lastPublishedAt,
      lastError: args.lastError,
      updatedAt: Date.now(),
    }),
  );
}

describe("library.rows", () => {
  it("collapses repeated runs for one account into a single row", async () => {
    const { t, alice, a } = await setup();
    await insertAccount(t, { handle: "adam", userId: "1001", name: "Adam" });
    await insertJob(t, alice, {
      input: "adam",
      expectedUserId: "1001",
      status: "complete",
      updatedAt: 1_000,
    });
    await insertJob(t, alice, {
      input: "adam",
      expectedUserId: "1001",
      status: "failed",
      updatedAt: 2_000,
    });
    const latest = await insertJob(t, alice, {
      input: "adam",
      expectedUserId: "1001",
      status: "complete",
      updatedAt: 3_000,
    });
    const rows = (await a.query(api.library.rows, {})).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].handle).toBe("adam");
    expect(rows[0].latestJob?.jobId).toBe(latest);
    expect(rows[0].latestJob?.updatedAt).toBe(3_000);
  });

  it("never sums job/receipt counters into the unique searchable count, and reports unknown until a publication row exists", async () => {
    const { t, alice, a } = await setup();
    const accountId = await insertAccount(t, { handle: "big", userId: "2001" });
    // Overlapping captures/retries with large, differing raw counters.
    await insertJob(t, alice, {
      input: "big",
      expectedUserId: "2001",
      status: "complete",
      count: 5_000,
      postsReceived: 500,
      updatedAt: 1_000,
    });
    await insertJob(t, alice, {
      input: "big",
      expectedUserId: "2001",
      status: "complete",
      count: 5_500,
      postsReceived: 500,
      updatedAt: 2_000,
    });
    const beforePublication = (await a.query(api.library.rows, {})).rows;
    expect(beforePublication).toHaveLength(1);
    expect(beforePublication[0].searchablePostCount).toEqual({ kind: "unknown", unit: "posts" });
    expect(beforePublication[0].publicationState).toBe("waiting_for_indexing");

    await insertPublication(t, { accountId, state: "searchable", searchablePostCount: 137 });
    const afterPublication = (await a.query(api.library.rows, {})).rows;
    expect(afterPublication).toHaveLength(1);
    // Exactly the committed publication count, never 10_500 (summed count)
    // or 1_000 (summed postsReceived).
    expect(afterPublication[0].searchablePostCount).toEqual({
      kind: "known",
      unit: "posts",
      value: 137,
    });
  });

  it("excludes non-account imports (live/post/etc) from the indexed-people list", async () => {
    const { t, alice, a } = await setup();
    await insertAccount(t, { handle: "adam", userId: "1001" });
    await insertJob(t, alice, { input: "adam", expectedUserId: "1001", status: "complete" });
    await insertJob(t, alice, { kind: "live", input: "from:theo", status: "complete" });
    await insertJob(t, alice, {
      kind: "post",
      input: "https://x.com/adam/status/1",
      status: "complete",
    });
    await insertJob(t, alice, { kind: "followers", input: "adam", status: "complete" });
    const rows = (await a.query(api.library.rows, {})).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].handle).toBe("adam");
  });

  it("keeps a previously searchable account's state and count visible when its latest refresh fails", async () => {
    const { t, alice, a } = await setup();
    const accountId = await insertAccount(t, { handle: "adam", userId: "1001" });
    await insertPublication(t, {
      accountId,
      state: "searchable",
      searchablePostCount: 4_000,
      lastPublishedAt: 500,
    });
    await insertJob(t, alice, {
      input: "adam",
      expectedUserId: "1001",
      status: "complete",
      updatedAt: 1_000,
    });
    const failedRefresh = await insertJob(t, alice, {
      input: "adam",
      expectedUserId: "1001",
      status: "failed",
      error: "x.md returned a 500.",
      updatedAt: 2_000,
    });
    const rows = (await a.query(api.library.rows, {})).rows;
    expect(rows).toHaveLength(1);
    // Publication state is untouched by an acquisition-side job failure —
    // only an accepted publication update may move it (docs/publication-contract.md).
    expect(rows[0].publicationState).toBe("searchable");
    expect(rows[0].searchablePostCount).toEqual({ kind: "known", unit: "posts", value: 4_000 });
    expect(rows[0].lastPublishedAt).toBe(500);
    expect(rows[0].latestJob?.jobId).toBe(failedRefresh);
    expect(rows[0].latestJob?.status).toBe("failed");
    expect(rows[0].nextAction).toEqual({ kind: "retry", jobId: failedRefresh });
  });

  it("keeps a retained searchable count visible alongside a failed publication state (not just a failed job)", async () => {
    const { t, alice, a } = await setup();
    const accountId = await insertAccount(t, { handle: "adam", userId: "1001" });
    // The publication row itself is "failed" here (a rejected/erroring
    // publication update), distinct from "keeps a previously searchable
    // account's state and count visible when its latest refresh fails"
    // above, which only fails the acquisition job and leaves
    // accountPublications.state at "searchable". This is bullet 5's actual
    // claimed scenario: a previously committed searchable count must stay
    // visible next to the latest publication-side error, not just next to a
    // latest acquisition-side error.
    await insertPublication(t, {
      accountId,
      state: "failed",
      searchablePostCount: 2_500,
      lastError: { message: "publish rejected: schema mismatch", observedAt: 9_000, generation: 3 },
    });
    await insertJob(t, alice, {
      input: "adam",
      expectedUserId: "1001",
      status: "complete",
      updatedAt: 1_000,
    });
    const rows = (await a.query(api.library.rows, {})).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].publicationState).toBe("failed");
    expect(rows[0].searchablePostCount).toEqual({ kind: "known", unit: "posts", value: 2_500 });
    expect(rows[0].lastError).toEqual({
      message: "publish rejected: schema mismatch",
      observedAt: 9_000,
    });
  });

  // NOTE ON SCOPE: this proves library.ts's query-layer grouping never folds
  // two already-distinct `accounts` rows into one bucket, given rows that
  // exist independently (as the fixture inserts them directly). It does NOT
  // exercise convex/jobs.ts's `finish` account-upsert path, which is how
  // `accounts` rows actually get created/updated from a real run and where a
  // handle-reassignment merge could actually occur — see the scope note on
  // resolveAccount in convex/library.ts. That write-path gap is tracked in
  // to-do.md P0 and is out of scope for this file.
  it("given two pre-existing account rows for different provider ids that shared a handle at different times, keeps them as separate library rows", async () => {
    const { t, alice, a } = await setup();
    const oldAccount = await insertAccount(t, {
      handle: "renamed-away",
      userId: "1001",
      name: "Original",
    });
    const newAccount = await insertAccount(t, {
      handle: "adam",
      userId: "1002",
      name: "New owner",
    });
    await insertJob(t, alice, {
      input: "adam",
      expectedUserId: "1001",
      status: "complete",
      updatedAt: 1_000,
    });
    await insertJob(t, alice, {
      input: "adam",
      expectedUserId: "1002",
      status: "complete",
      updatedAt: 2_000,
    });
    const rows = (await a.query(api.library.rows, {})).rows;
    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((row) => [row.accountId, row]));
    expect(byId.get(oldAccount)?.name).toBe("Original");
    expect(byId.get(newAccount)?.name).toBe("New owner");
  });

  it("falls back to the normalized handle only when no provider id has ever been pinned", async () => {
    const { t, alice, a } = await setup();
    await insertAccount(t, { handle: "adam", userId: "1001" });
    // A run whose collectXmd attempt never reached pinIdentity: no
    // expectedUserId recorded on the job.
    await insertJob(t, alice, { input: "adam", status: "complete" });
    const rows = (await a.query(api.library.rows, {})).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].handle).toBe("adam");
  });

  it("drops a job whose identity cannot be resolved to any existing account row", async () => {
    const { t, alice, a } = await setup();
    await insertJob(t, alice, { input: "nobody-yet", status: "running" });
    const rows = (await a.query(api.library.rows, {})).rows;
    expect(rows).toHaveLength(0);
  });

  it("filters by status and by handle/name search, server-side", async () => {
    const { t, alice, a } = await setup();
    const searchableAccount = await insertAccount(t, {
      handle: "searchable-one",
      userId: "1001",
      name: "Findable",
    });
    const failedAccount = await insertAccount(t, { handle: "failed-one", userId: "1002" });
    await insertJob(t, alice, {
      input: "searchable-one",
      expectedUserId: "1001",
      status: "complete",
    });
    await insertJob(t, alice, { input: "failed-one", expectedUserId: "1002", status: "complete" });
    await insertPublication(t, {
      accountId: searchableAccount,
      state: "searchable",
      searchablePostCount: 10,
    });
    await insertPublication(t, { accountId: failedAccount, state: "failed" });

    const searchableOnly = (await a.query(api.library.rows, { status: "searchable" })).rows;
    expect(searchableOnly.map((r) => r.handle)).toEqual(["searchable-one"]);

    const byName = (await a.query(api.library.rows, { search: "findable" })).rows;
    expect(byName.map((r) => r.handle)).toEqual(["searchable-one"]);

    const byHandle = (await a.query(api.library.rows, { search: "FAILED-ONE" })).rows;
    expect(byHandle.map((r) => r.handle)).toEqual(["failed-one"]);
  });

  it("scopes rows to the requesting owner and renders empty without an identity", async () => {
    const { t, alice, b } = await setup();
    await insertAccount(t, { handle: "adam", userId: "1001" });
    await insertJob(t, alice, { input: "adam", expectedUserId: "1001", status: "complete" });
    expect((await b.query(api.library.rows, {})).rows).toHaveLength(0);
    // No identity is an auth transition on a live subscription, not a real
    // request: an empty library, never a thrown ConvexError error tracking
    // would file as an uncaught exception.
    expect(await t.query(api.library.rows, {})).toEqual({ rows: [], truncated: false });
  });
});

describe("library.history", () => {
  it("preserves every retry, batch, and failure record instead of collapsing or deleting them", async () => {
    const { t, alice, a } = await setup();
    const accountId = await insertAccount(t, { handle: "adam", userId: "1001" });
    const first = await insertJob(t, alice, {
      input: "adam",
      expectedUserId: "1001",
      status: "complete",
      count: 3,
      updatedAt: 1_000,
    });
    const failedRetry = await insertJob(t, alice, {
      input: "adam",
      expectedUserId: "1001",
      status: "failed",
      error: "timed out",
      updatedAt: 2_000,
    });
    const secondBatch = await insertJob(t, alice, {
      input: "adam",
      expectedUserId: "1001",
      status: "complete",
      count: 7,
      updatedAt: 3_000,
    });
    await t.run((ctx) =>
      ctx.db.insert("receipts", {
        jobId: first,
        captureId: "cap-1",
        receiptId: "receipt-1",
        records: 3,
      }),
    );
    const runs = await a.query(api.library.history, { accountId });
    expect(runs.map((r) => r.jobId)).toEqual([secondBatch, failedRetry, first]);
    expect(runs.find((r) => r.jobId === failedRetry)?.error).toBe("timed out");
    expect(runs.find((r) => r.jobId === first)?.receipts).toEqual([
      { captureId: "cap-1", receiptId: "receipt-1", records: 3 },
    ]);
  });

  it("does not reveal another owner's account history", async () => {
    const { t, alice, b } = await setup();
    const accountId = await insertAccount(t, { handle: "adam", userId: "1001" });
    await insertJob(t, alice, { input: "adam", expectedUserId: "1001", status: "complete" });
    await expect(b.query(api.library.history, { accountId })).rejects.toThrow("Account not found");
  });

  it("renders empty history without an identity instead of throwing the auth guard", async () => {
    const { t, alice } = await setup();
    const accountId = await insertAccount(t, { handle: "adam", userId: "1001" });
    await insertJob(t, alice, { input: "adam", expectedUserId: "1001", status: "complete" });
    // An auth transition on a live subscription: an empty list, not a thrown
    // ConvexError that error tracking would file as an uncaught exception.
    expect(await t.query(api.library.history, { accountId })).toEqual([]);
  });
});
