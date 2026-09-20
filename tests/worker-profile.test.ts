import { describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

const modules = import.meta.glob("../convex/**/*.ts");

/**
 * Production runs COLLECTOR_MODE=outbound, so the VM worker — not
 * convex/importer.ts — is what talks to x.md and reports the result. The
 * worker's `report` action had no `profile` field, so the account a run
 * turned out to be never reached `jobs.finish`, `upsertAccount` never ran,
 * and the production `accounts` table stayed empty forever. Every downstream
 * thing then failed quietly: the account library had nothing to list, the
 * owner-scoped totals were zero, and every publication update from the
 * indexer was rejected with "No known account matches".
 */
async function setup() {
  const t = convexTest(schema, modules);
  const owner = await t.run((ctx) => ctx.db.insert("users", { isAnonymous: true }));
  vi.stubEnv("COLLECTOR_MODE", "outbound");
  vi.stubEnv("COLLECTOR_TOKEN", "worker-secret");
  vi.stubEnv("X_MD_API_KEY", "test");
  return { t, owner };
}

function runningJob(t: Awaited<ReturnType<typeof setup>>["t"], owner: Id<"users">) {
  return t.run((ctx) =>
    ctx.db.insert("jobs", {
      owner,
      kind: "bulk",
      input: "someone",
      refresh: false,
      status: "running",
      count: 1,
      attempt: 1,
      warnings: [],
      updatedAt: Date.now(),
    }),
  );
}

describe("the outbound worker's finish report", () => {
  it("creates the account row, so the library and publication have something to resolve", async () => {
    const { t, owner } = await setup();
    const jobId = await runningJob(t, owner);

    await t.action(api.worker.report, {
      token: "worker-secret",
      jobId,
      attempt: 1,
      event: "finish",
      warnings: [],
      expectedUserId: "12345",
      profile: { handle: "someone", userId: "12345", name: "Some One" },
    });

    const accounts = await t.run((ctx) => ctx.db.query("accounts").collect());
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ handle: "someone", userId: "12345", name: "Some One" });

    // The handle history that identity resolution depends on is recorded too.
    const handles = await t.run((ctx) => ctx.db.query("accountHandles").collect());
    expect(handles.map((h) => h.handle)).toEqual(["someone"]);

    // And the account is now resolvable, which is what a publication update
    // needs — without it the indexer gets "No known account matches".
    const session = t.withIdentity({ subject: `${owner}|session` });
    const library = await session.query(api.library.rows, {});
    expect(library.rows).toHaveLength(1);
    expect(library.rows[0].handle).toBe("someone");
  });

  it("finishes the run normally when there is no profile to report", async () => {
    const { t, owner } = await setup();
    const jobId = await runningJob(t, owner);

    await t.action(api.worker.report, {
      token: "worker-secret",
      jobId,
      attempt: 1,
      event: "finish",
      warnings: [],
    });

    expect(await t.run((ctx) => ctx.db.query("accounts").collect())).toHaveLength(0);
    expect((await t.run((ctx) => ctx.db.get(jobId)))?.status).toBe("complete");
  });
});
