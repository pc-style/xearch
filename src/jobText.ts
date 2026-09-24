import type { Doc } from "../convex/_generated/dataModel";
import type { JobStatus } from "../convex/lib/contracts";

export function jobLabel(job: Doc<"jobs">) {
  // A "complete" job never has more to fetch: convex/jobs.ts `finish`
  // requeues the SAME job (status stays "queued") whenever the provider
  // reports a `nextUntil`/`nextCursor` to continue from, so nobody has to
  // ask for the next page — "complete" only means genuinely done.
  if (job.status === "complete") return job.error ? "Paused" : "Downloaded";

  return {
    queued: "Waiting",
    running: "Downloading",
    cancelled: "Stopped",
    partial: "Interrupted",
    failed: "Failed",
  }[job.status];
}

/**
 * A stopped (failed/partial/cancelled) run's own summary line — shared by
 * both branches of `jobSummary` below so a stopped bulk job and a stopped
 * non-bulk job are described the same honest way, never with a leftover
 * in-progress phase. `cancel()` (convex/jobs.ts) writes a deliberate,
 * accurate final `phase` message when it stops a job, so that one case is
 * safe to show as-is; `finish()`/`expire()` never update `phase` on
 * failure, so for "failed"/"partial" it stays whatever in-progress step
 * ("Saving raw capture", etc.) was last reported before the stop — never
 * safe to show as if it explained the outcome (to-do.md P0 "Do not leave
 * failed jobs showing only 'Saving raw capture.'"). `job.error` (rendered
 * separately by every caller of `jobSummary`) already carries the failure
 * reason, so this only needs to add the retained-progress half of that
 * to-do.md bullet.
 */
function stoppedRunSummary(job: Doc<"jobs">): string {
  if (job.status === "cancelled") return job.phase ?? "Stopped by request.";

  return job.count > 0
    ? `${job.count.toLocaleString()} record${job.count === 1 ? "" : "s"} retained before this run stopped.`
    : "Nothing was retained before this run stopped.";
}

export function jobSummary(job: Doc<"jobs">) {
  if (job.kind === "bulk") {
    if (job.postsReceived !== undefined)
      return `${job.postsReceived.toLocaleString()} posts received${job.pages ? ` across ${job.pages} ${job.pages === 1 ? "batch" : "batches"}` : ""}`;

    if (job.status === "complete")
      return "This older import saved a batch of posts. Its post count wasn't tracked.";

    if (job.status === "failed" || job.status === "partial" || job.status === "cancelled")
      return stoppedRunSummary(job);

    return "Waiting for the next batch of posts";
  }

  if (job.status === "complete") return "Response saved";

  if (job.status === "failed" || job.status === "partial" || job.status === "cancelled")
    return stoppedRunSummary(job);

  return job.phase ?? "Waiting to start";
}

// Best-effort "@handle" out of a normalized status URL (convex/lib/xmd.ts
// `statusUrl`, e.g. "https://x.com/theo/status/123") for a human label on a
// "post" job. Never throws: an unparseable/legacy input just falls back to
// the generic label in `jobKindLabel` below instead of showing raw internals.
function handleFromStatusUrl(url: string): string | null {
  try {
    const segment = new URL(url).pathname.split("/").find((part) => part.length > 0);

    return segment ?? null;
  } catch {
    return null;
  }
}

/**
 * A human label for what a job is downloading, shared by every surface that
 * lists jobs (src/JobRow.tsx) — never the raw URL/handle on its own, which is
 * what made the header modal's old "Recent imports" list read as a wall of
 * links (/tmp/issues-codex-followup.md item 8).
 */
export function jobKindLabel(job: Doc<"jobs">): string {
  switch (job.kind) {
    case "bulk":
      return `@${job.input} history`;
    case "post": {
      const handle = handleFromStatusUrl(job.input);

      return handle ? `Conversation on @${handle}'s post` : "Conversation on a post";
    }

    case "live": {
      // A deep-history backfill window (convex/jobs.ts `insertHistoryWindowJob`)
      // is a `kind: "live"` job like any other, but its input is a dated
      // window this app scheduled, not a person's search — label it as
      // what it is rather than a raw "Live search: from:theo since:... "
      // string nobody typed.
      if (job.origin === "history" && job.since && job.until) {
        const handleText = job.input.match(/^from:([A-Za-z0-9_]+)/)?.[1] ?? job.input;

        return `@${handleText} · older history ${job.since.slice(0, 7)} → ${job.until.slice(0, 7)}`;
      }

      return `Live search: ${job.input}`;
    }

    case "profile":
      return `Profile: @${job.input}`;
    case "followers":
      return `Followers: @${job.input}`;
    case "following":
      return `Following: @${job.input}`;
    case "archive":
      return `Archive: @${job.input}`;
  }
}

/**
 * Whether a stopped run failed for a reason retrying can never fix — a
 * provider 4xx like "invalid_thread" or "not_found", as opposed to a
 * transient one (timeout, 5xx, rate limit) that already got its own
 * automatic backoff attempts before giving up (convex/jobs.ts `finish`).
 * Backed by `job.retryable`, written from `ProviderError.retryable`
 * (convex/lib/xmd.ts) at the moment the run stopped — never guessed from the
 * error text, which varies by provider response and is not a stable
 * contract to parse.
 */
export function isPermanentFailure(job: Doc<"jobs">): boolean {
  return (job.status === "failed" || job.status === "partial") && job.retryable === false;
}

/** A short "N minutes/hours/days ago" rendering of a past timestamp against a
 * live `now` (never `Date.now()` read at render time — see src/JobRow.tsx's
 * `now` prop doc comment for why). Falls back to a calendar date once a run
 * is old enough that "42d ago" stops being a useful answer. */
export function relativeTime(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));

  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);

  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);

  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);

  if (days < 30) return `${days}d ago`;

  return new Date(timestamp).toLocaleDateString();
}

/**
 * The technical-details line for a job's current phase — the same facts
 * src/Dashboard.tsx's `Job` component used to compute inline (before this
 * became a shared row, src/JobRow.tsx), now behind every row's "Technical
 * details" disclosure instead of always on screen. Deliberately generic
 * about a finished job with more history available (never "account
 * library", which only means something on the operator dashboard and would
 * be an operator-only string leaking into the public bundle — see
 * scripts/check-public-bundle.mjs).
 */
export function jobPhaseDetail(job: Doc<"jobs">, now: number): string {
  if (job.status === "complete")
    return job.floorReached
      ? "x.md reached the oldest history it can retrieve. Older posts may still exist on X."
      : "This run finished and is not scheduled to continue on its own.";

  if (job.status === "queued" && job.readyAt !== undefined && job.readyAt > now)
    return `Retrying automatically at ${new Date(job.readyAt).toLocaleTimeString()}`;

  if (job.status === "queued" || job.status === "running") return job.phase ?? "Waiting to start";

  if (job.status === "cancelled") return job.phase ?? "Stopped by request.";

  return "This run did not finish.";
}

/**
 * Fold repeat runs of the exact same (kind, input) — e.g. every "Retry
 * import" click before convex/jobs.ts had an in-place `retry` mutation used
 * `jobs.start`, which inserted a new row each time — into one visible row
 * per input, newest first. `jobs` is assumed already newest-first (what
 * `api.jobs.list` returns); only the first occurrence of a key is kept
 * visible, and every later (older) one is counted, not dropped — see
 * src/JobRow.tsx's "Technical details" disclosure, which is where the count
 * surfaces (/tmp/issues-codex-followup.md item 2 and item 8).
 */
export type DedupedJobRow = {
  job: Doc<"jobs">;
  earlierCount: number;
};

// Display-only: how many older runs of this exact (kind, input) are folded
// behind the visible one — see src/JobRow.tsx's "Technical details" line.
// Never used to decide WHICH ids "Clear from list" dismisses: `jobs.list`
// only ever hands this function one page (JOB_FEED_LIMIT), so a caller-side
// id list here is bounded by that page too. With 21+ duplicate runs of the
// same input, dismissing only the ids on the current page left the
// next-newest one outside it and it resurfaced right back on the next
// render (found on 4144bcd). `jobs.dismissInput` fixes that server-side by
// walking every job for the exact (kind, input) regardless of what any one
// page returned — see its own comment in convex/jobs.ts.
export function dedupeJobsByInput(jobs: Doc<"jobs">[]): DedupedJobRow[] {
  const rows = new Map<string, DedupedJobRow>();

  for (const job of jobs) {
    const key = `${job.kind}:${job.input}`;
    const existing = rows.get(key);

    if (existing) existing.earlierCount += 1;
    else rows.set(key, { job, earlierCount: 0 });
  }

  return [...rows.values()];
}

export function jobWarnings(job: Doc<"jobs">) {
  return job.warnings.filter(
    (w) =>
      !w.startsWith("Raw data handed off.") &&
      !w.startsWith("More history is available.") &&
      w !== "More posts are available from x.md.",
  );
}

/**
 * Acquisition-job status label for callers that only have the job's own
 * `status` — not a full `Doc<"jobs">` — such as
 * `convex/lib/contracts.ts` AccountLibraryRow.latestJob and
 * convex/library.ts's HistoryRun. Deliberately does NOT reuse jobLabel's
 * existing wording (it maps "queued" to "Waiting"): that word collides with
 * the unrelated publication state "waiting_for_indexing", which is exactly
 * the copy-conflation bug the account library exists to remove — see
 * docs/publication-contract.md and to-do.md P0 "Remove contradictory copy".
 * This label always says "download", never bare "waiting"/"complete", so it
 * can never be misread as a search-publication state.
 */
export function acquisitionStatusLabel(status: JobStatus): string {
  return {
    queued: "Queued to download",
    running: "Downloading",
    complete: "Download complete",
    partial: "Download interrupted",
    failed: "Download failed",
    cancelled: "Download stopped",
  }[status];
}

/**
 * /tmp/issues.md item 2: "Download complete" reads like a claim that this
 * account's ENTIRE X history is now in the index — a person can have tens
 * of thousands of posts on X and still see this exact label after a run
 * that only ever got through a few thousand of them. It only ever means one
 * run of the acquisition job finished handing over whatever x.md returned
 * for it, which is "everything x.md could give" for that run, never "all of
 * X" for that account. Shared by every place that shows the "Download
 * complete" badge for an account-history job, so the caveat reads the same
 * way everywhere it appears.
 */
export const DOWNLOAD_COMPLETE_CAVEAT =
  '"Download complete" means x.md finished handing over what it had for this run — not that every post on X was retrieved.';

/**
 * One coherent sentence describing a single acquisition run's outcome: the
 * failure (verbatim, when there is one) plus how much was actually
 * retained. Never returns a bare internal progress string like "Saving raw
 * capture" for a run that has already stopped — to-do.md P0 "Do not leave
 * failed jobs showing only 'Saving raw capture.'" `phase` is only used for a
 * still-active run (queued/running), where it is the honest current step;
 * for a stopped run it is stale progress text left over from before the
 * stop (see convex/jobs.ts finish, which never clears `phase` on failure),
 * so it is deliberately not surfaced here as if it explained the outcome.
 */
/**
 * Inline status line for a job started directly from a result (Conversation
 * / Find on X). Those buttons trigger a real paid x.md fetch, not a preview,
 * so the caller needs an honest "this is happening" state instead of just
 * being dropped into the Recent imports modal. Reuses `jobLabel`/
 * `jobSummary` for the terminal wording so this never drifts from what the
 * Recent imports list itself says about the same job.
 */
// Only `.`, `!`, `?`, and `…` read as a sentence ending; `jobSummary` values
// and some provider error strings have none, so joining them straight to
// "See Recent imports" runs two sentences together with no separator.
const SENTENCE_END = /[.!?…]$/;

function withSentenceEnd(text: string): string {
  return SENTENCE_END.test(text) ? text : `${text}.`;
}

export function inlineImportStatus(job: Doc<"jobs"> | undefined): string | null {
  if (!job) return null;

  // "Downloading", not "Fetching…results" — this only reports the x.md
  // download landing in Recent imports, a different state from the
  // download later becoming searchable (see docs/publication-contract.md);
  // "results" here read as search results, which this is not. Queued and
  // running are also kept distinct: nothing is downloading yet while the
  // job waits its turn.
  if (job.status === "queued")
    return "Waiting to download from X… Progress appears in Recent imports.";

  if (job.status === "running") return "Downloading from X… Progress appears in Recent imports.";
  const detail = job.error ?? jobSummary(job);

  return `${jobLabel(job)} — ${withSentenceEnd(detail)} See Recent imports for details.`;
}

export function describeRunOutcome(run: {
  status: JobStatus;
  phase?: string;
  error?: string;
  count: number;
  postsReceived?: number;
}): string {
  const retained =
    run.postsReceived !== undefined
      ? `${run.postsReceived.toLocaleString()} post${run.postsReceived === 1 ? "" : "s"} retained`
      : run.count > 0
        ? `${run.count.toLocaleString()} record${run.count === 1 ? "" : "s"} retained`
        : "Nothing was retained from this attempt";

  if (run.status === "failed" || run.status === "partial")
    return `${run.error ?? "This run failed for an unreported reason."} ${retained}.`;

  if (run.status === "cancelled") return `Stopped by request. ${retained}.`;

  if (run.status === "running" || run.status === "queued")
    return run.phase ?? "Waiting for the next batch.";

  return `${retained}.`;
}

/**
 * One line saying why a discovered run exists: which indexed accounts
 * interact with this one, and how often. Empty for runs a person started.
 */
export function discoveredVia(
  job:
    | {
        // Widened to every value convex/schema.ts `jobOriginValidator` can
        // hold (not just "manual" | "discovered"): callers pass a full
        // `Doc<"jobs">` through, whose `origin` can also be "history" (a
        // deep-history backfill window) — this only ever checks for
        // "discovered", so the extra literal changes nothing here.
        origin?: "manual" | "discovered" | "history";
        discoveredFrom?: { handle: string; interactions: number }[];
      }
    | null
    | undefined,
): string {
  if (!job || job.origin !== "discovered") return "";
  const from = job.discoveredFrom ?? [];
  const shown = from.slice(0, 3);
  const total = shown.reduce((sum, f) => sum + f.interactions, 0);

  const names = shown.map((f) => `@${f.handle}`).join(", ");

  return names
    ? `Discovered via ${names} (${total} ${total === 1 ? "interaction" : "interactions"})`
    : "Discovered from interactions with indexed accounts";
}
