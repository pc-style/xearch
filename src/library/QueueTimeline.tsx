import { For, Show } from "solid-js";
import { api } from "../../convex/_generated/api";
import type { Timeline, TimelineEntry, WaitReason } from "../../convex/queue";
import { useConvex, useMutation } from "../data/convex";
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
import { Avatar } from "../Avatar";
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

function QueueIdentity(props: { entry: TimelineEntry }) {
  // `entry.input` is a handle for every kind except "post" (a status URL)
  // and "live" (a free-text search) — showing it as "@..." for those two
  // rendered "@https://x.com/…/status/…" and "@some search query", neither
  // of which is a handle. Only fall back to it when the job's own input
  // actually is one.
  const handle = () =>
    props.entry.account?.handle ??
    (props.entry.kind === "post" || props.entry.kind === "live" ? undefined : props.entry.input);

  // /tmp/issues.md item 2: a deep-history backfill window job resolves to
  // its real account (convex/lib/accounts.ts `resolveJobAccount` reads
  // `historyFor`), so it renders under that account's own name/handle same
  // as its base import — but "@theo" alone doesn't say WHICH run this is.
  // This is the same "older history YYYY-MM → YYYY-MM" wording the account
  // library and the "Other imports" feed already use for the same job kind
  // (src/jobText.ts `historyWindowRange`).
  const windowRange = () => {
    const { origin, since, until } = props.entry;

    return origin === "history" && since !== undefined && until !== undefined
      ? historyWindowRange(since, until)
      : undefined;
  };

  return (
    <div class="library-identity">
      <Avatar
        name={handle() ?? fallbackLabel(props.entry)}
        url={props.entry.account?.avatar}
        class="library-avatar"
        fallbackClass="library-avatar-fallback"
        letters={1}
      />
      <div class="library-identity-text">
        <h3>{props.entry.account?.name ?? fallbackLabel(props.entry)}</h3>
        <Show when={handle() !== undefined}>
          <span>@{handle()}</span>
        </Show>
        <Show when={windowRange()}>
          <span class="library-muted">{windowRange()}</span>
        </Show>
      </div>
    </div>
  );
}

type RowActions = {
  onRetry: (jobId: TimelineEntry["jobId"]) => Promise<void>;
  onShowInDashboard: (accountId: string) => void;
};

// /tmp/issues.md item 3: the timeline told a retryable job "if retried now:
// starts ≈ …" with nothing on the page that could actually retry it or take
// a person to the matching row elsewhere. `onRetry` calls the exact same
// `api.jobs.retry` mutation src/library/AccountRow.tsx and src/JobRow.tsx
// already use (same args shape, same `useTask` busy/error pattern); a
// history-window job's retry is rejected server-side with its own honest
// reason (convex/jobs.ts `retry`: "not retried on its own"), which is why
// `retryable` below never offers the button for one in the first place.
// `onShowInDashboard` sets a plain `#account-<id>` hash; the scroll itself
// is done by src/library/AccountRow.tsx once that row mounts (the browser's
// native hash-scroll fires before the row exists and never retries).
function QueueTimelineRow(props: RowActions & { entry: TimelineEntry; showIdentity: boolean }) {
  const { busy, message, run } = useTask();

  // Never true for a history-window job — see `etaText`'s own comment: the
  // server rejects retrying one outright, so no Retry button is offered for
  // it here either.
  const retryable = () =>
    props.entry.waitReason.kind === "needsRetry" && props.entry.origin !== "history";

  const throttled = () => {
    const entry = props.entry;

    return isThrottled(entry) ? entry : undefined;
  };

  return (
    <div class={["queue-timeline-row", { "is-throttled": throttled() !== undefined }]}>
      <Show when={props.showIdentity}>
        <QueueIdentity entry={props.entry} />
      </Show>
      <div class="queue-timeline-row-detail">
        <Badge tone={acquisitionStatusTone(props.entry.status)}>
          {acquisitionStatusLabel(props.entry.status)}
        </Badge>
        <span class="library-muted">
          {props.entry.postsReceived !== undefined
            ? `${props.entry.postsReceived.toLocaleString()} posts so far`
            : "No posts downloaded yet"}
        </span>
        <span>{waitReasonText(props.entry)}</span>
        <span class="library-muted">{etaText(props.entry)}</span>
        {/* Only for "post" kind, matching src/JobRow.tsx's own choice: every
            other kind's identity (a handle, a search string) is already
            distinct without it, and several failed conversations otherwise
            share the same rounded age with nothing else to tell them apart. */}
        <Show when={props.entry.kind === "post"}>
          <span class="library-muted">started {formatClock(props.entry.createdAt)}</span>
        </Show>
        <Show when={throttled()}>
          {(entry) => (
            // The shaded "throttle window" band: a full-width strip on every
            // row this observed x.md throttle is currently holding back, with
            // the provider's own reset time — never a guessed one.
            <span class="queue-throttle-band" role="status">
              x.md throttled until {formatClock(entry().waitReason.resetAt)}
            </span>
          )}
        </Show>
        <Show when={props.entry.error}>
          <span role="alert" class="library-row-failure">
            {props.entry.error}
          </span>
        </Show>
        <Show when={retryable()}>
          <div class="queue-timeline-row-actions">
            <button
              type="button"
              disabled={busy()}
              onClick={() => {
                void run(() => props.onRetry(props.entry.jobId));
              }}
            >
              {busy() ? "Retrying…" : "Retry"}
            </button>
            <Show when={props.entry.account}>
              {(account) => (
                <button type="button" onClick={() => props.onShowInDashboard(account().accountId)}>
                  Show in dashboard
                </button>
              )}
            </Show>
          </div>
        </Show>
        <Show when={message()}>
          <span role="alert" class="library-row-failure">
            {message()}
          </span>
        </Show>
      </div>
    </div>
  );
}

function QueueTimelineGroup(props: RowActions & { group: Group }) {
  const grouped = () => props.group.entries.length > 1;
  const first = () => props.group.entries[0];

  return (
    <section
      class={["queue-timeline-group", { "is-grouped": grouped() }]}
      aria-label={first().account?.handle ?? first().input}
    >
      <Show when={grouped()}>
        <div class="queue-timeline-group-head">
          <QueueIdentity entry={first()} />
          <Show when={first().estimate.accountFinish}>
            {(finish) => <span class="library-muted">download done ≈ {formatClock(finish())}</span>}
          </Show>
        </div>
      </Show>
      <For each={props.group.entries} keyed={(entry) => entry.jobId}>
        {(entry) => (
          <QueueTimelineRow
            entry={entry()}
            showIdentity={!grouped()}
            onRetry={props.onRetry}
            onShowInDashboard={props.onShowInDashboard}
          />
        )}
      </For>
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

function QueueTimelineBody(props: RowActions & { timeline: Timeline }) {
  const entries = () => props.timeline.entries;
  const throttled = () => entries().find(isThrottled);

  return (
    <div class="queue-timeline">
      <div class="queue-timeline-summary">
        <p>
          {entries().length} job{entries().length === 1 ? "" : "s"} · worker{" "}
          {props.timeline.workerBusy ? "busy" : "idle"}
          {throttled()
            ? ` · x.md throttled until ${formatClock(throttled()!.waitReason.resetAt)}`
            : ""}
        </p>
        <p class="library-muted">{estimateInputsText(props.timeline.estimateInputs)}</p>
        <Show when={props.timeline.truncated}>
          <p role="status" class="config-warning">
            Some older jobs may be missing: the scan stopped at its limit.
          </p>
        </Show>
      </div>
      <Show when={entries().length} fallback={<p class="library-muted">Nothing queued.</p>}>
        <div class="queue-timeline-list">
          <For
            each={groupEntries(entries())}
            keyed={(group) => group.accountId ?? group.entries[0].jobId}
          >
            {(group) => (
              <QueueTimelineGroup
                group={group()}
                onRetry={props.onRetry}
                onShowInDashboard={props.onShowInDashboard}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

export default function QueueTimeline(props: { close: () => void }) {
  const { isAuthenticated, connection } = useConvex();
  const connected = () => connection().isWebSocketConnected;
  const now = useDashboardClock();
  const retry = useMutation(api.jobs.retry);

  const onRetry = (jobId: TimelineEntry["jobId"]) =>
    retry({ jobId, ...operatorArgs() }).then(() => undefined);

  // A plain in-page anchor, not a route/state change: leaving the Queue page
  // (`close()`) puts the dashboard back on screen, and
  // src/library/AccountRow.tsx scrolls itself into view once it mounts and
  // finds its own id in `location.hash`.
  const onShowInDashboard = (accountId: string) => {
    props.close();
    window.location.hash = `account-${accountId}`;
  };

  // `useStableQuery`: `now` ticks on `useDashboardClock`'s own interval, and
  // a plain query reads `undefined` on every argument change until the new
  // result lands — see src/library/stableQuery.ts. `operatorArgs()` because
  // `convex/queue.ts` `timeline` is operator-gated.
  const timeline = useStableQuery(queueTimelineQuery, () =>
    isAuthenticated() ? { now: now(), ...operatorArgs() } : "skip",
  );

  const route = useLocation();
  // This component only ever mounts in the operator build, where
  // src/App.tsx's own `dashboard` is `!route.search && !route.raw` — the
  // operator site opens at the dashboard by default (docs/production.md).
  // App's `close` clears only the `queue` flag, leaving `search`/`raw` as
  // they were, so this is exactly what decides whether "back" lands on the
  // dashboard or on search.
  const cameFromDashboard = () => !route().search && !route().raw;

  return (
    <main class="control-room">
      <header class="top">
        <button
          type="button"
          class="logo press"
          onClick={() => props.close()}
          aria-label="Xearch home"
        >
          xearch <i>.</i>
        </button>
      </header>
      <header class="control-header">
        <div>
          <button type="button" onClick={() => props.close()}>
            {cameFromDashboard() ? "Back to dashboard" : "Back to search"}
          </button>
          <h1>Queue timeline</h1>
          <p>What the worker is going to do next, and when.</p>
        </div>
        <span class={connected() ? "control-online" : "control-error"}>
          {connected() ? "Live connection" : "Reconnecting…"}
        </span>
      </header>
      <div class="control-main">
        <Show
          when={isAuthenticated()}
          fallback={<p class="library-muted">Start a session to view the queue.</p>}
        >
          <Show when={timeline()} fallback={<p class="library-loading">Loading queue timeline…</p>}>
            {(loaded) => (
              <QueueTimelineBody
                timeline={loaded()}
                onRetry={onRetry}
                onShowInDashboard={onShowInDashboard}
              />
            )}
          </Show>
        </Show>
      </div>
    </main>
  );
}
