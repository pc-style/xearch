import { createSignal, For, Show } from "solid-js";
import { useMutation } from "../data/convex";
import { api } from "../../convex/_generated/api";
import type { AccountLibraryRow, JobStatus } from "../../convex/lib/contracts";
import type { Id } from "../../convex/_generated/dataModel";
import { acquisitionStatusLabel, historyWindowRange } from "../jobText";
import { describeError } from "../errors";
import { acquisitionStatusTone, formatRelative, isStalledRun } from "./format";
import { Badge } from "./format.tsx";
import { operatorArgs } from "../operatorToken";

// Which of an account's two job fields is currently active — its base
// import (`latestJob`, always "bulk") or its deep-history backfill window
// (`historyJob`, always "live"/"history"). Usually only one is ever
// queued/running at once (a backfill only starts once the base import has
// reached a terminal state — convex/jobs.ts `maybeStartHistoryBackfill`
// runs from `finish`), but a person can start a fresh bulk refresh while an
// earlier backfill window is still running, so both CAN be active at the
// same time. `historyJob` is checked first — matching
// src/library/AccountRow.tsx's own `activeHistoryJob` priority for the same
// row — so this strip's Stop button always targets the same job that row
// itself displays and stops, never the other one.
type ActiveJob = { jobId: Id<"jobs">; status: JobStatus; updatedAt: number; isHistory: boolean };

function activeJobOf(row: AccountLibraryRow): ActiveJob | undefined {
  const history = row.historyJob;

  if (history && (history.status === "queued" || history.status === "running"))
    return {
      jobId: history.jobId,
      status: history.status,
      updatedAt: history.updatedAt,
      isHistory: true,
    };

  const base = row.latestJob;

  if (base && (base.status === "queued" || base.status === "running"))
    return { jobId: base.jobId, status: base.status, updatedAt: base.updatedAt, isHistory: false };

  return undefined;
}

type ActiveRow = { row: AccountLibraryRow; job: ActiveJob };

/**
 * The compact "what's downloading right now" strip. Built from
 * `AccountLibraryRow.latestJob` AND `.historyJob` (both already returned by
 * `convex/library.ts rows`) — no separate job-list query — so it can only
 * ever show account-identified acquisition, never the non-account
 * live/post/etc. jobs that to-do.md P0 says must stay out of this list.
 */
export default function ActiveQueue(props: {
  rows: AccountLibraryRow[] | undefined;
  isAuthenticated: boolean;
  // Optional: tests/signed-out-states.test.ts renders this alongside
  // RecentActivity from one shared props object that has no reason to know
  // about Queue navigation.
  onOpenQueue?: () => void;
}) {
  const active = () =>
    (props.rows ?? []).flatMap((row): ActiveRow[] => {
      const job = activeJobOf(row);

      return job ? [{ row, job }] : [];
    });

  return (
    <section class="library-section" aria-label="Active queue">
      <div class="library-section-head">
        <h2>Active queue</h2>
        {/* The full worker timeline — every queued/running/retryable job,
            with wait reasons and ETAs — is a separate operator page
            (src/library/QueueTimeline.tsx); this strip stays the compact
            "what's downloading right now" summary. Goes through the
            App-provided `onOpenQueue` so the pushed history entry is tracked
            for a correct Back — see src/App.tsx's `openQueue`. */}
        <button type="button" class="text-button" onClick={() => props.onOpenQueue?.()}>
          See timeline
        </button>
      </div>
      <Show
        when={props.rows}
        fallback={
          // `undefined` means either "query skipped because signed out" or
          // "still in flight" -- different states, different labels.
          <Show
            when={props.isAuthenticated}
            fallback={<p class="library-muted">Connect to see work in progress.</p>}
          >
            <p class="library-loading">Loading queue…</p>
          </Show>
        }
      >
        <Show
          when={active().length}
          fallback={<p class="library-muted">Nothing is downloading right now.</p>}
        >
          <div class="library-queue-list">
            <For each={active()} keyed={(entry) => entry.row.accountId}>
              {(entry) => <QueueRow row={entry().row} job={entry().job} />}
            </For>
          </div>
        </Show>
      </Show>
    </section>
  );
}

function QueueRow(props: ActiveRow) {
  const cancel = useMutation(api.jobs.cancel);
  const [error, setError] = createSignal("");
  const job = () => props.job;
  const stalled = () => isStalledRun(job().status, job().updatedAt);

  const stop = async () => {
    setError("");

    try {
      await cancel({ jobId: job().jobId, ...operatorArgs() });
    } catch (e) {
      setError(describeError(e));
    }
  };

  return (
    <div class="library-queue-row">
      <span class="library-queue-identity">
        {props.row.name} <span class="library-muted">@{props.row.handle}</span>
        <Show when={job().isHistory && props.row.historyJob}>
          {(history) => (
            <span class="library-muted">
              {" "}
              — {historyWindowRange(history().since ?? "", history().until ?? "")}
            </span>
          )}
        </Show>
      </span>
      <span class={stalled() ? "stalled" : undefined}>
        {stalled()
          ? `No update in over 10m — may be stalled (${acquisitionStatusLabel(job().status)})`
          : acquisitionStatusLabel(job().status)}
      </span>
      <Badge tone={acquisitionStatusTone(job().status)}>{formatRelative(job().updatedAt)}</Badge>
      <button type="button" onClick={stop}>
        Stop
      </button>
      <Show when={error()}>
        <span role="alert" class="library-row-failure">
          {error()}
        </span>
      </Show>
    </div>
  );
}
