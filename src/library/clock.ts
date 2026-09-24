import { useSyncExternalStore } from "react";

export const DASHBOARD_CLOCK_INTERVAL_MS = 30_000;

// Rounded to a shared wall-clock bucket, not the raw instant this module
// happened to load or tick: convex/integrations.ts's `configured` (the
// public bootstrap, read by every open client) takes this value as its
// `now` arg, and Convex's query cache/subscription fan-out is keyed on the
// exact argument value. Two browsers whose 30s timers drifted apart by even
// one millisecond would each mint a distinct `now`, so a query built to cut
// per-client churn on the `collector` row (see convex/worker.ts's
// `isWorkerLive`) would still recompute and re-send once per browser
// instead of once per bucket.
//
// Rounds UP (`Math.ceil`), never down. Every consumer of this clock treats
// `now` as "time elapsed since some earlier, server-written timestamp"
// (`isWorkerLive`'s `now - lastSeen < 45_000`, and convex/summary.ts's own
// `now - observedAt` staleness checks) — rounding down would understate
// that elapsed time by up to one whole `DASHBOARD_CLOCK_INTERVAL_MS`, which
// on the 45s worker-liveness window is a ~30s window in which a worker that
// actually went offline would still read as live. Rounding up instead means
// the bucketed value is never behind the real clock, so an expiry is never
// reported late — at worst a few seconds early, which a live worker's own
// 5-8s heartbeat cadence keeps from ever mattering in practice. This is the
// same "never claim fresher than reality" bias the rest of this codebase
// already applies to staleness (see convex/summary.ts's Count comments).
export function bucketNow(value: number): number {
  return Math.ceil(value / DASHBOARD_CLOCK_INTERVAL_MS) * DASHBOARD_CLOCK_INTERVAL_MS;
}

const initialNow = bucketNow(Date.now());
const listeners = new Set<() => void>();

let now: number | undefined = typeof window === "undefined" ? initialNow : undefined;

let interval: ReturnType<typeof setInterval> | null = null;

function notify(): void {
  for (const listener of listeners) listener();
}

function refresh(): void {
  const nextNow = bucketNow(Date.now());
  if (nextNow === now) return;
  now = nextNow;
  notify();
}

function start(): void {
  if (interval !== null) return;
  interval = setInterval(refresh, DASHBOARD_CLOCK_INTERVAL_MS);
}

function stop(): void {
  if (interval === null) return;
  clearInterval(interval);
  interval = null;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  if (listeners.size === 1) start();

  return () => {
    listeners.delete(listener);

    if (listeners.size === 0) stop();
  };
}

export function getSnapshot(): number {
  if (now === undefined) now = bucketNow(Date.now());
  return now;
}

export function getServerSnapshot(): number {
  return initialNow;
}

export function useDashboardClock(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export const useDashboardNow = useDashboardClock;
