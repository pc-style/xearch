import { createSignal, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useQuery } from "./data/convex";
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
export function JobRow(props: {
  job: Doc<"jobs">;
  /** A live clock from the caller (see src/library/clock.ts) — never read
   * from `Date.now()` here, which would freeze at whatever instant this row
   * was created instead of ever advancing on its own. */
  now: number;
  /** How many older runs for this exact (kind, input) were folded into this
   * row — see `dedupeJobsByInput` in src/jobText.ts. Shown as a line inside
   * "Technical details" rather than as a separate row for each one. */
  earlierCount?: number;
  class?: string;
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
  extraActions?: JSX.Element;
}) {
  const [expanded, setExpanded] = createSignal(false);

  const receipts = useQuery(api.jobs.receipts, () =>
    expanded() ? { jobId: props.job._id } : "skip",
  );

  const { busy, message, run } = useTask();

  const active = () => props.job.status === "queued" || props.job.status === "running";
  const dismissed = () => props.job.dismissedAt !== undefined;
  const permanent = () => isPermanentFailure(props.job);

  const retryable = () =>
    ["failed", "partial", "cancelled"].includes(props.job.status) && !permanent();

  const canCancel = () => active() && Boolean(props.onCancel);
  const canRetry = () => retryable() && Boolean(props.onRetry);
  const canDismiss = () => !active() && !dismissed() && Boolean(props.onDismiss);
  const disabledTitle = () => (props.isOperator ? undefined : OPERATOR_SIGN_IN_NOTICE);
  const locked = () => busy() || !props.isOperator;

  return (
    <article class={props.class ?? "job"}>
      <div class="job-row-heading">
        <div>
          <strong>{jobKindLabel(props.job)}</strong>
          <p class="job-row-time muted-copy">
            {relativeTime(props.job.updatedAt, props.now)}
            {/* Several failed "Conversation on @handle's post" rows can share
                the same label, the same rounded age ("5m ago"), and the same
                retained-record summary — the exact start time is the other
                half of their stable identity. Only for "post" kind: every
                other kind's identity (a handle, a search string) is already
                distinct without it. */}
            {props.job.kind === "post"
              ? ` · started ${exactClockTime(props.job._creationTime)}`
              : ""}
          </p>
        </div>
        <span class={["job-status", props.job.status]}>{jobLabel(props.job)}</span>
      </div>
      <p>{jobSummary(props.job)}</p>
      <Show when={discoveredVia(props.job)}>{(via) => <p class="muted-copy">{via()}</p>}</Show>
      <For each={jobWarnings(props.job)}>{(w) => <p class="muted-copy">{w}</p>}</For>
      <div class="job-row-actions">
        <Show when={canCancel()}>
          <button
            type="button"
            disabled={locked()}
            title={disabledTitle()}
            onClick={() => void run(() => props.onCancel!(props.job))}
          >
            Cancel
          </button>
        </Show>
        <Show when={canRetry()}>
          <button
            type="button"
            disabled={locked()}
            title={disabledTitle()}
            onClick={() => void run(() => props.onRetry!(props.job))}
          >
            Retry
          </button>
        </Show>
        <Show when={permanent()}>
          <span class="muted-copy">x.md can't fetch this</span>
        </Show>
        <Show when={canDismiss()}>
          <button
            type="button"
            disabled={locked()}
            title={disabledTitle()}
            onClick={() => void run(() => props.onDismiss!(props.job))}
          >
            Clear from list
          </button>
        </Show>
        {props.extraActions}
      </div>
      <Show when={props.isOperator === false && (canCancel() || canRetry() || canDismiss())}>
        <p class="muted-copy">{OPERATOR_SIGN_IN_NOTICE}</p>
      </Show>
      <Show when={message()}>
        <p role="alert" class="config-warning">
          {message()}
        </p>
      </Show>
      <details
        class="job-row-details"
        open={expanded()}
        onToggle={(e) => setExpanded(e.currentTarget.open)}
      >
        <summary>Technical details</summary>
        <p>{jobPhaseDetail(props.job, props.now)}</p>
        {/* The label above never shows the raw status URL (jobKindLabel /
            conversationLabel keep it to a handle + short post id) — this is
            the one place it is available, for whoever needs to open the
            actual conversation. */}
        <Show when={props.job.kind === "post"}>
          <p class="muted-copy">
            <code>{props.job.input}</code>
          </p>
        </Show>
        <Show when={props.job.error}>
          <p class="config-warning">{props.job.error}</p>
        </Show>
        <Show when={props.earlierCount}>
          <p class="muted-copy">
            {props.earlierCount} earlier {props.earlierCount === 1 ? "run" : "runs"} for this same
            input.
          </p>
        </Show>
        <Show when={receipts()} fallback={"Loading receipts…"}>
          {(list) => (
            <Show when={list().length} fallback={"No durable acknowledgments yet."}>
              <For each={list()}>
                {(r) => (
                  <div>
                    <strong>{r.records} saved response files</strong>
                    <code>{r.receiptId}</code>
                  </div>
                )}
              </For>
            </Show>
          )}
        </Show>
      </details>
    </article>
  );
}
