import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import { stripMarkers } from "./solid";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import type { ServiceStatus } from "../convex/summary";
import type { OpsTab } from "../src/locationStore";
import { mountOps, type OpsFixtures } from "./opsHarness";

/**
 * Workflow-run evidence for to-do.md's acceptance check: "Test the
 * screenshot's partial/failing imports, successful imports, empty corpus,
 * failed refresh with existing indexed posts, and stale/offline services."
 *
 * Each case drives the REAL Convex queries (convex/library.ts rows,
 * convex/ops.ts accounts, convex/jobs.ts list, convex/summary.ts
 * summary/health) against a local convex-test in-memory deployment seeded
 * here, then feeds the REAL return value into the REAL /ops dashboard
 * (src/ops), rendered into jsdom, and prints what actually came out. The
 * dashboard reads Convex through src/data/convex, so it renders under a fake
 * Convex app (tests/opsHarness.ts) that answers each query from a response
 * this test already fetched from the real backend above; nothing here
 * fabricates data the backend did not actually return. This
 * does not touch search/ (Rust) or anything Pronsh owns, and does not
 * implement any indexer/watcher/registry. No paid import, no live
 * coordination, nothing merged or deployed.
 */

const modules = import.meta.glob("../convex/**/*.ts");

const libraryRows = anyApi.library.rows;

const summaryQ = anyApi.summary.summarySnapshot;

const healthQ = anyApi.summary.healthSnapshot;

/** One dashboard page, fed only real query results, as markup. */
async function renderPage(tab: OpsTab, fixtures: OpsFixtures, selector: string): Promise<string> {
  const ops = await mountOps(tab, fixtures);
  const html = stripMarkers(ops.find(selector).outerHTML);

  ops.unmount();

  return html;
}

async function seedOwner(t: ReturnType<typeof convexTest>) {
  // An operator (tests/setupEnv.ts): the dashboard's read models are
  // operator-only.
  const owner: Id<"users"> = await t.run((ctx) =>
    ctx.db.insert("users", {
      isAnonymous: false,
      email: "operator@test.xearch",
      emailVerificationTime: Date.now(),
    }),
  );

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

    const jobs = (await session.query(api.jobs.list, {})).jobs;
    const accounts = (await session.query(api.ops.accountsSnapshot, {})).rows;
    const html = await renderPage("overview", { jobs, accounts }, ".att");

    console.log(
      "CASE1 UI contains the real error text:",
      html.includes("x.md returned a malformed history page after 340 posts."),
    );
    console.log(
      "CASE1 UI contains stale leftover phase 'Saving raw capture' (should NOT):",
      html.includes("Saving raw capture"),
    );
    console.log("CASE1 UI contains Retry action:", html.includes(">Retry<"));
    expect(html).toContain("Import of @bob failed");
    expect(html).toContain("x.md returned a malformed history page after 340 posts.");
    expect(html).not.toContain("Saving raw capture");
    expect(html).toContain(">Retry<");

    const row = await renderPage("accounts", { jobs, accounts }, "tr[data-account=bob]");

    expect(row).toContain("Last import failed");
    expect(row).toContain("failed just now</span> · last good never · see jobs");

    const jobRow = await renderPage("jobs", { jobs, accounts }, `tr[data-job="${jobId}"]`);

    expect(jobRow).toContain("x.md returned a malformed history page after 340 posts.");
    expect(jobRow).toContain(">Retry<");
  });

  it("case 2: successful import — searchable, real count, no next action needed", async () => {
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

    const accounts = (await session.query(api.ops.accountsSnapshot, {})).rows;
    const html = await renderPage("accounts", { accounts }, "tr[data-account=carol]");

    console.log("CASE2 UI says up to date:", html.includes("Up to date"));
    console.log("CASE2 UI contains real count '512':", html.includes(">512<"));
    expect(html).toContain("Up to date");
    expect(html).toContain(">512<");
    expect(html).not.toContain("failed");

    const attention = await renderPage("overview", { accounts }, ".att");

    expect(attention).toContain("Nothing needs you right now.");
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
        lastError: {
          message: "indexer rejected generation 2: schema mismatch",
          observedAt: failedAt,
          generation: 2,
        },
        updatedAt: failedAt,
      }),
    );

    const rows = (await session.query(libraryRows, {})).rows;
    console.log("CASE4 library.rows:", JSON.stringify(rows));
    expect(rows).toHaveLength(1);
    expect(rows[0].publicationState).toBe("failed");
    expect(rows[0].searchablePostCount).toEqual({ kind: "known", unit: "posts", value: 950 });
    expect(rows[0].lastError?.message).toBe("indexer rejected generation 2: schema mismatch");

    const accounts = (await session.query(api.ops.accountsSnapshot, {})).rows;
    const html = await renderPage("accounts", { accounts }, "tr[data-account=dana]");

    console.log(
      "CASE4 UI keeps the old corpus visible alongside the failure:",
      html.includes(">950<"),
      html.includes("Indexing failed"),
    );
    expect(html).toContain(">950<");
    expect(html).toContain("Indexing failed");
    expect(html).not.toContain("Up to date");

    // The account-level summary must reflect the non-regression guarantee:
    // the 950 posts still count toward indexedPosts (they are still really
    // searchable server-side), but this account no longer counts toward
    // indexedAccounts (its CURRENT state is not "searchable").
    const summary = await session.query(summaryQ, { now: Date.now() });
    console.log(
      "CASE4 summary.summary reflects sticky posts but not a current account:",
      JSON.stringify(summary),
    );
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
    // SAFETY: `healthQ` is `anyApi.summary.healthSnapshot`, an untyped reference, so
    // convex-test's result is typed `any`; convex/summary.ts's `health` query
    // always returns a `ServiceStatus[]` — see its own return type.
    const health = (await session.query(healthQ, { now })) as ServiceStatus[];
    console.log("CASE5 summary.health:", JSON.stringify(health));
    const indexer = health.find((h) => h.service === "indexer");
    const receiver = health.find((h) => h.service === "receiver");
    const search = health.find((h) => h.service === "search");
    expect(indexer).toMatchObject({ kind: "known", healthy: true, stale: true });
    expect(receiver).toMatchObject({ kind: "known", healthy: false, stale: false });
    expect(search).toEqual({ service: "search", kind: "unknown" });

    const html = await renderPage("performance", { health }, ".health");

    const card = (name: string) =>
      html.split('class="hc"').find((c) => c.includes(`<b>${name}</b>`)) ?? "";

    console.log("CASE5 stale indexer card:", card("Indexer"));
    console.log("CASE5 unhealthy receiver card:", card("Capture receiver"));
    console.log("CASE5 unreported search card:", card("Search"));
    expect(card("Indexer")).toContain('data-s="warn"');
    expect(card("Indexer")).toContain("healthy then");
    expect(card("Capture receiver")).toContain('data-s="crit"');
    expect(card("Capture receiver")).toContain("connection refused");
    expect(card("Search")).toContain("Has never reported");
    expect(card("Search")).not.toContain('data-s="ok"');
  });
});
