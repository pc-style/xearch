import { describe, expect, it } from "vitest";
import { handoffReady, WORKER_LIVE_WINDOW_MS } from "../src/integrationStatus";

/**
 * A Convex query re-runs when a document it read changes, never because time
 * passed. Worker liveness therefore cannot be decided inside the query: if
 * the worker stops heartbeating, a server-computed `true` stays `true` until
 * something else happens to touch that row. These assert the decision is the
 * client's, against its own clock.
 */
describe("download-worker liveness is judged client-side", () => {
  const now = 1_700_000_000_000;

  it("is undefined until the deployment has answered at all", () => {
    expect(handoffReady(undefined, now)).toBeUndefined();
  });

  it("reads a recent heartbeat as live", () => {
    expect(handoffReady({ kind: "live", lastSeenAt: now - 1_000 }, now)).toBe(true);
  });

  it("goes stale on its own once the window passes, with no new write to the row", () => {
    const lastSeenAt = now - 1_000;
    expect(handoffReady({ kind: "live", lastSeenAt }, now)).toBe(true);
    // Same data, later clock. This is the case a server-side boolean could
    // never report, because nothing in the database changed.
    const later = now + WORKER_LIVE_WINDOW_MS;
    expect(handoffReady({ kind: "live", lastSeenAt }, later)).toBe(false);
  });

  it("treats a worker that has never checked in as not live", () => {
    expect(handoffReady({ kind: "live", lastSeenAt: null }, now)).toBe(false);
  });

  it("does not claim the worker is down when the timestamp was simply not disclosed", () => {
    // Signed-out callers are not given worker timing — it is infrastructure
    // detail on a public bootstrap response. Absent must read as "cannot
    // say", never as "down", so the caller falls back to the public flag
    // rather than asserting something it was never told.
    expect(handoffReady({ kind: "live" }, now)).toBeUndefined();
    expect(handoffReady({ kind: "live", lastSeenAt: undefined }, now)).toBeUndefined();
  });

  it("passes a configuration fact straight through, with no clock involved", () => {
    expect(handoffReady({ kind: "configured", ok: true }, now)).toBe(true);
    expect(handoffReady({ kind: "configured", ok: false }, now)).toBe(false);
    // Far-future clock changes nothing: configuration does not go stale.
    expect(handoffReady({ kind: "configured", ok: true }, now + 86_400_000)).toBe(true);
  });
});
