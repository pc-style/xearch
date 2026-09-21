import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import * as stylex from "@stylexjs/stylex";
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
import { ops } from "../styles/ops.stylex";

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
  const start = useMutation(api.jobs.start);
  const cancel = useMutation(api.jobs.cancel);

  const currentRun = job && history?.find((h) => h.jobId === job.jobId);
  const stateMeta = PUBLICATION_STATE_META[row.publicationState];
  const hasGoodCorpus = row.searchablePostCount.kind === "known";
  const stalled = job ? isStalledRun(job.status, job.updatedAt) : false;

  return (
    <article {...stylex.props(ops.row)}>
      <div {...stylex.props(ops.rowHead)}>
        <div {...stylex.props(ops.identity)}>
          {row.avatar ? (
            <img {...stylex.props(ops.avatar)} src={row.avatar} alt="" />
          ) : (
            <span {...stylex.props(ops.avatarFallback)} aria-hidden="true">
              {row.handle.slice(0, 1).toUpperCase()}
            </span>
          )}
          <div {...stylex.props(ops.identityText)}>
            <h3 {...stylex.props(ops.identityName)}>{row.name}</h3>
            <span {...stylex.props(ops.identityHandle)}>@{row.handle}</span>
          </div>
        </div>
        <div {...stylex.props(ops.rowBadges)}>
          <Badge tone={stateMeta.tone}>{stateMeta.label}</Badge>
          {job && (
            <Badge tone={acquisitionStatusTone(job.status)}>
              {acquisitionStatusLabel(job.status)}
            </Badge>
          )}
        </div>
      </div>

      <p {...stylex.props(ops.libraryMuted)}>{stateMeta.detail}</p>

      <div {...stylex.props(ops.rowMeta)}>
        <span>
          Searchable posts:{" "}
          <strong {...stylex.props(ops.rowMetaStrong)}>
            {countWithUnit(row.searchablePostCount)}
          </strong>
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
        <p {...stylex.props(ops.rowNote)}>
          The previously confirmed index still has {countWithUnit(row.searchablePostCount)}{" "}
          searchable — the failure below is about the latest refresh only, not the existing corpus.
        </p>
      )}
      {row.lastError && (
        <p {...stylex.props(ops.rowFailure)}>
          Publication error ({formatRelative(row.lastError.observedAt)}): {row.lastError.message}
        </p>
      )}
      {needsFailureDetail && (
        <p {...stylex.props(ops.rowFailure)}>
          {history === undefined
            ? "Loading failure details…"
            : currentRun
              ? describeRunOutcome(currentRun)
              : "Download failed. Expand history below for details."}
        </p>
      )}

      <div {...stylex.props(ops.rowActions)}>
        <NextActionControl
          action={row.nextAction}
          busy={busy}
          onRetry={(jobId) => act(() => retry({ jobId }))}
          onContinue={(jobId) =>
            act(() => start({ kind: "bulk", input: row.handle, previous: jobId }))
          }
        />
        {job && (job.status === "running" || job.status === "queued") && (
          <button
            {...stylex.props(ops.button)}
            disabled={busy}
            onClick={() => act(() => cancel({ jobId: job.jobId }))}
          >
            Stop
          </button>
        )}
        <button
          {...stylex.props(ops.button, ops.rowToggle)}
          aria-expanded={expanded}
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? "Hide history" : "Show history"}
        </button>
      </div>
      {error && (
        <p role="alert" {...stylex.props(ops.rowFailure)}>
          {error}
        </p>
      )}

      {expanded && <AccountHistory history={history} />}
    </article>
  );
}

function NextActionControl({
  action,
  busy,
  onRetry,
  onContinue,
}: {
  action: NextAction;
  busy: boolean;
  onRetry: (jobId: Id<"jobs">) => void;
  onContinue: (jobId: Id<"jobs">) => void;
}) {
  if (action.kind === "retry")
    return (
      <button {...stylex.props(ops.button)} disabled={busy} onClick={() => onRetry(action.jobId)}>
        {busy ? "Retrying…" : "Retry"}
      </button>
    );
  if (action.kind === "continue")
    return (
      <button
        {...stylex.props(ops.button)}
        disabled={busy}
        onClick={() => onContinue(action.jobId)}
      >
        {busy ? "Continuing…" : "Continue download"}
      </button>
    );
  if (action.kind === "wait")
    return (
      <span {...stylex.props(ops.libraryMuted)}>
        Retries automatically around {new Date(action.readyAt).toLocaleTimeString()}
      </span>
    );
  return null;
}

/** Expandable per-account history: every run, newest first, with its
 * receipts and failure evidence — retries and batches are never deleted or
 * collapsed to hide duplicates (to-do.md P0). Raw fields (phase/error text,
 * receipt ids) stay behind a `<details>` disclosure per run. */
function AccountHistory({ history }: { history: HistoryRun[] | undefined }) {
  if (history === undefined) return <p {...stylex.props(ops.loading)}>Loading history…</p>;
  if (history.length === 0) return <p {...stylex.props(ops.libraryMuted)}>No runs recorded yet.</p>;
  return (
    <div {...stylex.props(ops.history)}>
      {history.map((run) => (
        <div {...stylex.props(ops.historyRun)} key={run.jobId}>
          <div {...stylex.props(ops.historyRunHead)}>
            <Badge tone={acquisitionStatusTone(run.status)}>
              {acquisitionStatusLabel(run.status)}
            </Badge>
            <span {...stylex.props(ops.libraryMuted)}>
              Attempt {run.attempt} · {formatRelative(run.updatedAt)}
            </span>
          </div>
          <p {...stylex.props(ops.historyRunText)}>{describeRunOutcome(run)}</p>
          {(run.receipts.length > 0 || run.phase || run.error) && (
            <details>
              <summary {...stylex.props(ops.rawDetailsSummary)}>
                {run.receipts.length} receipt{run.receipts.length === 1 ? "" : "s"} · raw
                diagnostics
              </summary>
              <div {...stylex.props(ops.historyReceipts)}>
                {run.receipts.map((r) => (
                  <div key={r.receiptId}>
                    <strong>{r.records} records</strong> · capture{" "}
                    <code {...stylex.props(ops.historyReceiptCode)}>{r.captureId}</code> · receipt{" "}
                    <code {...stylex.props(ops.historyReceiptCode)}>{r.receiptId}</code>
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
