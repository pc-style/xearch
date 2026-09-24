import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { AccountLibraryRow, NextAction } from "../../convex/lib/contracts";
import type { HistoryRun } from "../../convex/library";
import type { Id } from "../../convex/_generated/dataModel";
import { useTask } from "../errors";
import { acquisitionStatusLabel, describeRunOutcome } from "../jobText";
import {
  PUBLICATION_STATE_META,
  acquisitionStatusTone,
  countWithUnit,
  formatRelative,
  isStalledRun,
} from "./format";
import { Badge } from "./format.tsx";
import { useDashboardClock } from "./clock";

/**
 * One account library row: identity, the four states the "dashboard"
 * mapping run found conflated (configuration/connectivity are a different
 * screen's concern; this row only ever speaks to download completion vs.
 * search publication, and always says which one it means), an actionable
 * next step, and an expandable history disclosure. Fields come only from
 * `AccountLibraryRow` (convex/library.ts `rows`) plus, lazily,
 * `HistoryRun[]` (convex/library.ts `history`) — no other query.
 */
export default function AccountRow({ row }: { row: AccountLibraryRow }) {
  const [expanded, setExpanded] = useState(false);
  const { busy, message: error, run: act } = useTask();
  const job = row.latestJob;
  // A failed/partial latest job's own `phase` field is stale progress text
  // left over from before it stopped (convex/jobs.ts finish never clears it
  // on failure) — never the actual failure. The real error/retained-count
  // only exist on the matching HistoryRun, so fetch history eagerly (not
  // only on manual expand) whenever there is a failure to explain. This is
  // still exclusively convex/library.ts's `history` query.
  const needsFailureDetail = !!job && (job.status === "failed" || job.status === "partial");

  const history = useQuery(
    api.library.history,
    expanded || needsFailureDetail ? { accountId: row.accountId } : "skip",
  );

  const retry = useMutation(api.jobs.retry);
  const cancel = useMutation(api.jobs.cancel);

  const currentRun = job && history?.find((h) => h.jobId === job.jobId);
  const stateMeta = PUBLICATION_STATE_META[row.publicationState];
  const hasGoodCorpus = row.searchablePostCount.kind === "known";
  const stalled = job ? isStalledRun(job.status, job.updatedAt) : false;

  return (
    <article className="library-row">
      <div className="library-row-head">
        <div className="library-identity">
          {row.avatar ? (
            <img className="library-avatar" src={row.avatar} alt="" />
          ) : (
            <span className="library-avatar-fallback" aria-hidden="true">
              {row.handle.slice(0, 1).toUpperCase()}
            </span>
          )}
          <div className="library-identity-text">
            <h3>{row.name}</h3>
            <span>@{row.handle}</span>
          </div>
        </div>
        <div className="library-row-badges">
          <Badge tone={stateMeta.tone}>{stateMeta.label}</Badge>
          {job && (
            <Badge tone={acquisitionStatusTone(job.status)}>
              {acquisitionStatusLabel(job.status)}
            </Badge>
          )}
        </div>
      </div>

      <p className="library-muted">{stateMeta.detail}</p>

      <div className="library-row-meta">
        <span>
          Searchable posts: <strong>{countWithUnit(row.searchablePostCount)}</strong>
          {row.searchablePostCountAsOf !== undefined &&
            ` (as of ${formatRelative(row.searchablePostCountAsOf)})`}
        </span>
        {row.lastPublishedAt !== undefined && (
          <span>Last published {formatRelative(row.lastPublishedAt)}</span>
        )}
        {job && (
          <span>
            {job.status === "running" || job.status === "queued" ? "Downloading" : "Last run"}{" "}
            {formatRelative(job.updatedAt)}
            {stalled && " — no update in over 10m, may be stalled"}
          </span>
        )}
      </div>

      {row.publicationState === "failed" && hasGoodCorpus && (
        <p className="library-row-note">
          The previously confirmed index still has {countWithUnit(row.searchablePostCount)}{" "}
          searchable — the failure below is about the latest refresh only, not the existing corpus.
        </p>
      )}
      {row.lastError && (
        <p className="library-row-failure">
          Publication error ({formatRelative(row.lastError.observedAt)}): {row.lastError.message}
        </p>
      )}
      {needsFailureDetail && (
        <p className="library-row-failure">
          {history === undefined
            ? "Loading failure details…"
            : currentRun
              ? describeRunOutcome(currentRun)
              : "Download failed. Expand history below for details."}
        </p>
      )}

      <div className="library-row-actions">
        <NextActionControl
          action={row.nextAction}
          busy={busy}
          onRetry={(jobId) => act(() => retry({ jobId }))}
        />
        {job && (job.status === "running" || job.status === "queued") && (
          <button disabled={busy} onClick={() => act(() => cancel({ jobId: job.jobId }))}>
            Stop
          </button>
        )}
        <button
          className="library-row-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? "Hide history" : "Show history"}
        </button>
      </div>
      {error && (
        <p role="alert" className="library-row-failure">
          {error}
        </p>
      )}

      {expanded && <AccountHistory history={history} />}
    </article>
  );
}

// No "continue" case: acquisition never waits on a person to ask for the
// next page or to retry a transient failure — convex/jobs.ts `finish`
// requeues the job on its own (convex/lib/contracts.ts nextActionValidator).
// "wait" covers both a paging continuation and a backed-off retry, since
// both are the same thing from here: a queued job with a future `readyAt`.
// "retry" only ever appears for a genuinely stopped run.
function NextActionControl({
  action,
  busy,
  onRetry,
}: {
  action: NextAction;
  busy: boolean;
  onRetry: (jobId: Id<"jobs">) => void;
}) {
  // The query reports the scheduled time; whether it has passed is decided
  // here against the dashboard's ticking clock (see convex/library.ts).
  const now = useDashboardClock();
  if (action.kind === "retry")
    return (
      <button disabled={busy} onClick={() => onRetry(action.jobId)}>
        {busy ? "Retrying…" : "Retry"}
      </button>
    );
  if (action.kind === "wait")
    return (
      <span className="library-muted">
        {action.readyAt > now
          ? `Retrying automatically at ${new Date(action.readyAt).toLocaleTimeString()}`
          : "Retrying automatically…"}
      </span>
    );

  return null;
}

/** Expandable per-account history: every run, newest first, with its
 * receipts and failure evidence — retries and batches are never deleted or
 * collapsed to hide duplicates (to-do.md P0). Raw fields (phase/error text,
 * receipt ids) stay behind a `<details>` disclosure per run. */
function AccountHistory({ history }: { history: HistoryRun[] | undefined }) {
  if (history === undefined) return <p className="library-loading">Loading history…</p>;

  if (history.length === 0) return <p className="library-muted">No runs recorded yet.</p>;

  return (
    <div className="library-history">
      {history.map((run) => (
        <div className="library-history-run" key={run.jobId}>
          <div className="run-head">
            <Badge tone={acquisitionStatusTone(run.status)}>
              {acquisitionStatusLabel(run.status)}
            </Badge>
            <span className="library-muted">
              Attempt {run.attempt} · {formatRelative(run.updatedAt)}
            </span>
          </div>
          <p>{describeRunOutcome(run)}</p>
          {(run.receipts.length > 0 || run.phase || run.error) && (
            <details className="library-raw-details">
              <summary>
                {run.receipts.length} receipt{run.receipts.length === 1 ? "" : "s"} · raw
                diagnostics
              </summary>
              <div className="library-history-receipts">
                {run.receipts.map((r) => (
                  <div key={r.receiptId}>
                    <strong>{r.records} records</strong> · capture <code>{r.captureId}</code> ·
                    receipt <code>{r.receiptId}</code>
                  </div>
                ))}
                {run.phase && <div>Last phase: {run.phase}</div>}
                {run.error && <div>Raw error: {run.error}</div>}
              </div>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}
