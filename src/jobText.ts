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
