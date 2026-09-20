import type { Doc } from "../convex/_generated/dataModel";
import type { JobStatus } from "../convex/lib/contracts";
export function jobLabel(job: Doc<"jobs">) {
  if (job.status === "complete")
    return job.error
      ? "Paused"
      : job.nextUntil || job.nextCursor
        ? "More to download"
        : "Downloaded";
  return {
    queued: "Waiting",
    running: "Downloading",
    cancelled: "Stopped",
    partial: "Interrupted",
    failed: "Failed",
  }[job.status];
}
export function jobSummary(job: Doc<"jobs">) {
  if (job.kind === "bulk") {
    if (job.postsReceived !== undefined)
      return `${job.postsReceived.toLocaleString()} posts received${job.pages ? ` across ${job.pages} ${job.pages === 1 ? "batch" : "batches"}` : ""}`;
    return job.status === "complete"
      ? "This older import saved a batch of posts. Its post count wasn't tracked."
      : "Waiting for the next batch of posts";
  }
  return job.status === "complete" ? "Response saved" : (job.phase ?? "Waiting to start");
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
