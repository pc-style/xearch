import type { DashboardSummary } from "../../convex/lib/contracts";
import type { ServiceStatus } from "../../convex/summary";
import type { ProviderLimit } from "../../convex/limits";
import { SERVICE_DISPLAY_NAME, serviceHealthLabel } from "../integrationStatus";
import { countValue, countWithUnit, formatRelative } from "./format";
import { Badge } from "./format.tsx";
import ProviderLimits from "./ProviderLimits";

/**
 * "Indexed posts", "Indexed people", the queue breakdown, and service
 * health — the P0 "simple, trustworthy stats" section. Every number here is
 * exactly what `convex/summary.ts` computed (a `Count` or a `ServiceStatus`)
 * with nothing re-derived client-side, so it can never drift from the
 * "never invent a number" rule in the frozen contract.
 */
/**
 * Plain words for the scope these figures cover. "owner" is what
 * convex/summary.ts returns: only the accounts the signed-in person has
 * imported themselves. Saying that out loud matters — the same tiles used to
 * report deployment-wide totals above a personal account list.
 */
function scopeLabel(scope: DashboardSummary["scope"]): string {
  if (scope.kind === "owner") return "your imports only";
  return scope.kind === "global" ? "all accounts in this deployment" : "one account";
}

export default function OverviewStats({
  summary,
  health,
  limits,
  connected,
  isAuthenticated,
}: {
  summary: DashboardSummary | undefined;
  health: ServiceStatus[] | undefined;
  limits: ProviderLimit[] | undefined;
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
              same owner-scoped account set (convex/summary.ts), so this
              number is genuinely the length of the list it points at — it is
              a real link, not a navigation gesture past a mismatch. */}
          <Stat label="Indexed people" count={summary.indexedAccounts} href="#account-library" />
          <Stat label="Waiting downloads" count={summary.queue.waitingDownloads} />
          <Stat label="Active downloads" count={summary.queue.activeDownloads} />
          <Stat
            label="Saved captures awaiting indexing"
            count={summary.queue.savedCapturesAwaitingIndexing}
          />
          <Stat label="Failed & retryable" count={summary.queue.failedRetryable} />
        </div>
      )}
      <div>
        <h3 className="library-subhead">Dependency health</h3>
        <div className="library-health-row" role="status">
          {!health
            ? (["indexer", "receiver", "search"] as const).map((service) => (
                <Badge key={service} tone="neutral">
                  {SERVICE_DISPLAY_NAME[service]}: {isAuthenticated ? "loading…" : "connect to view"}
                </Badge>
              ))
            : health.map((status) => {
                const tone =
                  status.kind === "unknown"
                    ? "neutral"
                    : status.stale
                      ? "warning"
                      : status.healthy
                        ? "positive"
                        : "danger";
                return (
                  <Badge key={status.service} tone={tone}>
                    {SERVICE_DISPLAY_NAME[status.service]}: {serviceHealthLabel(status)}
                    {status.kind === "known" && status.lastSuccessAt !== undefined
                      ? ` (last success ${formatRelative(status.lastSuccessAt)})`
                      : ""}
                  </Badge>
                );
              })}
        </div>
        <p className="library-muted">
          Health is an observed fact with a timestamp, separate from whether a service is
          configured. A stale reading is labelled stale, never shown as a fresh live zero.
        </p>
      </div>
      <ProviderLimits limits={limits} isAuthenticated={isAuthenticated} />
    </section>
  );
}

function Stat({
  label,
  count,
  href,
  caveat,
}: {
  label: string;
  count: DashboardSummary["indexedPosts"];
  /** When set, the whole tile becomes a real link (an `<a>`, not a JS-only
   * click handler) to that in-page section — e.g. the account library. */
  href?: string;
  /** An extra, always-visible line of honest scope context — never hidden
   * in a `title` attribute — shown under the usual unit line. */
  caveat?: string;
}) {
  const unknown = count.kind === "unknown";
  const body = (
    <>
      <span className={`value${unknown ? " unknown" : ""}`}>{countValue(count)}</span>
      <span className="label">{label}</span>
      <span className="sub">{unknown ? "not yet known" : countWithUnit(count)}</span>
      {caveat && <span className="library-stat-caveat">{caveat}</span>}
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
