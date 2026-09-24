import { describe, expect, it } from "vitest";
import { bucketNow, DASHBOARD_CLOCK_INTERVAL_MS } from "../src/library/clock";
import { isWorkerLive, WORKER_LIVE_WINDOW_MS } from "../convex/worker";

/**
 * convex/integrations.ts's `configured` (the public bootstrap, read by
 * every open client) takes the caller's `now` as an argument, and Convex's
 * query cache/subscription fan-out is keyed on the exact argument value —
 * see convex/worker.ts's `isWorkerLive` and the OCC-contention fix this
 * clock feeds. Two browsers whose `Date.now()` calls land a millisecond
 * apart must still agree on the value they send, or the whole point of
 * cutting per-client churn on the `collector` row is lost. `bucketNow`
 * quantizes to a shared wall-clock grid so that happens.
 */
describe("bucketNow (shared time bucket for configured's `now` argument)", () => {
  it("rounds up to the end of the current bucket", () => {
    const bucketEnd = 10 * DASHBOARD_CLOCK_INTERVAL_MS;
    const bucketStart = bucketEnd - DASHBOARD_CLOCK_INTERVAL_MS;
    expect(bucketNow(bucketStart + 1)).toBe(bucketEnd);
    expect(bucketNow(bucketEnd - 1)).toBe(bucketEnd);
    // Exactly on a boundary already: no jump forward to the next one.
    expect(bucketNow(bucketEnd)).toBe(bucketEnd);
  });

  it("gives two clocks that drifted apart by a few milliseconds the same value", () => {
    const bucketStart = 42 * DASHBOARD_CLOCK_INTERVAL_MS;
    const clockA = bucketStart + 5;
    const clockB = bucketStart + 5_000;
    expect(bucketNow(clockA)).toBe(bucketNow(clockB));
  });

  it("still advances once a real bucket boundary is crossed", () => {
    const bucketEnd = 7 * DASHBOARD_CLOCK_INTERVAL_MS;
    expect(bucketNow(bucketEnd + 1)).toBe(bucketEnd + DASHBOARD_CLOCK_INTERVAL_MS);
  });

  it("never returns a value behind the real clock — the property the 45s worker-liveness window depends on", () => {
    for (const offset of [0, 1, 5_000, 29_999, 30_000, 30_001]) {
      const value = 100 * DASHBOARD_CLOCK_INTERVAL_MS + offset;
      expect(bucketNow(value)).toBeGreaterThanOrEqual(value);
    }
  });
});

describe("bucketNow feeding convex/worker.ts's isWorkerLive (the 45s worker-liveness window)", () => {
  it("never reports a worker live for longer than the true 45s window because `now` got rounded down", () => {
    // CodeRabbit's finding: with a floor-based bucket, `lastSeen` landing
    // just after a bucket's start could make the bucketed `now` used for
    // the liveness check lag the real clock by nearly a whole
    // DASHBOARD_CLOCK_INTERVAL_MS, so a worker that crashed could still
    // read as live for up to ~75s (45s window + ~30s of rounding lag)
    // instead of 45s. Reproduce the worst-case alignment and assert the
    // bucketed `now` still expires the worker at or before the true 45s
    // mark, never after.
    const lastSeen = 3 * DASHBOARD_CLOCK_INTERVAL_MS + 1; // just after a bucket boundary
    const trueExpiry = lastSeen + WORKER_LIVE_WINDOW_MS;
    const bucketedNow = bucketNow(trueExpiry);
    expect(bucketedNow).toBeGreaterThanOrEqual(trueExpiry);
    expect(isWorkerLive({ online: true, lastSeen }, bucketedNow)).toBe(false);
  });

  it("still reads live for a worker that heartbeat well within the window, bucketing included", () => {
    const lastSeen = 3 * DASHBOARD_CLOCK_INTERVAL_MS + 1;
    const bucketedNow = bucketNow(lastSeen + 5_000);
    expect(isWorkerLive({ online: true, lastSeen }, bucketedNow)).toBe(true);
  });
});
