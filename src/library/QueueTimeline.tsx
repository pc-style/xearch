import { useConvexAuth, useConvexConnectionState, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Timeline, TimelineEntry, WaitReason } from "../../convex/queue";
import { queueTimelineQuery } from "./queueApi";
import { useDashboardClock } from "./clock";
import { useStableQuery } from "./stableQuery";
import { useLocation } from "../locationStore";
import { operatorArgs } from "../operatorToken";
import { useTask } from "../errors";
import {
  acquisitionStatusLabel,
  conversationLabel,
  exactClockTime,
  historyWindowRange,
} from "../jobText";
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
const formatClock = exactClockTime;

/** What a non-account job (no resolvable `accounts` row) is labelled as.
 * `entry.account` resolving is the common case for every kind that names a
 * real account (including a deep-history backfill window — convex/lib/
 * accounts.ts `resolveJobAccount` resolves those through their own
 * `historyFor` field), so this is only reached for a job with no tracked
 * account: a free-text live search, or a single post/conversation. */
function fallbackLabel(entry: TimelineEntry): string {
  switch (entry.kind) {
    case "bulk":
      return `@${entry.input} history`;
    case "post":
      // /tmp/issues.md item 4: several failed conversation jobs otherwise
      // collapse to the exact same bare "Post / conversation" label here,
      // even after src/JobRow.tsx's "Other imports" feed already learned to
      // say "Conversation on @handle's post" — this reuses the SAME helper
      // (src/jobText.ts `conversationLabel`, handle + a short post-id
      // fragment) so the two surfaces never drift.
      return conversationLabel(entry.input);
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
    case "needsRetry":
      return entry.waitReason.throttledUntil !== undefined
        ? `Stopped: retry to resume (x.md throttled until ${formatClock(entry.waitReason.throttledUntil)})`
        : "Stopped: retry to resume";
  }
}

/** "starts ≈ HH:MM · download done ≈ HH:MM", or the same estimate framed as
 * "if retried now" for a stopped job nothing is actually scheduled to act
 * on — the ETA is only true if a person clicks Retry this instant. A
 * deep-history backfill window job (`origin: "history"`) can never actually
 * be retried this way (convex/jobs.ts `retry` rejects it outright: "not
 * retried on its own", since retrying it in place would double-count into
 * its backfill's `postsFound`) — framing its estimate as "if retried now"
 * would advertise a control this page doesn't offer for it (see `retryable`
 * below, CodeRabbit). */
function etaText(entry: TimelineEntry): string {
  const range = `starts ≈ ${formatClock(entry.estimate.start)} · download done ≈ ${formatClock(entry.estimate.finish)}`;

  if (entry.waitReason.kind !== "needsRetry") return range;

  return entry.origin === "history" ? "not retried on its own" : `if retried now: ${range}`;
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
  // `entry.input` is a handle for every kind except "post" (a status URL)
  // and "live" (a free-text search) — showing it as "@..." for those two
  // rendered "@https://x.com/…/status/…" and "@some search query", neither
  // of which is a handle. Only fall back to it when the job's own input
  // actually is one.
  const handle =
    entry.account?.handle ??
    (entry.kind === "post" || entry.kind === "live" ? undefined : entry.input);

  const initial = (handle ?? fallbackLabel(entry)).slice(0, 1).toUpperCase();

  // /tmp/issues.md item 2: a deep-history backfill window job now resolves
  // to its real account (convex/lib/accounts.ts `resolveJobAccount` reads
  // `historyFor`), so it renders under that account's own name/handle same
  // as its base import — but "@theo" alone doesn't say WHICH run this is.
  // This is the same "older history YYYY-MM → YYYY-MM" wording the account
  // library and the "Other imports" feed already use for the same job kind
  // (src/jobText.ts `historyWindowRange`), so it reads as one consistent
  // fact across every surface instead of a page-specific rewording.
  const windowRange =
    entry.origin === "history" && entry.since !== undefined && entry.until !== undefined
      ? historyWindowRange(entry.since, entry.until)
      : undefined;

  return (
    <div className="library-identity">
      {entry.account?.avatar ? (
        <img className="library-avatar" src={entry.account.avatar} alt="" />
      ) : (
        <span className="library-avatar-fallback" aria-hidden="true">
          {initial}
        </span>
      )}
      <div className="library-identity-text">
        <h3>{entry.account?.name ?? fallbackLabel(entry)}</h3>
        {handle !== undefined && <span>@{handle}</span>}
        {windowRange && <span className="library-muted">{windowRange}</span>}
      </div>
    </div>
  );
}

// /tmp/issues.md item 3: the timeline told a retryable job "if retried now:
// starts ≈ …" with nothing on the page that could actually retry it or take
// a person to the matching row elsewhere — the only links on the whole page
// were "Xearch home" and "Back to dashboard". `onRetry` calls the exact same
// `api.jobs.retry` mutation src/library/AccountRow.tsx and src/JobRow.tsx
// already use (same args shape, same `useTask` busy/error pattern); a
// history-window job's retry is rejected server-side with its own honest
// reason (convex/jobs.ts `retry`: "not retried on its own"), which is why
// `retryable` below never offers the button for one in the first place.
// `onShowInDashboard` sets a plain `#account-<id>` hash; the scroll itself
// is done by src/library/AccountRow.tsx's own mount-time ref (CodeRabbit:
// the browser's native hash-scroll fires before that row exists — App.tsx
// mounts QueueTimeline and Dashboard from separate branches — and never
// retries once it mounts, so this can't rely on that native behavior).
function QueueTimelineRow({
  entry,
  showIdentity,
  onRetry,
  onShowInDashboard,
}: {
  entry: TimelineEntry;
  showIdentity: boolean;
  onRetry: (jobId: TimelineEntry["jobId"]) => Promise<void>;
  onShowInDashboard: (accountId: string) => void;
}) {
  const { busy, message, run } = useTask();
  // Never true for a history-window job — see `etaText`'s own comment: the
  // server rejects retrying one outright, so no Retry button is offered for
  // it here either.
  const retryable = entry.waitReason.kind === "needsRetry" && entry.origin !== "history";
  // A local const, not `entry.account` inline: TypeScript narrows a
  // property access away by the time a closure below (the button's
  // `onClick`) reads it, so this is what lets that closure see it as
  // defined without a non-null assertion.
  const account = entry.account;

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
        <span className="library-muted">{etaText(entry)}</span>
        {/* Only for "post" kind, matching src/JobRow.tsx's own choice: every
            other kind's identity (a handle, a search string) is already
            distinct without it, and several failed conversations otherwise
            share the same rounded age with nothing else to tell them apart. */}
        {entry.kind === "post" && (
          <span className="library-muted">started {formatClock(entry.createdAt)}</span>
        )}
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
        {retryable && (
          <div className="queue-timeline-row-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => onRetry(entry.jobId))}
            >
              {busy ? "Retrying…" : "Retry"}
            </button>
            {account && (
              <button type="button" onClick={() => onShowInDashboard(account.accountId)}>
                Show in dashboard
              </button>
            )}
          </div>
        )}
        {message && (
          <span role="alert" className="library-row-failure">
            {message}
          </span>
        )}
      </div>
    </div>
  );
}

function QueueTimelineGroup({
  group,
  onRetry,
  onShowInDashboard,
}: {
  group: Group;
  onRetry: (jobId: TimelineEntry["jobId"]) => Promise<void>;
  onShowInDashboard: (accountId: string) => void;
}) {
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
            <span className="library-muted">download done ≈ {formatClock(accountFinish)}</span>
          )}
        </div>
      )}
      {group.entries.map((entry) => (
        <QueueTimelineRow
          key={entry.jobId}
          entry={entry}
          showIdentity={!grouped}
          onRetry={onRetry}
          onShowInDashboard={onShowInDashboard}
        />
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

function QueueTimelineBody({
  timeline,
  onRetry,
  onShowInDashboard,
}: {
  timeline: Timeline;
  onRetry: (jobId: TimelineEntry["jobId"]) => Promise<void>;
  onShowInDashboard: (accountId: string) => void;
}) {
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
            Some older jobs may be missing: the scan stopped at its limit.
          </p>
        )}
      </div>
      {entries.length === 0 ? (
        <p className="library-muted">Nothing queued.</p>
      ) : (
        <div className="queue-timeline-list">
          {groups.map((group) => (
            <QueueTimelineGroup
              key={group.accountId ?? group.entries[0].jobId}
              group={group}
              onRetry={onRetry}
              onShowInDashboard={onShowInDashboard}
            />
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
  const retry = useMutation(api.jobs.retry);

  const onRetry = (jobId: TimelineEntry["jobId"]) =>
    retry({ jobId, ...operatorArgs() }).then(() => undefined);

  // A plain in-page anchor, not a route/state change: leaving the Queue page
  // (`close()`) puts the dashboard back on screen. Setting the hash here
  // still matters even though the target row doesn't exist yet at this
  // exact instant — src/library/AccountRow.tsx's own mount-time ref reads
  // this same `location.hash` once it mounts and scrolls itself into view
  // then, rather than relying on the browser's native (one-shot, too-early)
  // hash-scroll attempt.
  const onShowInDashboard = (accountId: string) => {
    close();

    if (typeof window !== "undefined") window.location.hash = `account-${accountId}`;
  };

  // `useStableQuery`, not `useQuery`: `now` ticks on `useDashboardClock`'s own
  // interval, and a bare `useQuery` reports `undefined` on every argument
  // change until the new result lands — see src/library/stableQuery.ts.
  // `operatorArgs()` because `convex/queue.ts` `timeline` is operator-gated,
  // like every other paid-action-adjacent read this app makes.
  const timeline = useStableQuery(
    queueTimelineQuery,
    isAuthenticated ? { now, ...operatorArgs() } : "skip",
  );

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
          <p className="library-muted">Start a session to view the queue.</p>
        ) : !timeline ? (
          <p className="library-loading">Loading queue timeline…</p>
        ) : (
          <QueueTimelineBody
            timeline={timeline}
            onRetry={onRetry}
            onShowInDashboard={onShowInDashboard}
          />
        )}
      </div>
    </main>
  );
}
