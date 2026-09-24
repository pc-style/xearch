import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { DashboardSummary } from "../../convex/lib/contracts";
import type { ServiceStatus } from "../../convex/summary";
import type { ProviderLimit } from "../../convex/limits";
import { countValue, formatRelative } from "./format";
import StatusBlock from "./StatusBlock";

type OperatorConfig = FunctionReturnType<typeof api.integrations.operator>;

/**
 * "Indexed posts", "Indexed people", the queue breakdown, and service
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

export default function OverviewStats({
  summary,
  health,
  limits,
  config,
  connected,
  isAuthenticated,
}: {
  summary: DashboardSummary | undefined;
  health: ServiceStatus[] | undefined;
  limits: ProviderLimit[] | undefined;
  config: OperatorConfig | undefined;
  connected: boolean;
  isAuthenticated: boolean;
}) {
  // A skipped Convex query returns `undefined`, exactly like one still in
  // flight -- so a signed-out visitor used to sit on "Loading overview..."
  // forever. Not connected yet is a different state from still loading, and
  // the two must not share a label (to-do.md P0: configuration, connectivity,
  // download completion and publication are distinct states).
  return (
    <section className="library-section" aria-label="Overview">
      <div className="library-section-head">
        <h2>Overview</h2>
        {summary && (
          <p className="library-muted">
            As of {formatRelative(summary.observedAt)} · {scopeLabel(summary.scope)}
            {!connected && " · reconnecting — figures reflect the last data received"}
          </p>
        )}
      </div>
      {!isAuthenticated ? (
        <p className="library-muted">Connect to see your indexed posts, people and queue.</p>
      ) : !summary ? (
        <p className="library-loading">Loading overview…</p>
      ) : (
        <div className="library-stats-grid">
          <Stat label="Indexed posts" count={summary.indexedPosts} />
          {/* Links to the account library below. Both are now built from the
              same shared account set (convex/summary.ts), so this
              number is genuinely the length of the list it points at — it is
              a real link, not a navigation gesture past a mismatch. */}
          <Stat label="Indexed people" count={summary.indexedAccounts} href="#account-library" />
          <Stat label="Waiting downloads" count={summary.queue.waitingDownloads} />
          <Stat label="Active downloads" count={summary.queue.activeDownloads} />
          <Stat
            label="Saved captures awaiting indexing"
            count={summary.queue.savedCapturesAwaitingIndexing}
          />
          {/* The indexer's own backlog for the shared accounts, one tile per unit
              it can report in (convex/lib/contracts.ts
              providerQueuedWorkValidator). Never added together: a capture
              is a file and a job is a run, and neither is a post. The indexer
              has never sent `pendingWork` in practice, so these three stay
              "unknown" indefinitely today — rather than show that as a
              permanent, unexplained "unknown" tile (A4), each one renders
              nothing until the indexer actually reports a unit, and reappears
              on its own the moment it does. */}
          {summary.providerQueuedWork.posts.kind === "known" && (
            <Stat label="Queued posts" count={summary.providerQueuedWork.posts} />
          )}
          {summary.providerQueuedWork.captures.kind === "known" && (
            <Stat label="Queued captures" count={summary.providerQueuedWork.captures} />
          )}
          {summary.providerQueuedWork.jobs.kind === "known" && (
            <Stat label="Queued indexer jobs" count={summary.providerQueuedWork.jobs} />
          )}
          <Stat label="Failed & retryable" count={summary.queue.failedRetryable} />
        </div>
      )}
      <StatusBlock
        config={config}
        health={health}
        limits={limits}
        isAuthenticated={isAuthenticated}
      />
    </section>
  );
}

function Stat({
  label,
  count,
  href,
}: {
  label: string;
  count: DashboardSummary["indexedPosts"];
  /** When set, the whole tile becomes a real link (an `<a>`, not a JS-only
   * click handler) to that in-page section — e.g. the account library. */
  href?: string;
}) {
  const unknown = count.kind === "unknown";

  // A3: the tile used to repeat its own number on a second line ("9,006 /
  // INDEXED POSTS / 9,006 posts"). The label already says what unit this is,
  // so the value alone is the whole tile now — nothing invented to replace
  // the redundant line with.
  const body = (
    <>
      <span className={`value${unknown ? " unknown" : ""}`}>{countValue(count)}</span>
      <span className="label">{label}</span>
    </>
  );

  if (href) {
    return (
      <a className="library-stat library-stat-link" href={href}>
        {body}
      </a>
    );
  }

  return <div className="library-stat">{body}</div>;
}
