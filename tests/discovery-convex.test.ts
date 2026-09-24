import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";

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
    // `api.jobs` exposes the public surface only; the discovery entry point
    // must not be on it.
    expect(Object.hasOwn(api.jobs, "startDiscovered")).toBe(false);
  });
});
