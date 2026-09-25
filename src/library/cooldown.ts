import { createSignal, type Accessor } from "solid-js";

/**
 * A named cooldown that survives a page reload: `until` is kept in
 * `localStorage` under `key`, so reloading the page does not hand out a
 * fresh allowance. Purely a browser-side courtesy between one person and a
 * backend read they asked to rate themselves on (the dashboard's refresh
 * buttons, src/ops/refresh.ts, and the public page's, src/data/
 * publicRefresh.ts); the server enforces nothing of the kind.
 */
export type Cooldown = {
  /** When the cooldown ends, as a wall-clock ms timestamp; 0 when none. */
  readonly until: Accessor<number>;
  /** Milliseconds left at `now`; 0 once it has passed. */
  remaining(now: number): number;
  /** Start (or restart) the cooldown from `now`. */
  start(now: number): void;
};

export const COOLDOWN_STORAGE_PREFIX = "xearch:cooldown:";

export function createCooldown(
  key: string,
  durationMs: number,
  storage: Pick<Storage, "getItem" | "setItem"> | null = typeof localStorage === "undefined"
    ? null
    : localStorage,
): Cooldown {
  const storageKey = COOLDOWN_STORAGE_PREFIX + key;

  // Storage can be disabled, blocked or full; a cooldown then lives in
  // memory only, and a refresh must still go ahead.
  const stored = () => {
    try {
      const raw = storage?.getItem(storageKey);
      const value = raw === null || raw === undefined ? 0 : Number(raw);

      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  };

  const remember = (value: number) => {
    try {
      storage?.setItem(storageKey, String(value));
    } catch {
      // Kept in memory for this page's life instead.
    }
  };

  const [until, setUntil] = createSignal(stored());

  return {
    until,
    remaining: (now) => Math.max(0, until() - now),
    start: (now) => {
      const next = now + durationMs;
      setUntil(next);
      remember(next);
    },
  };
}

/** "12 s", for a button title or a toast. */
export function cooldownLabel(remainingMs: number): string {
  return `${Math.ceil(remainingMs / 1000)} s`;
}
