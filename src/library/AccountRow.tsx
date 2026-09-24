import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { AccountLibraryRow, NextAction } from "../../convex/lib/contracts";
import type { HistoryRun } from "../../convex/library";
import type { Id } from "../../convex/_generated/dataModel";
import { useTask } from "../errors";
import { acquisitionStatusLabel, describeRunOutcome, discoveredVia } from "../jobText";
import {
  PUBLICATION_STATE_META,
  acquisitionStatusTone,
  countWithUnit,
  formatRelative,
  isStalledRun,
} from "./format";
import { Badge } from "./format.tsx";
import { useDashboardClock } from "./clock";
import { operatorArgs } from "../operatorToken";

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
  // only exist on the matching HistoryRun. That detail now renders only
  // inside the expanded row (QA finding 5 moved it behind "Show history"),
  // so the query is expanded-only too — still exclusively
  // convex/library.ts's `history` query.
  const needsFailureDetail = !!job && (job.status === "failed" || job.status === "partial");

  const history = useQuery(api.library.history, expanded ? { accountId: row.accountId } : "skip");

  const retry = useMutation(api.jobs.retry);
  const cancel = useMutation(api.jobs.cancel);

  const currentRun = job && history?.find((h) => h.jobId === job.jobId);
  const stateMeta = PUBLICATION_STATE_META[row.publicationState];
  const hasGoodCorpus = row.searchablePostCount.kind === "known";

  // /tmp/issues.md item 1: a completed base import's own "Download
  // complete · Last run 11m ago" badge/line used to keep showing even while
  // this same account had an older-history backfill actively downloading
  // (row.historyJob, a DIFFERENT job than row.latestJob's base import — see
  // convex/lib/contracts.ts's own comment on `historyJob`) — a person had no
  // way to tell, from the headline alone, that anything was still running.
  // Only ever set when the backfill window job is actually queued/running,
  // so a stopped/complete backfill still leaves the base import's own badge
  // and "Last run" line as the headline (its own outcome is described by
  // `backfillSummary` below either way).
  const activeHistoryJob =
    row.historyJob && (row.historyJob.status === "queued" || row.historyJob.status === "running")
      ? row.historyJob
      : undefined;

  const stalled = activeHistoryJob
    ? isStalledRun(activeHistoryJob.status, activeHistoryJob.updatedAt)
    : job
      ? isStalledRun(job.status, job.updatedAt)
      : false;

  // A callback ref, not a `useEffect` (this app's own no-`useEffect`-in-app-
  // code rule): src/library/QueueTimeline.tsx's "Show in dashboard" sets
  // `location.hash` to this exact id AFTER calling `close()`, but `close()`'s
  // state update hasn't rendered yet at that point — App.tsx mounts
  // QueueTimeline and Dashboard from separate, mutually exclusive branches,
  // so this row does not exist in the DOM the instant the hash is set. The
  // browser's own hash-navigation only tries once, right then, and never
  // retries once the element later mounts (CodeRabbit) — so this scrolls
  // itself into view on mount instead of depending on that native behavior.
  // Built once via `useState` (the same "stable callback" pattern
  // src/errors.ts `useTask` uses for its own runner) so it fires exactly
  // once per real mount, never once per re-render from an inline arrow
  // function getting a new identity every time.
  const [scrollIntoViewIfTargeted] = useState<(el: HTMLElement | null) => void>(() => {
    return (el: HTMLElement | null) => {
      if (!el || typeof window === "undefined") return;
      const hash = `#account-${row.accountId}`;

      if (window.location.hash !== hash) return;
      el.scrollIntoView({ block: "center" });
      // Consumed, not left standing: without this, filtering the list (which
      // can remount this same row) would silently re-trigger the scroll later.
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    };
  });

  return (
    // `id` is the anchor target `scrollIntoViewIfTargeted` above looks for.
    <article className="library-row" id={`account-${row.accountId}`} ref={scrollIntoViewIfTargeted}>
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
          {activeHistoryJob ? (
            <Badge tone={acquisitionStatusTone(activeHistoryJob.status)}>
              {activeHistoryJob.status === "queued"
                ? "Older history queued"
                : "Downloading older history"}
            </Badge>
          ) : (
            job && (
              <Badge tone={acquisitionStatusTone(job.status)}>
                {acquisitionStatusLabel(job.status)}
              </Badge>
            )
          )}
        </div>
      </div>

      {/* Compact one-line row body (QA finding 5,
          /tmp/issues-t3-dashboard-current.md #5): identity/badges above,
          then just the searchable count and one short state line. Every
          other publication note (the "Download complete" caveat, deep-
          history backfill progress, discovered-via text, the good-corpus-
          despite-failure note, the last publication error, and the failed-
          run explanation) moves behind the row's existing expand control —
          same `expanded` state as "Show history" already used, not a new
          toggle. The section-level disclaimer above the whole list (see
          AccountLibrary.tsx) replaces this row repeating
          DOWNLOAD_COMPLETE_CAVEAT on every completed account. */}
      <div className="library-row-meta">
        <span>
          Searchable posts: <strong>{countWithUnit(row.searchablePostCount)}</strong>
        </span>
        {/* The one state line follows whichever job is actually the newest
            activity on this account: the backfill window while it's running,
            else the base import. "Last published" lives in the expanded
            details (compact row). */}
        {activeHistoryJob ? (
          <span>
            {activeHistoryJob.status === "queued"
              ? "Older history queued"
              : "Downloading older history"}{" "}
            {formatRelative(activeHistoryJob.updatedAt)}
            {stalled && " — no update in over 10m, may be stalled"}
          </span>
        ) : (
          job && (
            <span>
              {job.status === "running" || job.status === "queued" ? "Downloading" : "Last run"}{" "}
              {formatRelative(job.updatedAt)}
              {stalled && " — no update in over 10m, may be stalled"}
            </span>
          )
        )}
      </div>

      <div className="library-row-actions">
        <NextActionControl
          action={row.nextAction}
          busy={busy}
          onRetry={(jobId) => act(() => retry({ jobId, ...operatorArgs() }))}
        />
        {/* Stops whichever job is actually the active one — the backfill
            window while it's running, else the base import — matching the
            headline badge/"Last run" line above. Without this, a running
            backfill (base import already "complete") had no Stop control at
            all: the old condition only ever looked at `job` (the base
            import). Computed as one value rather than a `||`/`??` chain in
            the JSX itself so `onClick` never needs a non-null assertion to
            reach back into that chain. */}
        {(() => {
          const stoppableJob =
            activeHistoryJob ??
            (job && (job.status === "running" || job.status === "queued") ? job : undefined);

          return (
            stoppableJob && (
              <button
                disabled={busy}
                onClick={() => act(() => cancel({ jobId: stoppableJob.jobId, ...operatorArgs() }))}
              >
                Stop
              </button>
            )
          );
        })()}
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

      {expanded && (
        <div className="library-row-details">
          <p className="library-muted">{stateMeta.detail}</p>
          {row.searchablePostCountAsOf !== undefined && (
            <p className="library-muted">
              Searchable count as of {formatRelative(row.searchablePostCountAsOf)}
            </p>
          )}
          {row.lastPublishedAt !== undefined && (
            <p className="library-muted">Last published {formatRelative(row.lastPublishedAt)}</p>
          )}
          {discoveredVia(job) && <p className="library-muted">{discoveredVia(job)}</p>}
          {row.backfill && <p className="library-muted">{backfillSummary(row.backfill)}</p>}
          {row.publicationState === "failed" && hasGoodCorpus && (
            <p className="library-row-note">
              The previously confirmed index still has {countWithUnit(row.searchablePostCount)}{" "}
              searchable — the failure below is about the latest refresh only, not the existing
              corpus.
            </p>
          )}
          {row.lastError && (
            <p className="library-row-failure">
              Publication error ({formatRelative(row.lastError.observedAt)}):{" "}
              {row.lastError.message}
            </p>
          )}
          {needsFailureDetail && (
            <p className="library-row-failure">
              {history === undefined
                ? "Loading failure details…"
                : currentRun
                  ? describeRunOutcome(currentRun)
                  : "Download failed. See the run history below for details."}
            </p>
          )}
          <AccountHistory history={history} />
        </div>
      )}
    </article>
  );
}

/**
 * The account library row's one summary line for its deep-history backfill
 * (convex/jobs.ts, convex/lib/historyWindow.ts) — never more than one line,
 * and never a second post count competing with `row.searchablePostCount`
 * above. `postsFound` counts posts x.md handed over during the backfill —
 * DOWNLOADED, not indexed — so this always says "downloaded", never "found"
 * or a bare count that could be misread as this many are now searchable;
 * whether they are is the indexer's own separate job (see
 * AccountLibrary.tsx's DOWNLOAD_COMPLETE_CAVEAT note, which makes the same
 * distinction for the ordinary bulk-download badge).
 */
function backfillSummary(backfill: NonNullable<AccountLibraryRow["backfill"]>): string {
  const downloaded = `${backfill.postsFound.toLocaleString()} post${backfill.postsFound === 1 ? "" : "s"} downloaded`;

  if (backfill.status === "complete")
    return `Older history download complete: ${downloaded}; search publication is separate`;

  if (backfill.status === "stopped")
    return `Older history stopped: ${backfill.error ?? "an unreported error"}`;

  const joined = backfill.joined ? ` (joined ${backfill.joined})` : "";

  return `Older history: ${downloaded} so far · downloading back to ${backfill.cursorUntil}${joined}`;
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
