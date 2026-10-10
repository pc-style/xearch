// Pure date/window math for the deep-history backfill (convex/jobs.ts). x.md's
// account-timeline endpoint stops at X's ~3,200-post floor, but its search
// endpoint's dated windows (`from:<handle> since:<date> until:<date>`) reach
// further back — verified against prod: `since:2021-06-01 until:2021-09-01`
// returned real 2021 posts, paged 20 at a time via `nextCursor`. This module
// only computes WHICH window to ask for next; convex/jobs.ts owns scheduling
// the job and writing the `historyBackfills` row.
//
// Kept dependency-free (no Date-library import) and pure so it is exercised
// directly by tests without a Convex runtime.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(value: string | undefined): value is string {
  return value !== undefined && DATE_RE.test(value) && Number.isFinite(Date.parse(value));
}

/** X's own launch date. Used only when an account's `joined` date is unknown. */
export const DEFAULT_JOIN_FLOOR = "2006-03-21";

export const INITIAL_WINDOW_DAYS = 30;

export const MAX_WINDOW_DAYS = 365;

const WIDEN_FACTOR = 4;

/** `date` shifted by `days` (may be negative), in UTC, as `YYYY-MM-DD`. */
export function addDaysUTC(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);

  return parsed.toISOString().slice(0, 10);
}

export type Window = { since: string; until: string };

/**
 * The next window to fetch, walking backward from `cursorUntil` by
 * `windowDays`, clamped so it never reaches earlier than `floor` (the
 * account's join date, or DEFAULT_JOIN_FLOOR when unknown).
 *
 * Returns `null` when there is nothing left to search: `cursorUntil` is
 * already at or before `floor`, so a further window would have no days in
 * it to ask x.md about.
 */
export function computeWindow(
  cursorUntil: string,
  windowDays: number,
  floor: string,
): Window | null {
  if (cursorUntil <= floor) return null;
  const rawSince = addDaysUTC(cursorUntil, -windowDays);
  const since = rawSince < floor ? floor : rawSince;

  return { since, until: cursorUntil };
}

/**
 * Where the walk continues once `window` has finished: the day after the
 * oldest post it returned, or `window.since` when it reached that far.
 *
 * x.md's search pages a dated query newest first and can stop well before
 * the window's start: a year of @theo ended after two months, every time,
 * so walking on from `window.since` left ten-month holes. Resuming from the
 * oldest post re-asks for what was missed; `until:` is exclusive, so the
 * oldest post's own day is asked for again rather than skipped. Always
 * earlier than `window.until`, so the walk cannot stall.
 */
export function resumeUntil(window: Window, oldest: string | undefined): string {
  const day = oldest?.slice(0, 10);

  if (!isValidDate(day) || day < window.since) return window.since;
  const next = addDaysUTC(day, 1);
  const last = addDaysUTC(window.until, -1);

  return next < last ? next : last;
}

/**
 * How long an account can go quiet before an older post counts as detached
 * from the run of posts it came with. X's timeline returns a pinned or
 * highlighted post from months back alongside the recent ones; taking it as
 * the oldest collected post would tell the backfill that those months are
 * already covered.
 */
export const DETACHED_GAP_MS = 30 * 86_400_000;

/**
 * The window size for the NEXT window, given how many posts the window that
 * just finished found. An empty window widens ×4 (capped at
 * MAX_WINDOW_DAYS) on the theory that x.md's search index is sparser than
 * far back, so a bigger slice is more likely to find something; a window
 * that found posts keeps its size, since it is already working.
 */
export function nextWindowDays(currentDays: number, postsFoundInWindow: number): number {
  if (postsFoundInWindow > 0) return currentDays;

  return Math.min(MAX_WINDOW_DAYS, currentDays * WIDEN_FACTOR);
}

/**
 * The exact x.md search query for one history window, byte-identical to
 * what convex/lib/search.ts `canonicalQuery` (with `allowDateWindow: true`)
 * would produce for this handle/since/until, so the two can never drift.
 */
export function historyWindowQuery(handleText: string, since: string, until: string): string {
  return `from:${handleText} since:${since} until:${until}`;
}
