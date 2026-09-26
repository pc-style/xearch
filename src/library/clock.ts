import { createSignal, onSettled, type Accessor } from "solid-js";
import { fromStore } from "../data/external";

export const DASHBOARD_CLOCK_INTERVAL_MS = 30_000;

// Rounded to a shared wall-clock bucket, not the raw instant this module
// happened to load or tick, purely so widely-shared, loose-tolerance
// staleness displays don't each mint their own slightly-different `now`
// per browser. (The /ops dashboard no longer feeds any query from this
// clock: its reads are explicit and finite, src/ops/refresh.ts.)
//
// NEVER use this (or `useDashboardClock`/`useDashboardNow` below) to feed a
// tight expiry window such as convex/worker.ts's 45s `isWorkerLive` check —
// see `useLiveNow` further down for that. Rounding `now` in EITHER
// direction corrupts a `now - lastSeen < WINDOW` comparison against that
// short a window: rounding down (this function used to floor) understates
// elapsed time, so a dead worker can keep reading as live for up to
// DASHBOARD_CLOCK_INTERVAL_MS past 45s; rounding up (this function used to
// ceil, to fix that) overstates elapsed time instead, so a worker that
// heartbeat mere seconds ago can read as dead almost
// DASHBOARD_CLOCK_INTERVAL_MS early. Neither direction is safe for a window
// this tight — two separate CodeRabbit findings on the same PR caught one
// direction each. There is no rounding that fixes both, because the bug is
// bucketing itself, not which way it rounds.
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

export function useDashboardClock(): Accessor<number> {
  return fromStore(subscribe, getSnapshot);
}

export const useDashboardNow = useDashboardClock;

// How often `useLiveNow` below re-reads the real clock. Short enough that a
// worker's own 5-8s heartbeat cadence is always well inside one tick, so a
// live worker's remaining margin against the 45s window never drops far
// before the next re-render catches up.
const LIVE_CLOCK_INTERVAL_MS = 5_000;

/**
 * The exact, unbucketed wall clock, ticking every `LIVE_CLOCK_INTERVAL_MS`.
 * Use this — never `useDashboardClock`/`useDashboardNow` — as the `now`
 * argument for anything that compares against convex/worker.ts's 45s
 * `isWorkerLive` window (convex/integrations.ts's `configured`/`operator`).
 * That comparison needs the caller's real elapsed time; a bucketed value
 * would shift the effective window by up to DASHBOARD_CLOCK_INTERVAL_MS in
 * whichever direction it rounds (see `bucketNow`'s comment). This does mean
 * different open browsers each send their own slightly different `now` to
 * `configured` — accepting that per-client argument variation is the
 * deliberate trade for a correct 45s window, since `configured` is read by
 * every open client and getting the liveness math right matters more than
 * the query-cache sharing a bucketed value would buy.
 */
export function useLiveNow(): Accessor<number> {
  const [now, setNow] = createSignal(Date.now());

  onSettled(() => {
    const id = setInterval(() => setNow(Date.now()), LIVE_CLOCK_INTERVAL_MS);

    return () => clearInterval(id);
  });

  return now;
}
