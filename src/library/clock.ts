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
// instead of once per bucket. Bucketing costs nothing here: the bucket is
// still <= DASHBOARD_CLOCK_INTERVAL_MS wide, well under the 45s liveness
// window it feeds.
export function bucketNow(value: number): number {
  return Math.floor(value / DASHBOARD_CLOCK_INTERVAL_MS) * DASHBOARD_CLOCK_INTERVAL_MS;
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
