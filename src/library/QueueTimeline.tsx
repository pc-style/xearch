import { useConvexAuth, useConvexConnectionState, useQuery } from "convex/react";
import type { Timeline, TimelineEntry, WaitReason } from "../../convex/queue";
import { queueTimelineQuery } from "./queueApi";
import { useDashboardClock } from "./clock";
import { useLocation } from "../locationStore";
import { acquisitionStatusLabel } from "../jobText";
import { acquisitionStatusTone } from "./format";
import { Badge } from "./format.tsx";
import "../dashboard.css";

/**
 * The operator Queue page: "what is the worker going to do next, and when"
 * (convex/queue.ts `timeline`). Operator-only — mounted only through
 * `src/operatorSurface.ts`'s lazy `QueueTimeline` export, the same
 * module-swap/code-split `Dashboard`/`ConnectionsPanel` already use, so this
 * file (and its operator-only strings, guarded by
 * scripts/check-public-bundle.mjs's "Queue timeline" marker below) never
 * reaches the public bundle.
 */
function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** What a non-account job (no resolvable `accounts` row) is labelled as. */
function fallbackLabel(entry: TimelineEntry): string {
  switch (entry.kind) {
    case "bulk":
      return `@${entry.input} history`;
    case "post":
      return "Post / conversation";
    case "live":
      return `Live search: ${entry.input}`;
    case "profile":
      return `Profile: @${entry.input}`;
    case "followers":
      return `Followers: @${entry.input}`;
    case "following":
      return `Following: @${entry.input}`;
    case "archive":
      return `Archive: @${entry.input}`;
  }
}

/** The wait reason in plain words — the whole point of this page over a bare
 * status word: "waiting for x.md's limit to reset at 5:31", "retry #3 at
 * 5:17", "behind 4 imports". */
function waitReasonText(entry: TimelineEntry): string {
  switch (entry.waitReason.kind) {
    case "running":
      return "Downloading now";
    case "ready":
      return "Up next";
    case "backoff":
      return `Retry #${entry.pageAttempt ?? 1} at ${formatClock(entry.waitReason.readyAt)}`;
    case "throttled":
      return `Waiting for x.md's limit to reset at ${formatClock(entry.waitReason.resetAt)}`;
    case "behind":
      return `Behind ${entry.waitReason.aheadCount} import${entry.waitReason.aheadCount === 1 ? "" : "s"}`;
  }
}

type ThrottledEntry = TimelineEntry & { waitReason: Extract<WaitReason, { kind: "throttled" }> };

function isThrottled(entry: TimelineEntry): entry is ThrottledEntry {
  return entry.waitReason.kind === "throttled";
}

type Group = { accountId: string | null; entries: TimelineEntry[] };

/** Entries for the same resolved account are pulled together into one
 * group, in the order that account first appears in the timeline — so a
 * queued run and its own earlier stopped-but-retryable run (appended after
 * every queued/running job — see convex/queue.ts) show up next to each
 * other instead of at opposite ends of the page. A job with no resolvable
 * account is always its own single-entry group. */
function groupEntries(entries: TimelineEntry[]): Group[] {
  const groups: Group[] = [];
  const indexByAccount = new Map<string, number>();

  for (const entry of entries) {
    const key = entry.account?.accountId ?? null;
    const existingIndex = key !== null ? indexByAccount.get(key) : undefined;

    if (existingIndex !== undefined) {
      groups[existingIndex].entries.push(entry);
      continue;
    }

    if (key !== null) indexByAccount.set(key, groups.length);
    groups.push({ accountId: key, entries: [entry] });
  }

  return groups;
}

function QueueIdentity({ entry }: { entry: TimelineEntry }) {
  const handle = entry.account?.handle ?? entry.input;

  return (
    <div className="library-identity">
      {entry.account?.avatar ? (
        <img className="library-avatar" src={entry.account.avatar} alt="" />
      ) : (
        <span className="library-avatar-fallback" aria-hidden="true">
          {handle.slice(0, 1).toUpperCase()}
        </span>
      )}
      <div className="library-identity-text">
        <h3>{entry.account?.name ?? fallbackLabel(entry)}</h3>
        <span>@{handle}</span>
      </div>
    </div>
  );
}

function QueueTimelineRow({
  entry,
  showIdentity,
}: {
  entry: TimelineEntry;
  showIdentity: boolean;
}) {
  return (
    <div className={`queue-timeline-row${isThrottled(entry) ? " is-throttled" : ""}`}>
      {showIdentity && <QueueIdentity entry={entry} />}
      <div className="queue-timeline-row-detail">
        <Badge tone={acquisitionStatusTone(entry.status)}>
          {acquisitionStatusLabel(entry.status)}
        </Badge>
        <span className="library-muted">
          {entry.postsReceived !== undefined
            ? `${entry.postsReceived.toLocaleString()} posts so far`
            : "No posts downloaded yet"}
        </span>
        <span>{waitReasonText(entry)}</span>
        <span className="library-muted">
          starts ≈ {formatClock(entry.estimate.start)} · done ≈ {formatClock(entry.estimate.finish)}
        </span>
        {isThrottled(entry) && (
          // The shaded "throttle window" band: a full-width strip on every
          // row this observed x.md throttle is currently holding back, with
          // the provider's own reset time — never a guessed one.
          <span className="queue-throttle-band" role="status">
            x.md throttled until {formatClock(entry.waitReason.resetAt)}
          </span>
        )}
        {entry.error && (
          <span role="alert" className="library-row-failure">
            {entry.error}
          </span>
        )}
      </div>
    </div>
  );
}

function QueueTimelineGroup({ group }: { group: Group }) {
  const grouped = group.entries.length > 1;
  const first = group.entries[0];
  const accountFinish = first.estimate.accountFinish;

  return (
    <section
      className={`queue-timeline-group${grouped ? " is-grouped" : ""}`}
      aria-label={first.account?.handle ?? first.input}
    >
      {grouped && (
        <div className="queue-timeline-group-head">
          <QueueIdentity entry={first} />
          {accountFinish !== undefined && (
            <span className="library-muted">done ≈ {formatClock(accountFinish)}</span>
          )}
        </div>
      )}
      {group.entries.map((entry) => (
        <QueueTimelineRow key={entry.jobId} entry={entry} showIdentity={!grouped} />
      ))}
    </section>
  );
}

function estimateInputsText(estimateInputs: Timeline["estimateInputs"]): string {
  if (estimateInputs.sampleSize === 0) return "No completed imports yet to base an estimate on.";

  const perPage =
    estimateInputs.secondsPerPage !== undefined ? Math.round(estimateInputs.secondsPerPage) : "?";

  const perAccount =
    estimateInputs.medianPages !== undefined ? Math.round(estimateInputs.medianPages) : "?";

  return `Estimates based on ${estimateInputs.sampleSize} recent import${estimateInputs.sampleSize === 1 ? "" : "s"} (≈${perPage}s/page, ≈${perAccount} pages/account).`;
}

function QueueTimelineBody({ timeline }: { timeline: Timeline }) {
  const { entries, estimateInputs, workerBusy, truncated } = timeline;
  const throttled = entries.find(isThrottled);
  const groups = groupEntries(entries);

  return (
    <div className="queue-timeline">
      <div className="queue-timeline-summary">
        <p>
          {entries.length} job{entries.length === 1 ? "" : "s"} · worker{" "}
          {workerBusy ? "busy" : "idle"}
          {throttled ? ` · x.md throttled until ${formatClock(throttled.waitReason.resetAt)}` : ""}
        </p>
        <p className="library-muted">{estimateInputsText(estimateInputs)}</p>
        {truncated && (
          <p role="status" className="config-warning">
            Showing only the most recent jobs — the full queue is larger than one page.
          </p>
        )}
      </div>
      {entries.length === 0 ? (
        <p className="library-muted">Nothing queued.</p>
      ) : (
        <div className="queue-timeline-list">
          {groups.map((group) => (
            <QueueTimelineGroup key={group.accountId ?? group.entries[0].jobId} group={group} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function QueueTimeline({ close }: { close: () => void }) {
  const { isAuthenticated } = useConvexAuth();
  const connected = useConvexConnectionState().isWebSocketConnected;
  const now = useDashboardClock();
  const timeline = useQuery(queueTimelineQuery, isAuthenticated ? { now } : "skip");
  const route = useLocation();
  // This component only ever mounts in the operator build (it is
  // module-swapped out of the public one — see operatorSurface.ts), where
  // src/App.tsx's own `dashboard` is `!route.search && !route.raw`, not the
  // public build's literal `?dashboard=1` — the operator site opens at the
  // dashboard by default (docs/production.md). src/App.tsx's `close` clears
  // only the `queue` flag, leaving `search`/`raw` as they were, so this is
  // exactly what decides whether "back" lands on the dashboard or on search.
  const cameFromDashboard = !route.search && !route.raw;

  return (
    <main className="control-room">
      <header className="topbar">
        <button type="button" className="wordmark" onClick={close} aria-label="Xearch home">
          xearch<span className="wordmark-dot">.</span>
        </button>
      </header>
      <header className="control-header">
        <div>
          <button onClick={close}>
            {cameFromDashboard ? "Back to dashboard" : "Back to search"}
          </button>
          <h1>Queue timeline</h1>
          <p>What the worker is going to do next, and when.</p>
        </div>
        <span className={connected ? "control-online" : "control-error"}>
          {connected ? "Live connection" : "Reconnecting…"}
        </span>
      </header>
      <div className="control-main">
        {!isAuthenticated ? (
          <p className="library-muted">Connect to view the queue.</p>
        ) : !timeline ? (
          <p className="library-loading">Loading queue timeline…</p>
        ) : (
          <QueueTimelineBody timeline={timeline} />
        )}
      </div>
    </main>
  );
}
