import { useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import type { Doc } from "../convex/_generated/dataModel";
import { useTask } from "./errors";
import { OPERATOR_SIGN_IN_NOTICE } from "./integrationStatus";
import {
  discoveredVia,
  exactClockTime,
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
          <p className="job-row-time muted-copy">
            {relativeTime(job.updatedAt, now)}
            {/* Several failed "Conversation on @handle's post" rows can share
                the same label, the same rounded age ("5m ago"), and the same
                retained-record summary — the post id in jobKindLabel already
                tells them apart, but the exact start time is the other half
                of the stable identity /tmp/issues.md item 3 asks for. Only
                shown for "post" kind: every other kind's identity is already
                distinct (a handle, a search string) without it. */}
            {job.kind === "post" && ` · started ${exactClockTime(job._creationTime)}`}
          </p>
        </div>
        <span className={`job-status ${job.status}`}>{jobLabel(job)}</span>
      </div>
      <p>{jobSummary(job)}</p>
      {discoveredVia(job) && <p className="muted-copy">{discoveredVia(job)}</p>}
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
        {/* The label above never shows the raw status URL (jobKindLabel /
            conversationLabel keep it to a handle + short post id) — this is
            the one place it is available, for whoever needs to open the
            actual conversation. */}
        {job.kind === "post" && (
          <p className="muted-copy">
            <code>{job.input}</code>
          </p>
        )}
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
