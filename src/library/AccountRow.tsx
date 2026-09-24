import { createSignal, For, Match, onSettled, Show, Switch } from "solid-js";
import { useMutation, useQuery } from "../data/convex";
import { api } from "../../convex/_generated/api";
import type { AccountLibraryRow, NextAction } from "../../convex/lib/contracts";
import type { HistoryRun } from "../../convex/library";
import type { Id } from "../../convex/_generated/dataModel";
import { useTask } from "../errors";
import { acquisitionStatusLabel, describeRunOutcome, discoveredVia } from "../jobText";
import { Avatar } from "../Avatar";
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
export default function AccountRow(props: { row: AccountLibraryRow }) {
  const [expanded, setExpanded] = createSignal(false);
  const { busy, message: error, run: act } = useTask();
  const job = () => props.row.latestJob;

  // A failed/partial latest job's own `phase` field is stale progress text
  // left over from before it stopped (convex/jobs.ts finish never clears it
  // on failure) — never the actual failure. The real error/retained-count
  // only exist on the matching HistoryRun. That detail renders only inside
  // the expanded row (QA finding 5 moved it behind "Show history"), so the
  // query is expanded-only too — still exclusively convex/library.ts's
  // `history` query.
  const needsFailureDetail = () => {
    const status = job()?.status;

    return status === "failed" || status === "partial";
  };

  const history = useQuery(api.library.history, () =>
    expanded() ? { accountId: props.row.accountId } : "skip",
  );

  const retry = useMutation(api.jobs.retry);
  const cancel = useMutation(api.jobs.cancel);

  const currentRun = () => {
    const latest = job();

    return latest ? history()?.find((h) => h.jobId === latest.jobId) : undefined;
  };

  const stateMeta = () => PUBLICATION_STATE_META[props.row.publicationState];
  const hasGoodCorpus = () => props.row.searchablePostCount.kind === "known";

  // /tmp/issues.md item 1: a completed base import's own "Download complete
  // · Last run 11m ago" used to keep showing while this same account had an
  // older-history backfill actively downloading (row.historyJob, a
  // DIFFERENT job than row.latestJob's base import). Only set while the
  // backfill window job is actually queued/running, so a stopped/complete
  // backfill leaves the base import as the headline (its own outcome is
  // described by `backfillSummary` either way).
  const activeHistoryJob = () => {
    const history = props.row.historyJob;

    return history && (history.status === "queued" || history.status === "running")
      ? history
      : undefined;
  };

  // Whichever job is actually the newest activity on this account: the
  // backfill window while it's running, else a queued/running base import.
  // The headline, the state line and Stop all follow this one job.
  const activeJob = () => {
    const latest = job();

    return (
      activeHistoryJob() ??
      (latest && (latest.status === "running" || latest.status === "queued") ? latest : undefined)
    );
  };

  const stalled = () => {
    const current = activeJob() ?? job();

    return current ? isStalledRun(current.status, current.updatedAt) : false;
  };

  // "Queued" is not "Downloading": a queued job has not started, and the
  // badge beside this line already says "Queued to download".
  const stateLine = () => {
    const current = activeJob();

    if (!current) return "Last run";

    if (current === activeHistoryJob())
      return current.status === "queued" ? "Older history queued" : "Downloading older history";

    return current.status === "queued" ? "Queued" : "Downloading";
  };

  // src/library/QueueTimeline.tsx's "Show in dashboard" sets `location.hash`
  // to this row's id right after closing the Queue page — before this row
  // exists, since App mounts the two pages from separate branches. The
  // browser's own hash navigation only tries once, then, so the row scrolls
  // itself into view once it has mounted.
  let article: HTMLElement | undefined;

  onSettled(() => {
    if (!article || window.location.hash !== `#account-${props.row.accountId}`) return;
    article.scrollIntoView({ block: "center" });
    // Consumed, not left standing: filtering the list can remount this same
    // row, which would otherwise re-trigger the scroll later.
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  });

  return (
    <article
      class="library-row"
      id={`account-${props.row.accountId}`}
      ref={(el) => {
        article = el;
      }}
    >
      <div class="library-row-head">
        <div class="library-identity">
          <Avatar
            name={props.row.handle}
            url={props.row.avatar}
            class="library-avatar"
            fallbackClass="library-avatar-fallback"
            letters={1}
          />
          <div class="library-identity-text">
            <h3>{props.row.name}</h3>
            <span>@{props.row.handle}</span>
          </div>
        </div>
        <div class="library-row-badges">
          <Badge tone={stateMeta().tone}>{stateMeta().label}</Badge>
          <Show
            when={activeHistoryJob()}
            fallback={
              <Show when={job()}>
                {(latest) => (
                  <Badge tone={acquisitionStatusTone(latest().status)}>
                    {acquisitionStatusLabel(latest().status)}
                  </Badge>
                )}
              </Show>
            }
          >
            {(history) => (
              <Badge tone={acquisitionStatusTone(history().status)}>{stateLine()}</Badge>
            )}
          </Show>
        </div>
      </div>

      {/* Compact one-line row body (QA finding 5): identity/badges above,
          then just the searchable count and one short state line. Every
          other publication note moves behind the row's existing expand
          control; AccountLibrary.tsx shows the "Download complete" caveat
          once for the whole list. */}
      <div class="library-row-meta">
        <span>
          Searchable posts: <strong>{countWithUnit(props.row.searchablePostCount)}</strong>
        </span>
        <Show when={activeJob() ?? job()}>
          {(current) => (
            <span>
              {stateLine()} {formatRelative(current().updatedAt)}
              {stalled() && " — no update in over 10m, may be stalled"}
            </span>
          )}
        </Show>
      </div>

      <div class="library-row-actions">
        <NextActionControl
          action={props.row.nextAction}
          busy={busy()}
          onRetry={(jobId) => act(() => retry({ jobId, ...operatorArgs() }))}
        />
        {/* Stops whichever job is actually the active one — the backfill
            window while it's running, else the base import — matching the
            headline above. */}
        <Show when={activeJob()}>
          {(current) => (
            <button
              type="button"
              disabled={busy()}
              onClick={() => act(() => cancel({ jobId: current().jobId, ...operatorArgs() }))}
            >
              Stop
            </button>
          )}
        </Show>
        <button
          type="button"
          class="library-row-toggle"
          aria-expanded={expanded() ? "true" : "false"}
          onClick={() => {
            setExpanded(!expanded());
          }}
        >
          {expanded() ? "Hide history" : "Show history"}
        </button>
      </div>
      <Show when={error()}>
        <p role="alert" class="library-row-failure">
          {error()}
        </p>
      </Show>

      <Show when={expanded()}>
        <div class="library-row-details">
          <p class="library-muted">{stateMeta().detail}</p>
          <Show when={props.row.searchablePostCountAsOf}>
            {(asOf) => <p class="library-muted">Searchable count as of {formatRelative(asOf())}</p>}
          </Show>
          <Show when={props.row.lastPublishedAt}>
            {(at) => <p class="library-muted">Last published {formatRelative(at())}</p>}
          </Show>
          <Show when={discoveredVia(job())}>{(via) => <p class="library-muted">{via()}</p>}</Show>
          <Show when={props.row.backfill}>
            {(backfill) => <p class="library-muted">{backfillSummary(backfill())}</p>}
          </Show>
          <Show when={props.row.publicationState === "failed" && hasGoodCorpus()}>
            <p class="library-row-note">
              The previously confirmed index still has{" "}
              {countWithUnit(props.row.searchablePostCount)} searchable — the failure below is about
              the latest refresh only, not the existing corpus.
            </p>
          </Show>
          <Show when={props.row.lastError}>
            {(lastError) => (
              <p class="library-row-failure">
                Publication error ({formatRelative(lastError().observedAt)}): {lastError().message}
              </p>
            )}
          </Show>
          <Show when={needsFailureDetail()}>
            <p class="library-row-failure">
              {history() === undefined
                ? "Loading failure details…"
                : currentRun()
                  ? describeRunOutcome(currentRun()!)
                  : "Download failed. See the run history below for details."}
            </p>
          </Show>
          <AccountHistory history={history()} />
        </div>
      </Show>
    </article>
  );
}

/**
 * The account library row's one summary line for its deep-history backfill
 * (convex/jobs.ts, convex/lib/historyWindow.ts) — never more than one line,
 * and never a second post count competing with `row.searchablePostCount`
 * above. `postsFound` counts posts x.md handed over during the backfill —
 * DOWNLOADED, not indexed — so this always says "downloaded", never "found"
 * or a bare count that could be misread as this many are now searchable.
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
function NextActionControl(props: {
  action: NextAction;
  busy: boolean;
  onRetry: (jobId: Id<"jobs">) => void;
}) {
  // The query reports the scheduled time; whether it has passed is decided
  // here against the dashboard's ticking clock (see convex/library.ts).
  const now = useDashboardClock();

  return (
    <Switch>
      <Match when={props.action.kind === "retry" && props.action}>
        {(action) => (
          <button type="button" disabled={props.busy} onClick={() => props.onRetry(action().jobId)}>
            {props.busy ? "Retrying…" : "Retry"}
          </button>
        )}
      </Match>
      <Match when={props.action.kind === "wait" && props.action}>
        {(action) => (
          <span class="library-muted">
            {action().readyAt > now()
              ? `Retrying automatically at ${new Date(action().readyAt).toLocaleTimeString()}`
              : "Retrying automatically…"}
          </span>
        )}
      </Match>
    </Switch>
  );
}

/** Expandable per-account history: every run, newest first, with its
 * receipts and failure evidence — retries and batches are never deleted or
 * collapsed to hide duplicates (to-do.md P0). Raw fields (phase/error text,
 * receipt ids) stay behind a `<details>` disclosure per run. */
function AccountHistory(props: { history: HistoryRun[] | undefined }) {
  return (
    <Switch>
      <Match when={props.history === undefined}>
        <p class="library-loading">Loading history…</p>
      </Match>
      <Match when={props.history!.length === 0}>
        <p class="library-muted">No runs recorded yet.</p>
      </Match>
      <Match when={true}>
        <div class="library-history">
          <For each={props.history} keyed={(run) => run.jobId}>
            {(run) => (
              <div class="library-history-run">
                <div class="run-head">
                  <Badge tone={acquisitionStatusTone(run().status)}>
                    {acquisitionStatusLabel(run().status)}
                  </Badge>
                  <span class="library-muted">
                    Attempt {run().attempt} · {formatRelative(run().updatedAt)}
                  </span>
                </div>
                <p>{describeRunOutcome(run())}</p>
                <Show when={run().receipts.length > 0 || run().phase || run().error}>
                  <details class="library-raw-details">
                    <summary>
                      {run().receipts.length} receipt{run().receipts.length === 1 ? "" : "s"} · raw
                      diagnostics
                    </summary>
                    <div class="library-history-receipts">
                      <For each={run().receipts}>
                        {(r) => (
                          <div>
                            <strong>{r.records} records</strong> · capture{" "}
                            <code>{r.captureId}</code> · receipt <code>{r.receiptId}</code>
                          </div>
                        )}
                      </For>
                      <Show when={run().phase}>
                        <div>Last phase: {run().phase}</div>
                      </Show>
                      <Show when={run().error}>
                        <div>Raw error: {run().error}</div>
                      </Show>
                    </div>
                  </details>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Match>
    </Switch>
  );
}
