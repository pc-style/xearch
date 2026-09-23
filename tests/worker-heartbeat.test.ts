import { afterEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

const modules = import.meta.glob("../convex/**/*.ts");

/**
 * The production worker polls about every 5 seconds. Each poll used to
 * schedule a new 45-second `worker.expire` and never cancel the one before
 * it, so the scheduler backlog grew with uptime until `poll` failed on
 * Convex's system-operations limit. One heartbeat must leave at most one
 * pending expiry.
 */
function setup() {
  vi.useFakeTimers();
  vi.stubEnv("COLLECTOR_MODE", "outbound");
  vi.stubEnv("COLLECTOR_TOKEN", "worker-secret");
  return convexTest(schema, modules);
}

async function pendingExpiries(t: ReturnType<typeof setup>) {
  const all = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return all.filter((f) => f.name.includes("expire") && f.state.kind === "pending");
}

const collector = (t: ReturnType<typeof setup>) =>
  t.run((ctx) => ctx.db.query("collector").first());

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("worker heartbeat", () => {
  it("keeps one pending expiry however often the worker polls", async () => {
    const t = setup();
    for (let i = 0; i < 5; i++) {
      await t.action(api.worker.poll, { token: "worker-secret", heartbeatOnly: true });
      vi.advanceTimersByTime(5_000);
    }
    const pending = await pendingExpiries(t);
    expect(pending).toHaveLength(1);
    expect((await collector(t))?.expiry).toBe(pending[0]._id);
  });

  it("still marks the worker offline once heartbeats stop", async () => {
    const t = setup();
    await t.action(api.worker.poll, { token: "worker-secret", heartbeatOnly: true });
    await t.action(api.worker.poll, { token: "worker-secret", heartbeatOnly: true });
    expect((await collector(t))?.online).toBe(true);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await collector(t))?.online).toBe(false);
  });

  it("cancels the pending expiry on a shutdown poll", async () => {
    const t = setup();
    await t.action(api.worker.poll, { token: "worker-secret", heartbeatOnly: true });
    await t.action(api.worker.poll, { token: "worker-secret", online: false });
    expect(await pendingExpiries(t)).toHaveLength(0);
    expect((await collector(t))?.expiry).toBeUndefined();
  });
});
