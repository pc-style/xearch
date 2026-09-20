import { describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { anyApi, getFunctionName } from "convex/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import schema from "../convex/schema";
import type { Id } from "../convex/_generated/dataModel";
import type { AccountLibraryRow } from "../convex/lib/contracts";
import type { ServiceStatus } from "../convex/summary";
import OverviewStats from "../src/library/OverviewStats";

/**
 * Workflow-run evidence for to-do.md's acceptance check: "Test the
 * screenshot's partial/failing imports, successful imports, empty corpus,
 * failed refresh with existing indexed posts, and stale/offline services."
 *
 * Each case drives the REAL Convex queries (convex/library.ts rows/history,
 * convex/summary.ts summary/health) against a local convex-test in-memory
 * deployment seeded here, then feeds the REAL return value into the REAL UI
 * component (AccountRow / OverviewStats) via react-dom/server, and prints
 * what actually came out. AccountRow calls useQuery/useMutation (convex/
 * react) directly with no ConvexProvider in this render, so — same as
 * tests/scenario-publication-lifecycle.test.ts and tests/library-ui.test.ts
 * — convex/react is mocked to route by function name to a response this
 * test already fetched from the real backend above; nothing here fabricates
 * data the backend did not actually return. This does not touch search/
 * (Rust) or anything Pronsh owns, and does not implement any indexer/
 * watcher/registry. No paid import, no live coordination, nothing merged or
 * deployed.
 */

const mockState = vi.hoisted(() => ({ responses: new Map<string, unknown>() }));
vi.mock("convex/react", () => ({
  useQuery: (ref: unknown, args: unknown) => {
    if (args === "skip") return undefined;
    return mockState.responses.get(getFunctionName(ref as any));
  },
  useMutation: () => vi.fn().mockResolvedValue(undefined),
}));
const AccountRow = (await import("../src/library/AccountRow")).default;

const modules = import.meta.glob("../convex/**/*.ts");
const libraryRows = anyApi.library.rows;
const libraryHistory = anyApi.library.history;
const summaryQ = anyApi.summary.summary;
const healthQ = anyApi.summary.health;

function renderRow(row: AccountLibraryRow): string {
  return renderToStaticMarkup(createElement(AccountRow, { row } as any));
}

async function seedOwner(t: ReturnType<typeof convexTest>) {
  const owner: Id<"users"> = await t.run((ctx) => ctx.db.insert("users", { isAnonymous: true }));
  return { owner, session: t.withIdentity({ subject: `${owner}|session` }) };
}

describe("scenario: screenshot cases render an explicit, correct, non-contradictory state with a next action", () => {
  it("case 1: partial/failing import — retained progress shown, real failure surfaced, next action is retry", async () => {
    const t = convexTest(schema, modules);
    const { owner, session } = await seedOwner(t);
    await t.run((ctx) => ctx.db.insert("accounts", { handle: "bob", userId: "222", name: "Bob" }));
    const jobId = await t.run((ctx) =>
      ctx.db.insert("jobs", {
        owner,
        kind: "bulk",
        input: "bob",
        expectedUserId: "222",
        refresh: false,
        status: "failed",
        count: 340,
        attempt: 2,
        warnings: [],
        phase: "Saving raw capture", // stale leftover in-progress phase — must not be shown as the outcome
        error: "x.md returned a malformed history page after 340 posts.",
        updatedAt: Date.now(),
      }),
    );

    const rows = (await session.query(libraryRows, {})).rows;
    console.log("CASE1 library.rows:", JSON.stringify(rows));
    expect(rows).toHaveLength(1);
    expect(rows[0].publicationState).toBe("waiting_for_indexing"); // no publication update ever arrived
    expect(rows[0].latestJob).toMatchObject({ jobId, status: "failed" });
    expect(rows[0].nextAction).toEqual({ kind: "retry", jobId });

    // AccountRow fetches convex/library.ts `history` itself (needed here
    // since job.status === "failed" makes needsFailureDetail true) — pull
    // the REAL result from the real query and feed exactly that into the
    // mocked convex/react useQuery below (see file header comment).
    const history = await session.query(libraryHistory, { accountId: rows[0].accountId });
    console.log("CASE1 real library.history:", JSON.stringify(history));
    mockState.responses = new Map([[getFunctionName(libraryHistory as any), history]]);

    const html = renderRow(rows[0]);
    console.log("CASE1 UI contains the real error text:", html.includes("x.md returned a malformed history page after 340 posts."));
    console.log("CASE1 UI contains retained-count text:", html.includes("340 records retained"));
    console.log("CASE1 UI contains stale leftover phase 'Saving raw capture' as the outcome (should NOT):", html.includes("Saving raw capture"));
    console.log("CASE1 UI contains Retry action:", html.includes(">Retry<"));
    expect(html).toContain("x.md returned a malformed history page after 340 posts.");
    expect(html).toContain("340 records retained");
    expect(html).not.toContain("Saving raw capture");
    expect(html).toContain(">Retry<");
  });

  it("case 2: successful import — searchable, real count, no next action needed", async () => {
    mockState.responses = new Map();
    const t = convexTest(schema, modules);
    const { owner, session } = await seedOwner(t);
    const accountId = await t.run((ctx) =>
      ctx.db.insert("accounts", { handle: "carol", userId: "333", name: "Carol" }),
    );
    const jobId = await t.run((ctx) =>
      ctx.db.insert("jobs", {
        owner,
        kind: "bulk",
        input: "carol",
        expectedUserId: "333",
        refresh: false,
        status: "complete",
        count: 512,
        attempt: 1,
        warnings: [],
        updatedAt: Date.now(),
      }),
    );
    await t.run((ctx) =>
      ctx.db.insert("accountPublications", {
        accountId,
        state: "searchable",
        committedGeneration: 1,
        searchablePostCount: 512,
        searchablePostCountAsOf: Date.now(),
        lastPublishedAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    const rows = (await session.query(libraryRows, {})).rows;
    console.log("CASE2 library.rows:", JSON.stringify(rows));
    expect(rows).toHaveLength(1);
    expect(rows[0].publicationState).toBe("searchable");
    expect(rows[0].searchablePostCount).toEqual({ kind: "known", unit: "posts", value: 512 });
    expect(rows[0].latestJob?.jobId).toBe(jobId);
    expect(rows[0].nextAction).toEqual({ kind: "none" });

    const html = renderRow(rows[0]);
    console.log("CASE2 UI contains 'Searchable':", html.includes("Searchable"));
    console.log("CASE2 UI contains real count '512':", html.includes("512 posts"));
    console.log("CASE2 UI contains a contradictory failure line (should NOT):", html.includes("library-row-failure"));
    expect(html).toContain("Searchable");
    expect(html).toContain("512 posts");
    expect(html).not.toContain("library-row-failure");
  });

  it("case 3: empty corpus — real zero from summary, empty account list, no invented numbers", async () => {
    const t = convexTest(schema, modules);
    const { session } = await seedOwner(t);
    const now = Date.now();

    const rows = (await session.query(libraryRows, {})).rows;
    console.log("CASE3 library.rows (no imports at all):", JSON.stringify(rows));
    expect(rows).toEqual([]);

    const summary = await session.query(summaryQ, { now });
    console.log("CASE3 summary.summary on a truly empty DB:", JSON.stringify(summary));
    // A real, checked zero — not "unknown", since the DB genuinely has no
    // accountPublications/jobs rows to sum. See convex/summary.ts's own
    // "known 0 vs unknown" rule.
    expect(summary.indexedPosts).toEqual({ kind: "known", unit: "posts", value: 0 });
    expect(summary.indexedAccounts).toEqual({ kind: "known", unit: "accounts", value: 0 });
    expect(summary.queue).toEqual({
      waitingDownloads: { kind: "known", unit: "jobs", value: 0 },
      activeDownloads: { kind: "known", unit: "jobs", value: 0 },
      savedCapturesAwaitingIndexing: { kind: "known", unit: "captures", value: 0 },
      failedRetryable: { kind: "known", unit: "jobs", value: 0 },
    });
  });

  it("case 4: failed refresh on an account that still has indexed posts — old corpus stays visible, does not regress, distinguished from a currently-searchable account", async () => {
    mockState.responses = new Map();
    const t = convexTest(schema, modules);
    const { owner, session } = await seedOwner(t);
    const accountId = await t.run((ctx) =>
      ctx.db.insert("accounts", { handle: "dana", userId: "444", name: "Dana" }),
    );
    const jobId = await t.run((ctx) =>
      ctx.db.insert("jobs", {
        owner,
        kind: "bulk",
        input: "dana",
        expectedUserId: "444",
        refresh: true,
        status: "complete", // the download itself succeeded; indexing is what failed
        count: 10,
        attempt: 2,
        warnings: [],
        updatedAt: Date.now(),
      }),
    );
    const failedAt = Date.now();
    await t.run((ctx) =>
      ctx.db.insert("accountPublications", {
        accountId,
        state: "failed", // latest publication attempt failed
        committedGeneration: 2,
        searchablePostCount: 950, // sticky: last confirmed searchable count from BEFORE this failure
        searchablePostCountAsOf: failedAt - 86_400_000,
        lastPublishedAt: failedAt - 86_400_000,
        lastError: { message: "indexer rejected generation 2: schema mismatch", observedAt: failedAt, generation: 2 },
        updatedAt: failedAt,
      }),
    );

    const rows = (await session.query(libraryRows, {})).rows;
    console.log("CASE4 library.rows:", JSON.stringify(rows));
    expect(rows).toHaveLength(1);
    expect(rows[0].publicationState).toBe("failed");
    expect(rows[0].searchablePostCount).toEqual({ kind: "known", unit: "posts", value: 950 });
    expect(rows[0].lastError?.message).toBe("indexer rejected generation 2: schema mismatch");

    const html = renderRow(rows[0]);
    console.log(
      "CASE4 UI keeps the old corpus visible alongside the failure:",
      html.includes("The previously confirmed index still has 950 posts"),
    );
    console.log("CASE4 UI shows the real failure reason:", html.includes("indexer rejected generation 2: schema mismatch"));
    console.log("CASE4 UI still labels state 'Publication failed', not 'Searchable':", html.includes("Publication failed"), !html.includes(">Searchable<"));
    expect(html).toContain("The previously confirmed index still has 950 posts");
    expect(html).toContain("indexer rejected generation 2: schema mismatch");
    expect(html).toContain("Publication failed");

    // The account-level summary must reflect the non-regression guarantee:
    // the 950 posts still count toward indexedPosts (they are still really
    // searchable server-side), but this account no longer counts toward
    // indexedAccounts (its CURRENT state is not "searchable").
    const summary = await session.query(summaryQ, { now: Date.now() });
    console.log("CASE4 summary.summary reflects sticky posts but not a current account:", JSON.stringify(summary));
    expect(summary.indexedPosts).toEqual({ kind: "known", unit: "posts", value: 950 });
    expect(summary.indexedAccounts).toEqual({ kind: "known", unit: "accounts", value: 0 });
    void jobId;
  });

  it("case 5: stale/offline services — a stale heartbeat never reads as fresh-healthy, and no report ever reads as a live zero", async () => {
    const t = convexTest(schema, modules);
    const { session } = await seedOwner(t);
    const observedAt = Date.now() - 20 * 60_000; // 20 minutes old
    await t.run((ctx) =>
      ctx.db.insert("serviceHealth", {
        service: "indexer",
        healthy: true, // was healthy at last observation...
        lastHeartbeatAt: observedAt,
        lastSuccessAt: observedAt,
        observedAt,
      }),
    );
    await t.run((ctx) =>
      ctx.db.insert("serviceHealth", {
        service: "receiver",
        healthy: false,
        lastHeartbeatAt: Date.now(),
        observedAt: Date.now(),
        lastError: { message: "connection refused", observedAt: Date.now() },
      }),
    );
    // "search" has no serviceHealth row at all — genuinely unknown.

    const now = Date.now(); // far enough past observedAt to cross SERVICE_STALE_AFTER_MS (5 min)
    const health = (await session.query(healthQ, { now })) as ServiceStatus[];
    console.log("CASE5 summary.health:", JSON.stringify(health));
    const indexer = health.find((h) => h.service === "indexer");
    const receiver = health.find((h) => h.service === "receiver");
    const search = health.find((h) => h.service === "search");
    expect(indexer).toMatchObject({ kind: "known", healthy: true, stale: true });
    expect(receiver).toMatchObject({ kind: "known", healthy: false, stale: false });
    expect(search).toEqual({ service: "search", kind: "unknown" });

    const html = renderToStaticMarkup(
      createElement(OverviewStats, {
        summary: undefined,
        health,
        limits: undefined,
        connected: false,
      } as any),
    );
    console.log("CASE5 UI shows stale caution text for indexer (not plain 'Healthy'):", html.includes("Stale reading from"));
    console.log("CASE5 UI does NOT claim the stale indexer is live-healthy:", !/indexer[^<]*Healthy(?!<\/summary)/i.test(html));
    console.log("CASE5 UI shows offline/disconnected receiver as Unhealthy:", html.includes("Unhealthy"));
    console.log("CASE5 UI shows honest 'no health report yet' for search, never a live zero:", html.includes("No health report received yet"));
    expect(html).toContain("Stale reading from");
    expect(html).toContain("treat with caution");
    expect(html).toContain("Unhealthy");
    expect(html).toContain("No health report received yet");
  });
});
