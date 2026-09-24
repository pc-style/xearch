import { describe, expect, it, vi, afterEach } from "vitest";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import schema from "../convex/schema";
import { PUBLICATION_STATE_META } from "../src/library/format";
import type { AccountLibraryRow } from "../convex/lib/contracts";

// AccountRow calls useQuery/useMutation (convex/react) directly, with no
// ConvexProvider in this render — mock the same way tests/library-ui.test.ts
// and the earlier proof.test.ts scratchpad do, so this stays a pure
// "what text does this component produce for this row" check, not a live
// Convex client test (that's covered by the query/mutation calls above it).
vi.mock("convex/react", () => ({
  useQuery: () => undefined,
  useMutation: () => vi.fn().mockResolvedValue(undefined),
}));

const AccountRow = (await import("../src/library/AccountRow")).default;

/**
 * Workflow-run scenario evidence for to-do.md's acceptance check:
 * "A downloaded capture with no publication update remains 'waiting for
 * indexing'. A later confirmed publication updates the dashboard without
 * reacquiring it ... Duplicate publication updates are idempotent, stale
 * updates cannot regress displayed state, and unauthorized application
 * requests fail closed."
 *
 * This does not touch search/ (Rust) or anything Pronsh owns. It drives
 * only this app's Convex receiver (convex/publication.ts), the
 * account-library read model (convex/library.ts), and the exact label the
 * UI renders for that state (src/library/format.tsx / AccountRow.tsx),
 * against a convex-test in-memory deployment. No paid import, no live
 * coordination, nothing merged or deployed.
 */

const modules = import.meta.glob("../convex/**/*.ts");

const applyUpdate = anyApi.publication.applyUpdate;

const libraryRows = anyApi.library.rows;

afterEach(() => {
  vi.unstubAllEnvs();
});

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    version: 1 as const,
    handle: "alice",
    providerAccountId: "111",
    captureIds: [] as string[],
    generation: 1,
    reportedState: "indexing" as const,
    observedAt: Date.now(),
    ...overrides,
  };
}

function renderedLabel(row: AccountLibraryRow): string {
  const html = renderToStaticMarkup(createElement(AccountRow, { row } as any));

  return html;
}

describe("scenario: downloaded -> waiting_for_indexing -> searchable, idempotency, staleness, auth", () => {
  it("runs the full lifecycle end to end and prints what the backend and UI actually did", async () => {
    const t = convexTest(schema, modules);

    // --- Seed: an account this user owns, with one completed acquisition
    // job (a "downloaded capture") and NO publication update yet. ---
    const owner = await t.run((ctx) => ctx.db.insert("users", { isAnonymous: true }));

    const accountId = await t.run((ctx) =>
      ctx.db.insert("accounts", { handle: "alice", userId: "111", name: "Alice" }),
    );

    const jobId = await t.run((ctx) =>
      ctx.db.insert("jobs", {
        owner,
        kind: "bulk",
        input: "alice",
        expectedUserId: "111",
        refresh: false,
        status: "complete",
        count: 500,
        attempt: 1,
        warnings: [],
        updatedAt: Date.now(),
      }),
    );

    await t.run((ctx) =>
      ctx.db.insert("receipts", { jobId, captureId: "cap1", receiptId: "r1", records: 500 }),
    );

    const session = t.withIdentity({ subject: `${owner}|session` });

    // --- Step 1: downloaded capture, no publication update -> waiting_for_indexing ---
    const rowsBefore = (await session.query(libraryRows, {})).rows;
    console.log("STEP1 library.rows:", JSON.stringify(rowsBefore));
    expect(rowsBefore).toHaveLength(1);
    expect(rowsBefore[0].publicationState).toBe("waiting_for_indexing");
    const uiBefore = renderedLabel(rowsBefore[0]);
    console.log(
      "STEP1 UI label present:",
      uiBefore.includes(PUBLICATION_STATE_META.waiting_for_indexing.label),
    );
    expect(uiBefore).toContain("Waiting for indexing");
    expect(await t.run((ctx) => ctx.db.query("accountPublications").collect())).toEqual([]);

    // --- Step 2: confirmed publication update -> searchable, no reacquisition ---
    const jobsBeforeUpdate = await t.run((ctx) => ctx.db.query("jobs").collect());

    const applied = await t.mutation(
      applyUpdate,
      envelope({
        generation: 1,
        reportedState: "searchable",
        uniquePostCount: 480,
        uniquePostCountAsOf: Date.now(),
      }),
    );

    console.log("STEP2 applyUpdate result:", JSON.stringify(applied));
    expect(applied).toEqual({ outcome: "applied", committedGeneration: 1 });

    const jobsAfterUpdate = await t.run((ctx) => ctx.db.query("jobs").collect());
    console.log(
      "STEP2 jobs unchanged (no reacquire):",
      JSON.stringify(jobsBeforeUpdate) === JSON.stringify(jobsAfterUpdate),
    );
    expect(jobsAfterUpdate).toEqual(jobsBeforeUpdate);

    const rowsAfter = (await session.query(libraryRows, {})).rows;
    console.log("STEP2 library.rows:", JSON.stringify(rowsAfter));
    expect(rowsAfter[0].publicationState).toBe("searchable");
    expect(rowsAfter[0].searchablePostCount).toEqual({ kind: "known", unit: "posts", value: 480 });
    const uiAfter = renderedLabel(rowsAfter[0]);
    expect(uiAfter).toContain("Searchable");

    // --- Step 3: the same update sent twice -> idempotent, no double count ---
    const duplicate = await t.mutation(
      applyUpdate,
      envelope({
        generation: 1,
        reportedState: "searchable",
        uniquePostCount: 480,
        uniquePostCountAsOf: Date.now(),
      }),
    );

    console.log("STEP3 duplicate result:", JSON.stringify(duplicate));
    expect(duplicate).toEqual({ outcome: "duplicate_ignored", committedGeneration: 1 });

    const rowAfterDup = await t.run((ctx) =>
      ctx.db
        .query("accountPublications")
        .withIndex("by_account", (q) => q.eq("accountId", accountId))
        .unique(),
    );

    console.log("STEP3 stored row after duplicate:", JSON.stringify(rowAfterDup));
    expect(rowAfterDup?.searchablePostCount).toBe(480); // not doubled, not re-summed
    const updateLog = await t.run((ctx) => ctx.db.query("publicationUpdates").collect());
    expect(updateLog).toHaveLength(2); // step2 applied + step3 duplicate_ignored (step1 has no update at all)
    expect(updateLog.filter((l) => l.outcome === "applied")).toHaveLength(1);

    // --- Step 4: stale/out-of-order update -> cannot regress state ---
    const stale = await t.mutation(
      applyUpdate,
      envelope({
        generation: 0,
        reportedState: "failed",
        error: { message: "an old retry, arriving late" },
      }),
    );

    console.log("STEP4 stale result:", JSON.stringify(stale));
    expect(stale).toEqual({ outcome: "stale_ignored", committedGeneration: 1 });

    const rowAfterStale = await t.run((ctx) =>
      ctx.db
        .query("accountPublications")
        .withIndex("by_account", (q) => q.eq("accountId", accountId))
        .unique(),
    );

    console.log("STEP4 stored row after stale update:", JSON.stringify(rowAfterStale));
    expect(rowAfterStale?.state).toBe("searchable"); // did not regress to "failed"
    const rowsAfterStale = (await session.query(libraryRows, {})).rows;
    expect(rowsAfterStale[0].publicationState).toBe("searchable");

    // --- Step 5: unauthorized request over HTTP -> fails closed ---
    vi.stubEnv("PUBLICATION_SERVICE_TOKEN", "correct-secret");

    const unauth = await t.fetch("/publication/update", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-secret", "Content-Type": "application/json" },
      body: JSON.stringify(
        envelope({
          generation: 2,
          reportedState: "searchable",
          uniquePostCount: 9999,
          uniquePostCountAsOf: Date.now(),
        }),
      ),
    });

    console.log(
      "STEP5 unauthorized HTTP status:",
      unauth.status,
      JSON.stringify(
        await unauth
          .clone()
          .json()
          .catch(() => undefined),
      ),
    );
    expect(unauth.status).toBe(401);

    const rowAfterUnauth = await t.run((ctx) =>
      ctx.db
        .query("accountPublications")
        .withIndex("by_account", (q) => q.eq("accountId", accountId))
        .unique(),
    );

    console.log(
      "STEP5 stored row after unauthorized attempt (unchanged):",
      JSON.stringify(rowAfterUnauth),
    );
    expect(rowAfterUnauth?.searchablePostCount).toBe(480); // the 9999 in the rejected body never landed
    expect(rowAfterUnauth?.committedGeneration).toBe(1);
  });
});
