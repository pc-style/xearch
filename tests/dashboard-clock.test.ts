import { describe, expect, it } from "vitest";
import { bucketNow, DASHBOARD_CLOCK_INTERVAL_MS } from "../src/library/clock";

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
  it("rounds down to the start of the current bucket", () => {
    const bucketStart = 10 * DASHBOARD_CLOCK_INTERVAL_MS;
    expect(bucketNow(bucketStart)).toBe(bucketStart);
    expect(bucketNow(bucketStart + 1)).toBe(bucketStart);
    expect(bucketNow(bucketStart + DASHBOARD_CLOCK_INTERVAL_MS - 1)).toBe(bucketStart);
  });

  it("gives two clocks that drifted apart by a few milliseconds the same value", () => {
    const bucketStart = 42 * DASHBOARD_CLOCK_INTERVAL_MS;
    const clockA = bucketStart + 5;
    const clockB = bucketStart + 5_000;
    expect(bucketNow(clockA)).toBe(bucketNow(clockB));
  });

  it("still advances once a real bucket boundary is crossed", () => {
    const bucketStart = 7 * DASHBOARD_CLOCK_INTERVAL_MS;
    expect(bucketNow(bucketStart + DASHBOARD_CLOCK_INTERVAL_MS)).toBe(
      bucketStart + DASHBOARD_CLOCK_INTERVAL_MS,
    );
  });
});
