/**
 * Which parts of an account's history no capture covers, from the retained
 * captures alone. scripts/backfill-gaps.mjs feeds it the archive and hands
 * the result to `jobs:restartHistoryBackfill`.
 *
 * A dated history window (`from:<handle> since:<a> until:<b>`) covers from
 * the oldest post it returned up to `b`: x.md pages newest first and often
 * stopped well before `a`, which the backfill before `resumeUntil` ignored.
 * A window that returned nothing and finished covers all of `[a, b)`. A
 * timeline import covers its run of posts, from its newest down to the
 * oldest one without a month's gap (a pinned post months older is not
 * coverage).
 */

const DAY = 86_400_000;

/** A month without posts ends a timeline's run (convex/lib/historyWindow.ts `DETACHED_GAP_MS`). */
const DETACHED_GAP = 30 * DAY;

/** `YYYY-MM-DD` of an epoch-millisecond time, in UTC. */
export function day(time) {
  return new Date(time).toISOString().slice(0, 10);
}

function addDays(date, days) {
  return day(Date.parse(`${date}T00:00:00Z`) + days * DAY);
}

const WINDOW = /^from:(\w{1,15}) since:(\d{4}-\d{2}-\d{2}) until:(\d{4}-\d{2}-\d{2})$/u;

/** Post times in one capture, in epoch milliseconds. */
function times(capture) {
  const out = [];

  for (const record of capture.records ?? [])
    for (const post of record.payload?.posts ?? []) {
      const time = Date.parse(post?.created_at ?? "");

      if (Number.isFinite(time)) out.push(time);
    }

  return out;
}

/**
 * Fold one capture into `accounts` (handle → { windows, timeline }).
 * Windows are grouped by run: one job, however many captures and attempts.
 */
export function addCapture(accounts, capture) {
  const request = capture.request ?? {};
  const input = String(request.input ?? "");
  const window = request.resource === "live" ? WINDOW.exec(input) : null;
  const handle = (window ? window[1] : request.resource === "bulk" ? input : "").toLowerCase();

  if (!handle) return;
  const account = accounts.get(handle) ?? { windows: new Map(), timeline: [] };

  accounts.set(handle, account);

  if (window) {
    const key = `${capture.runId}:${window[2]}`;

    const run = account.windows.get(key) ?? {
      since: window[2],
      until: window[3],
      oldest: Infinity,
      complete: false,
    };

    for (const time of times(capture)) run.oldest = Math.min(run.oldest, time);
    run.complete ||= capture.terminal === "complete";
    account.windows.set(key, run);
  } else account.timeline.push(...times(capture));
}

/** Days `[since, until)` some capture of the account covers. */
export function covered(account) {
  const spans = [];

  for (const run of account.windows.values())
    if (Number.isFinite(run.oldest)) spans.push({ since: day(run.oldest), until: run.until });
    else if (run.complete) spans.push({ since: run.since, until: run.until });

  const timeline = [...account.timeline].sort((a, b) => b - a);

  if (timeline.length) {
    let oldest = timeline[0];

    for (const time of timeline) {
      if (oldest - time > DETACHED_GAP) break;
      oldest = time;
    }

    spans.push({ since: day(oldest), until: addDays(day(timeline[0]), 1) });
  }

  return spans;
}

/**
 * The ranges between `floor` and the newest covered day that nothing
 * covers, newest first. Holes closer than `join` days apart become one
 * range, so a walk does not stop and start for a day between windows.
 */
export function gaps(spans, floor, join = 7) {
  if (!spans.length) return [];
  const sorted = [...spans].sort((a, b) => (a.since < b.since ? -1 : 1));
  const out = [];
  let reached = floor;

  for (const span of sorted) {
    if (span.since > reached) out.push({ since: reached, until: span.since });

    if (span.until > reached) reached = span.until;
  }

  const merged = [];

  for (const hole of out) {
    const last = merged.at(-1);

    if (last && Date.parse(hole.since) - Date.parse(last.until) < join * DAY)
      last.until = hole.until;
    else merged.push({ ...hole });
  }

  return merged.sort((a, b) => (a.since < b.since ? 1 : -1));
}
