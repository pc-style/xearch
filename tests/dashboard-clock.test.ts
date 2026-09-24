import { describe, expect, it } from "vitest";
import { bucketNow, DASHBOARD_CLOCK_INTERVAL_MS } from "../src/library/clock";
import { isWorkerLive, WORKER_LIVE_WINDOW_MS } from "../convex/worker";

/**
 * `bucketNow` backs `useDashboardClock`/`useDashboardNow`, used only for
 * loose-tolerance staleness displays (convex/summary.ts's `summary`/`health`,
 * read by the /ops dashboard, src/ops/Ops.tsx) where several open browsers sharing one
 * rounded `now` is a pure win with no correctness downside.
 *
 * It must NEVER feed convex/worker.ts's 45s `isWorkerLive` window (used by
 * convex/integrations.ts's `configured`/`operator`) — see
 * src/library/clock.ts's `useLiveNow`, which exists specifically because
 * rounding `now` in either direction corrupts that comparison. Two separate
 * CodeRabbit findings on the same change caught one direction each:
 * flooring understated elapsed time (a dead worker read live for up to ~75s
 * instead of 45s), and the ceiling fix for that overstated it instead (a
 * worker that heartbeat 15s ago could read dead). This file tests
 * `bucketNow`'s own (now narrower) contract, and separately proves the
 * underlying `isWorkerLive` algorithm is correct against exact time, which
 * is what `useLiveNow` supplies it in production.
 */
describe("bucketNow (shared time bucket for loose-tolerance staleness displays only)", () => {
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

  it("never returns a value behind its input", () => {
    for (const offset of [0, 1, 5_000, 29_999, 30_000, 30_001]) {
      const value = 100 * DASHBOARD_CLOCK_INTERVAL_MS + offset;
      expect(bucketNow(value)).toBeGreaterThanOrEqual(value);
    }
  });
});

describe("isWorkerLive against exact time (what useLiveNow supplies, never a bucketed value)", () => {
  it("reproduces the CodeRabbit regression: a worker seen 15s ago must read live, not dead", () => {
    // The exact numbers from the finding: lastSeen at 105_000, real time at
    // 120_001 (15_001ms of real elapsed time — deep inside the 45s window).
    // Feeding this through `bucketNow` first (ceil) used to push the
    // computed elapsed time to a full 45_000ms, right at the boundary,
    // misreporting the worker as dead. With the exact, unbucketed time
    // `useLiveNow` now supplies, this must read live.
    const lastSeen = 105_000;
    const now = 120_001;
    expect(now - lastSeen).toBeLessThan(WORKER_LIVE_WINDOW_MS);
    expect(isWorkerLive({ online: true, lastSeen }, now)).toBe(true);
  });

  it("expires at exactly the true 45s mark, not 30s early or 30s late", () => {
    const lastSeen = 105_000;
    expect(isWorkerLive({ online: true, lastSeen }, lastSeen + WORKER_LIVE_WINDOW_MS - 1)).toBe(
      true,
    );
    expect(isWorkerLive({ online: true, lastSeen }, lastSeen + WORKER_LIVE_WINDOW_MS)).toBe(false);
  });
});
