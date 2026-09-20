import type { DashboardSummary } from "../../convex/lib/contracts";
import type { ServiceStatus } from "../../convex/summary";
import { SERVICE_DISPLAY_NAME, serviceHealthLabel } from "../integrationStatus";
import { Badge, countValue, countWithUnit, formatRelative } from "./format";

/**
 * "Indexed posts", "Indexed people", the queue breakdown, and service
 * health — the P0 "simple, trustworthy stats" section. Every number here is
 * exactly what `convex/summary.ts` computed (a `Count` or a `ServiceStatus`)
 * with nothing re-derived client-side, so it can never drift from the
 * "never invent a number" rule in the frozen contract.
 */
export default function OverviewStats({
  summary,
  health,
  connected,
}: {
  summary: DashboardSummary | undefined;
  health: ServiceStatus[] | undefined;
  connected: boolean;
}) {
  return (
    <section className="library-section" aria-label="Overview">
      <div className="library-section-head">
        <h2>Overview</h2>
        {summary && (
          <p className="library-muted">
            As of {formatRelative(summary.observedAt)} · scope: {summary.scope.kind}
            {!connected && " · reconnecting — figures reflect the last data received"}
          </p>
        )}
      </div>
      {!summary ? (
        <p className="library-loading">Loading overview…</p>
      ) : (
        <div className="library-stats-grid">
          <Stat label="Indexed posts" count={summary.indexedPosts} />
          {/* Links to the account library below (to-do.md P0 "Indexed
              people: ... link the number to the account list"). Honest
              caveat, not silence: convex/summary.ts computes this GLOBALLY
              (every accountPublications row), while the list below is
              owner-scoped to the signed-in caller's own imports — see that
              file's "Indexed posts / indexed people" comment. Until P1 adds
              real per-owner scoping, this is a navigation link to "the
              account list" (satisfying the bullet's ask), not a claim that
              the two numbers already agree. */}
          <Stat
            label="Indexed people"
            count={summary.indexedAccounts}
            href="#account-library"
            caveat="Counted library-wide, not only your own imports yet — view the account list below."
          />
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
                  {SERVICE_DISPLAY_NAME[service]}: loading…
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
