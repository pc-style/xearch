import { Show } from "solid-js";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { DashboardSummary } from "../../convex/lib/contracts";
import type { ServiceStatus } from "../../convex/summary";
import type { ProviderLimit } from "../../convex/limits";
import { countValue, formatRelative } from "./format";
import StatusBlock from "./StatusBlock";

type OperatorConfig = FunctionReturnType<typeof api.integrations.operator>;

/**
 * "Indexed posts", "Searchable accounts", the queue breakdown, and service
 * health — the P0 "simple, trustworthy stats" section. Every number here is
 * exactly what `convex/summary.ts` computed (a `Count` or a `ServiceStatus`)
 * with nothing re-derived client-side, so it can never drift from the
 * "never invent a number" rule in the frozen contract.
 */
/**
 * Plain words for the scope these figures cover. "global" is what
 * convex/summary.ts now returns: every imported account, shared across
 * everyone signed in — the imports are shared infrastructure, not personal
 * data (to-do.md). "owner" is kept as a declared shape for a future
 * per-person view; nothing currently returns it.
 */
function scopeLabel(scope: DashboardSummary["scope"]): string {
  if (scope.kind === "owner") return "your imports only";

  return scope.kind === "global" ? "shared across every signed-in user" : "one account";
}

export default function OverviewStats(props: {
  summary: DashboardSummary | undefined;
  health: ServiceStatus[] | undefined;
  limits: ProviderLimit[] | undefined;
  config: OperatorConfig | undefined;
  // The exact, unbucketed clock `config` was fetched against — see
  // src/library/clock.ts's `useLiveNow` comment for why the worker-liveness
  // fields on `config` can never be re-derived against the coarser,
  // bucketed `useDashboardClock` this component's other props use.
  liveNow: number;
  connected: boolean;
  isAuthenticated: boolean;
}) {
  // A skipped Convex query returns `undefined`, exactly like one still in
  // flight -- so a signed-out visitor used to sit on "Loading overview..."
  // forever. Not connected yet is a different state from still loading, and
  // the two must not share a label (to-do.md P0: configuration, connectivity,
  // download completion and publication are distinct states).
  return (
    <section class="library-section" aria-label="Overview">
      <div class="library-section-head">
        <h2>Overview</h2>
        <Show when={props.summary}>
          {(summary) => (
            <p class="library-muted">
              As of {formatRelative(summary().observedAt)} · {scopeLabel(summary().scope)}
              {!props.connected && " · reconnecting — figures reflect the last data received"}
            </p>
          )}
        </Show>
      </div>
      <Show
        when={props.isAuthenticated}
        fallback={<p class="library-muted">Connect to see your indexed posts, people and queue.</p>}
      >
        <Show when={props.summary} fallback={<p class="library-loading">Loading overview…</p>}>
          {(summary) => (
            <div class="library-stats-grid">
              <Stat label="Indexed posts" count={summary().indexedPosts} />
              {/* `indexedAccounts` counts only accounts whose publication
                  state is "searchable" — hence "Searchable accounts", not
                  "Imported accounts" (CodeRabbit finding on PR #46). It still
                  links to the full account library below, which lists every
                  imported account regardless of publication state. */}
              <Stat
                label="Searchable accounts"
                count={summary().indexedAccounts}
                href="#account-library"
              />
              <Stat label="Waiting downloads" count={summary().queue.waitingDownloads} />
              <Stat label="Active downloads" count={summary().queue.activeDownloads} />
              <Stat
                label="Saved captures awaiting indexing"
                count={summary().queue.savedCapturesAwaitingIndexing}
              />
              {/* The indexer's own backlog, one tile per unit it reports in,
                  never added together. Each renders nothing until the indexer
                  actually reports that unit (A4). */}
              <Show when={summary().providerQueuedWork.posts.kind === "known"}>
                <Stat label="Queued posts" count={summary().providerQueuedWork.posts} />
              </Show>
              <Show when={summary().providerQueuedWork.captures.kind === "known"}>
                <Stat label="Queued captures" count={summary().providerQueuedWork.captures} />
              </Show>
              <Show when={summary().providerQueuedWork.jobs.kind === "known"}>
                <Stat label="Queued indexer jobs" count={summary().providerQueuedWork.jobs} />
              </Show>
              <Stat label="Failed & retryable" count={summary().queue.failedRetryable} />
            </div>
          )}
        </Show>
      </Show>
      <StatusBlock
        config={props.config}
        health={props.health}
        limits={props.limits}
        liveNow={props.liveNow}
        isAuthenticated={props.isAuthenticated}
      />
    </section>
  );
}

function Stat(props: {
  label: string;
  count: DashboardSummary["indexedPosts"];
  /** When set, the whole tile becomes a real link (an `<a>`, not a JS-only
   * click handler) to that in-page section — e.g. the account library. */
  href?: string;
}) {
  // A3: the value alone is the whole tile — the label already says the unit.
  const body = () => (
    <>
      <span class={["value", { unknown: props.count.kind === "unknown" }]}>
        {countValue(props.count)}
      </span>
      <span class="label">{props.label}</span>
    </>
  );

  return (
    <Show when={props.href} fallback={<div class="library-stat">{body()}</div>}>
      {(href) => (
        <a class="library-stat library-stat-link" href={href()}>
          {body()}
        </a>
      )}
    </Show>
  );
}
