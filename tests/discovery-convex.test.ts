import { describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import * as jobs from "../convex/jobs";

const modules = import.meta.glob("../convex/**/*.ts");

// The discovery script queues imports through an INTERNAL mutation: only the
// deploy key (the CLI on the VM) can reach it, so it needs no session and no
// operator token, and it can never become a public entry point.
describe("automatic discovery", () => {
  it("queues a tagged bulk import once, and never a second one for the same account", async () => {
    const t = convexTest(schema, modules);

    const first = await t.mutation(internal.jobs.startDiscovered, {
      input: "BallingT",
      discoveredFrom: [{ handle: "theo", interactions: 31 }],
    });

    expect(first).not.toBeNull();
    const job = await t.run(async (ctx) => ctx.db.get(first!));
    expect(job).toMatchObject({
      kind: "bulk",
      input: "ballingt",
      status: "queued",
      autoContinue: true,
      origin: "discovered",
      discoveredFrom: [{ handle: "theo", interactions: 31 }],
    });
    const owner = await t.run(async (ctx) => ctx.db.get(job!.owner));
    expect(owner?.email).toBe("discovery@xearch.internal");

    const again = await t.mutation(internal.jobs.startDiscovered, {
      input: "ballingt",
      discoveredFrom: [{ handle: "theo", interactions: 40 }],
    });

    expect(again).toBeNull();
    expect(await t.run(async (ctx) => (await ctx.db.query("jobs").collect()).length)).toBe(1);
  });

  it("reports who is indexed and which bulk imports already exist", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("accounts", { handle: "theo", name: "Theo", userId: "1" });
    });
    await t.mutation(internal.jobs.startDiscovered, {
      input: "ballingt",
      discoveredFrom: [{ handle: "theo", interactions: 31 }],
    });
    const state = await t.query(internal.jobs.discoveryState, {});
    expect(state.indexed).toEqual(["theo"]);
    expect(state.existingInputs).toEqual(["ballingt"]);
  });

  it("is not reachable as a public function", () => {
    expect(jobs.startDiscovered.isInternal).toBe(true);
    expect(jobs.discoveryState.isInternal).toBe(true);
    // Control: a public mutation reports the opposite property.
    expect(jobs.start.isPublic).toBe(true);
  });

  it("keeps a discovered job's provenance across an operator continuation", async () => {
    vi.stubEnv("X_MD_API_KEY", "test");
    vi.stubEnv("RAW_CAPTURE_URL", "http://127.0.0.1:4319/captures");
    vi.stubEnv("COLLECTOR_MODE", "receiver");

    const t = convexTest(schema, modules);

    const alice = await t.run((ctx) =>
      ctx.db.insert("users", {
        isAnonymous: false,
        email: "alice@test.xearch",
        emailVerificationTime: Date.now(),
      }),
    );

    const a = t.withIdentity({ subject: `${alice}|s` });

    const discovered = await t.mutation(internal.jobs.startDiscovered, {
      input: "ballingt",
      discoveredFrom: [{ handle: "theo", interactions: 31 }],
    });

    expect(discovered).not.toBeNull();
    // A continuation only makes sense once the run it continues has stopped
    // (autoContinue picks up a still-active one on its own), and needs a
    // `nextUntil` for `start` to page from.
    await t.run((ctx) =>
      ctx.db.patch(discovered!, { status: "complete", nextUntil: "2025-01-01T00:00:00.000Z" }),
    );

    // An operator (not the discovery job) continues it, e.g. via "Retry
    // import" in the dashboard — this must not silently relabel the run as
    // "manual" or drop the accounts that led to it.
    const continued = await a.mutation(api.jobs.start, {
      kind: "bulk",
      input: "ballingt",
      previous: discovered!,
    });

    expect(continued).not.toBe(discovered);
    const job = await t.run((ctx) => ctx.db.get(continued));
    expect(job).toMatchObject({
      origin: "discovered",
      discoveredFrom: [{ handle: "theo", interactions: 31 }],
    });
  });
});
