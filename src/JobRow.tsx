import { useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import type { Doc } from "../convex/_generated/dataModel";
import { useTask } from "./errors";
import { OPERATOR_SIGN_IN_NOTICE } from "./integrationStatus";
import {
  isPermanentFailure,
  jobKindLabel,
  jobLabel,
  jobPhaseDetail,
  jobSummary,
  jobWarnings,
  relativeTime,
} from "./jobText";

/**
 * One acquisition job, rendered the same way everywhere a person can see one
 * — the header "Import account" modal (src/App.tsx, public build) and the
 * operator dashboard's "Other imports" feed (src/Dashboard.tsx, operator
 * build only). Both surfaces used to render their own copy, which is how
 * they drifted: the modal never gained a timestamp, a job-kind label, a
 * technical-details disclosure, a dismiss action, or a permanent-vs-
 * transient failure distinction, all of which the dashboard already had
 * (/tmp/issues-codex-followup.md item 8).
 *
 * This module ships in the PUBLIC bundle (src/App.tsx imports it directly,
 * not through operatorSurface.ts's lazy operator-only split), so it must
 * never carry operator-only copy or reference operator-only modules —
 * scripts/check-public-bundle.mjs enforces that on the built output.
 * Dashboard-only extras (Restore/"Bring back" for a dismissed job) are kept
 * out of this component entirely and layered on by src/Dashboard.tsx itself
 * via `extraActions`, rather than taught to this shared row.
 */
export function JobRow({
  job,
  now,
  earlierCount,
  className = "job",
  isOperator,
  onRetry,
  onCancel,
  onDismiss,
  extraActions,
}: {
  job: Doc<"jobs">;
  /** A live clock from the caller (see src/library/clock.ts) — never read
   * from `Date.now()` here, which would freeze at whatever instant last
   * re-rendered this row instead of ever advancing on its own. */
  now: number;
  /** How many older runs for this exact (kind, input) were folded into this
   * row — see `dedupeJobsByInput` in src/jobText.ts. Shown as a line inside
   * "Technical details" rather than as a separate row for each one. */
  earlierCount?: number;
  className?: string;
  /** Cancel/Retry/Dismiss all spend provider allowance or resume a run that
   * does (convex/access.ts `requireOperator`, enforced server-side on
   * `jobs.cancel`/`retry`/`dismiss` regardless of this prop) — gated here
   * the same way every other provider-spending action in this app is, so a
   * signed-in guest sees why the buttons are disabled instead of hitting a
   * ConvexError with no warning. */
  /** `undefined` while the operator check is still loading: actions stay disabled, no notice yet. */
  isOperator: boolean | undefined;
  onRetry?: (job: Doc<"jobs">) => Promise<void>;
  onCancel?: (job: Doc<"jobs">) => Promise<void>;
  onDismiss?: (job: Doc<"jobs">) => Promise<void>;
  /** Dashboard-only actions (Restore) that have no meaning in the modal. */
  extraActions?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const receipts = useQuery(api.jobs.receipts, expanded ? { jobId: job._id } : "skip");
  const { busy, message, run } = useTask();

  const active = job.status === "queued" || job.status === "running";
  const dismissed = job.dismissedAt !== undefined;
  const permanent = isPermanentFailure(job);
  const retryable = ["failed", "partial", "cancelled"].includes(job.status) && !permanent;
  const canCancel = active && Boolean(onCancel);
  const canRetry = retryable && Boolean(onRetry);
  const canDismiss = !active && !dismissed && Boolean(onDismiss);
  const disabledTitle = isOperator ? undefined : OPERATOR_SIGN_IN_NOTICE;

  return (
    <article className={className}>
      <div className="job-row-heading">
        <div>
          <strong>{jobKindLabel(job)}</strong>
          <p className="job-row-time muted-copy">{relativeTime(job.updatedAt, now)}</p>
        </div>
        <span className={`job-status ${job.status}`}>{jobLabel(job)}</span>
      </div>
      <p>{jobSummary(job)}</p>
      {jobWarnings(job).map((w) => (
        <p className="muted-copy" key={w}>
          {w}
        </p>
      ))}
      <div className="job-row-actions">
        {canCancel && (
          <button
            type="button"
            disabled={busy || !isOperator}
            title={disabledTitle}
            onClick={() => void run(() => onCancel!(job))}
          >
            Cancel
          </button>
        )}
        {canRetry && (
          <button
            type="button"
            disabled={busy || !isOperator}
            title={disabledTitle}
            onClick={() => void run(() => onRetry!(job))}
          >
            Retry
          </button>
        )}
        {permanent && <span className="muted-copy">x.md can't fetch this</span>}
        {canDismiss && (
          <button
            type="button"
            disabled={busy || !isOperator}
            title={disabledTitle}
            onClick={() => void run(() => onDismiss!(job))}
          >
            Clear from list
          </button>
        )}
        {extraActions}
      </div>
      {isOperator === false && (canCancel || canRetry || canDismiss) && (
        <p className="muted-copy">{OPERATOR_SIGN_IN_NOTICE}</p>
      )}
      {message && (
        <p role="alert" className="config-warning">
          {message}
        </p>
      )}
      <details
        className="job-row-details"
        open={expanded}
        onToggle={(e) => setExpanded(e.currentTarget.open)}
      >
        <summary>Technical details</summary>
        <p>{jobPhaseDetail(job, now)}</p>
        {job.error && <p className="config-warning">{job.error}</p>}
        {earlierCount ? (
          <p className="muted-copy">
            {earlierCount} earlier {earlierCount === 1 ? "run" : "runs"} for this same input.
          </p>
        ) : null}
        {receipts === undefined
          ? "Loading receipts…"
          : receipts.length === 0
            ? "No durable acknowledgments yet."
            : receipts.map((r) => (
                <div key={r._id}>
                  <strong>{r.records} saved response files</strong>
                  <code>{r.receiptId}</code>
                </div>
              ))}
      </details>
    </article>
  );
}
