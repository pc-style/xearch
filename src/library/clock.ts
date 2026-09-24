import { useSyncExternalStore } from "react";

export const DASHBOARD_CLOCK_INTERVAL_MS = 30_000;

const initialNow = Date.now();

const listeners = new Set<() => void>();

let now: number | undefined = typeof window === "undefined" ? initialNow : undefined;

let interval: ReturnType<typeof setInterval> | null = null;

function notify(): void {
  for (const listener of listeners) listener();
}

function refresh(): void {
  const nextNow = Date.now();

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
  if (now === undefined) now = Date.now();

  return now;
}

export function getServerSnapshot(): number {
  return initialNow;
}

export function useDashboardClock(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export const useDashboardNow = useDashboardClock;
