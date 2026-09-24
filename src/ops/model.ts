import type { FunctionReturnType } from "convex/server";
import type { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import type { OpsAccount, OpsActivity } from "../../convex/ops";
import type { DashboardSummary } from "../../convex/lib/contracts";
import type { ServiceStatus } from "../../convex/summary";
import type { ProviderLimit } from "../../convex/limits";
import type { Timeline } from "../../convex/queue";
import { WORKER_LIVE_WINDOW_MS } from "../integrationStatus";
import { handleFromStatusUrl, historyWindowRange } from "../jobText";

/**
 * What the /ops dashboard shows, derived from query results. Plain
 * functions, so every rule here is testable without a renderer. Nothing in
 * this file invents a number: when an input is missing the result says so.
 */

export type { OpsAccount, OpsActivity };

export type OperatorConfig = FunctionReturnType<typeof api.integrations.operator>;

export type Me = FunctionReturnType<typeof api.auth.me>;

export type Job = Doc<"jobs">;

export type Tone = "ok" | "warn" | "crit" | "run" | "wait";

const MINUTE = 60_000;

const HOUR = 60 * MINUTE;

const DAY = 24 * HOUR;

/** An account whose newest posts arrived more than this long ago is stale. */
export const STALE_AFTER_MS = 7 * DAY;

/** A running job with no reported progress for this long is stalled. */
export const STALL_AFTER_MS = 10 * MINUTE;

// --- Formatting ------------------------------------------------------------

export const n = (x: number) => x.toLocaleString("en-GB");

/** 1,240 -> "1.2k", 23,110 -> "23k", 1.4M -> "1.4M". */
export function k(x: number): string {
  if (x >= 1e6) return `${(x / 1e6).toFixed(x >= 1e7 ? 0 : 1).replace(/\.0$/, "")}M`;

  if (x >= 10_000) return `${Math.round(x / 1000)}k`;

  if (x >= 1000) return `${(x / 1000).toFixed(1).replace(/\.0$/, "")}k`;

  return String(Math.round(x));
}

export function ago(ms: number): string {
  const m = Math.round(ms / MINUTE);

  if (m < 1) return "just now";

  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);

  if (h < 48) return `${h} h ago`;

  return `${Math.round(h / 24)} d ago`;
}

export function dur(ms: number): string {
  const m = Math.round(ms / MINUTE);

  if (m < 1) return "<1 min";

  if (m < 60) return `${m} min`;

  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** "3 Feb 2019" from an ISO date or a timestamp. */
const DATE_FORMAT = { day: "numeric", month: "short", year: "numeric" } as const;

/** "3 Feb 2019" from an ISO date. The date is X's, so it reads in UTC. */
export function dt(iso: string | undefined): string {
  if (iso === undefined) return "—";

  return new Date(iso).toLocaleDateString("en-GB", { ...DATE_FORMAT, timeZone: "UTC" });
}

/** "3 Feb 2019" for a moment, in the viewer's timezone. */
export const day = (ms: number) => new Date(ms).toLocaleDateString("en-GB", DATE_FORMAT);

/** "14:05" in the viewer's timezone. */
export const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

// --- Accounts ----------------------------------------------------------------

/** When new posts for this account last arrived: a finished import, or the
 * indexer publishing it, whichever is later. */
export function lastRefresh(a: OpsAccount): number | undefined {
  const times = [a.lastCompletedAt, a.publication?.lastPublishedAt].filter(
    (t): t is number => t !== undefined,
  );

  return times.length ? Math.max(...times) : undefined;
}

export const searchable = (a: OpsAccount) => a.publication?.searchablePostCount ?? 0;

const activeRun = (a: OpsAccount) =>
  [a.latestRun, a.historyRun].find((r) => r?.status === "queued" || r?.status === "running");

export type StatusLabel = { s: Tone; t: string };

export function accountState(a: OpsAccount, now: number): StatusLabel {
  const latest = a.latestRun;

  if (latest?.status === "running")
    return { s: "run", t: a.lastCompletedAt ? "Refresh running" : "First import running" };

  if (a.historyRun?.status === "running" || a.backfill?.status === "running")
    return { s: "run", t: "Backfill running" };

  if (latest?.status === "queued")
    return { s: "wait", t: a.lastCompletedAt ? "Refresh queued" : "Waiting to import" };

  if (latest?.status === "failed" || latest?.status === "partial")
    return { s: "crit", t: "Last import failed" };

  const state = a.publication?.state;

  if (state === "failed") return { s: "crit", t: "Indexing failed" };

  if (state === "indexing") return { s: "run", t: "Indexing new posts" };

  if (!state || state === "downloaded" || state === "waiting_for_indexing")
    return { s: "wait", t: "Awaiting indexing" };

  const refreshed = lastRefresh(a);

  if (refreshed !== undefined && now - refreshed > STALE_AFTER_MS)
    return { s: "warn", t: `Stale · ${Math.round((now - refreshed) / DAY)} d` };

  return { s: "ok", t: "Up to date" };
}

export function isStale(a: OpsAccount, now: number): boolean {
  const refreshed = lastRefresh(a);

  return refreshed !== undefined && now - refreshed > STALE_AFTER_MS;
}

export const needsNewer = (a: OpsAccount, now: number) =>
  isStale(a, now) || a.latestRun?.status === "failed" || a.latestRun?.status === "partial";

/**
 * Older posts are known to be missing: x.md stopped at its timeline floor
 * and no deep-history backfill has finished walking past it. Without a run
 * on record we know nothing either way, so this stays false.
 */
export function needsHistory(a: OpsAccount): boolean {
  if (a.backfill) return a.backfill.status !== "complete";

  return a.latestRun?.floorReached === true;
}

export const isActive = (a: OpsAccount) =>
  activeRun(a) !== undefined || a.publication?.state === "indexing";

export const isFailing = (a: OpsAccount) =>
  a.latestRun?.status === "failed" ||
  a.latestRun?.status === "partial" ||
  a.publication?.state === "failed";

export const hasRunRecord = (a: OpsAccount) =>
  a.latestRun !== undefined || a.backfill !== undefined;

export type AccountFilter = "all" | "newer" | "history" | "active" | "failing";

export const ACCOUNT_FILTERS: ReadonlyArray<
  readonly [AccountFilter, string, (a: OpsAccount, now: number) => boolean]
> = [
  ["all", "All", () => true],
  ["newer", "Need newer posts", needsNewer],
  ["history", "Need more history", (a) => needsHistory(a)],
  ["active", "Active", (a) => isActive(a)],
  ["failing", "Failing", (a) => isFailing(a)],
];

/** Posts the indexer says it still has to publish for this account, in the
 * unit it reported. */
export function pendingLabel(a: OpsAccount): string | null {
  const pending = a.publication?.pendingWork;

  if (!pending || pending.count === 0) return null;

  const unit = { posts: "posts", captures: "batches", jobs: "jobs" }[pending.unit];

  return `${n(pending.count)} ${unit}`;
}

export type SearchableTotal =
  | { kind: "known"; posts: number; accounts: number; total: number }
  | { kind: "unknown"; accounts: number; total: number };

/** Sum of every account's last confirmed searchable count. Unknown if an
 * account is searchable but the indexer never reported its count. */
export function searchableTotal(accounts: OpsAccount[]): SearchableTotal {
  let posts = 0;
  let unknown = false;
  let withPosts = 0;

  for (const a of accounts) {
    const count = a.publication?.searchablePostCount;

    if (count !== undefined) {
      posts += count;

      if (count > 0) withPosts += 1;
    } else if (a.publication?.state === "searchable") unknown = true;
  }

  return unknown
    ? { kind: "unknown", accounts: withPosts, total: accounts.length }
    : { kind: "known", posts, accounts: withPosts, total: accounts.length };
}

/** The searchable total as a figure, or "—" when an account's is unknown. */
export const searchablePosts = (total: SearchableTotal | undefined) =>
  total?.kind === "known" ? n(total.posts) : "—";

export function coverage(accounts: OpsAccount[], now: number) {
  let complete = 0;
  let history = 0;
  let newer = 0;
  let none = 0;
  let unrecorded = 0;

  for (const a of accounts) {
    if (!searchable(a)) none += 1;
    else if (needsHistory(a)) history += 1;
    else if (needsNewer(a, now)) newer += 1;
    else if (!hasRunRecord(a)) unrecorded += 1;
    else complete += 1;
  }

  return { total: accounts.length, complete, history, newer, none, unrecorded };
}

// --- Jobs --------------------------------------------------------------------

export type JobState = "running" | "stalled" | "waiting" | "failed" | "done" | "cancelled";

export function jobState(job: Job, now: number): JobState {
  switch (job.status) {
    case "queued":
      return "waiting";
    case "running":
      return now - job.updatedAt > STALL_AFTER_MS ? "stalled" : "running";
    case "failed":
    case "partial":
      return "failed";
    case "complete":
      return "done";
    case "cancelled":
      return "cancelled";
  }
}

export const isActiveJob = (state: JobState) =>
  state === "running" || state === "stalled" || state === "waiting" || state === "failed";

export const JOB_PILL: Record<JobState, StatusLabel> = {
  running: { s: "run", t: "Running" },
  stalled: { s: "crit", t: "Stalled" },
  waiting: { s: "wait", t: "Waiting" },
  failed: { s: "crit", t: "Failed" },
  done: { s: "ok", t: "Finished" },
  cancelled: { s: "wait", t: "Cancelled" },
};

const JOB_ORDER: Record<JobState, number> = {
  failed: 0,
  stalled: 1,
  running: 2,
  waiting: 3,
  done: 4,
  cancelled: 5,
};

export function sortJobs(jobs: Job[], now: number): Job[] {
  return [...jobs].sort(
    (a, b) =>
      JOB_ORDER[jobState(a, now)] - JOB_ORDER[jobState(b, now)] ||
      (jobState(a, now) === "waiting"
        ? a._creationTime - b._creationTime
        : b.updatedAt - a.updatedAt),
  );
}

const isHistoryWindow = (job: Job) => job.kind === "live" && job.origin === "history";

export function jobType(job: Job): string {
  switch (job.kind) {
    case "bulk":
      return job.refresh ? "Refresh" : "Import";
    case "live":
      return isHistoryWindow(job) ? "Backfill" : "X search";
    case "post":
      return "Conversation";
    case "profile":
      return "Profile";
    case "followers":
      return "Followers";
    case "following":
      return "Following";
    case "archive":
      return "Archive";
  }
}

/** The account a job is about, when it is about one. */
export function jobHandle(job: Job): string | null {
  if (isHistoryWindow(job)) return job.input.match(/^from:([A-Za-z0-9_]+)/)?.[1] ?? null;

  if (job.kind === "live") return null;

  if (job.kind === "post") return handleFromStatusUrl(job.input);

  return job.input;
}

export type JobTarget = { main: string; sub?: string };

export function jobTarget(job: Job): JobTarget {
  if (isHistoryWindow(job)) {
    const handle = jobHandle(job);

    return {
      main: handle ? `@${handle}` : job.input,
      sub: job.since && job.until ? historyWindowRange(job.since, job.until) : undefined,
    };
  }

  if (job.kind === "live") return { main: `“${job.input}”` };

  if (job.kind === "post") {
    const short = job.input.replace(/^https?:\/\/(www\.)?/, "");

    return { main: short.length > 34 ? `${short.slice(0, 33)}…` : short };
  }

  return { main: `@${job.input}` };
}

/** Retry is offered only where convex/jobs.ts `retry` would accept it. */
export const canRetry = (job: Job) =>
  !isHistoryWindow(job) &&
  (job.status === "cancelled" ||
    ((job.status === "failed" || job.status === "partial") && job.retryable !== false));

/** "Run again" starts the same request fresh through `jobs.start`. */
export const canRerun = (job: Job) => job.status === "complete" && !isHistoryWindow(job);

export const shortId = (id: Id<"jobs">) => id.slice(-6);

/** Queue position and estimate for each queued or running job, from the
 * queue timeline. An estimate is only given when it comes from real
 * completed imports, never from the timeline's default guess. */
export function queueInfo(timeline: Timeline | undefined) {
  const info = new Map<Id<"jobs">, { position?: number; finish?: number }>();

  if (!timeline) return info;
  const measured = timeline.estimateInputs.secondsPerPage !== undefined;
  let position = 0;

  for (const entry of timeline.entries) {
    if (entry.status === "queued") position += 1;

    if (entry.status !== "queued" && entry.status !== "running") continue;
    info.set(entry.jobId, {
      position: entry.status === "queued" ? position : undefined,
      finish: measured ? entry.estimate.finish : undefined,
    });
  }

  return info;
}

// --- Provider ---------------------------------------------------------------

/** When x.md's own reported limit lifts, if one is active now. */
export function throttledUntil(limit: ProviderLimit | undefined, now: number): number | undefined {
  if (!limit || limit.kind !== "throttled") return undefined;

  const exhausted = limit.remaining.kind === "known" && limit.remaining.value <= 0;

  const candidates = [exhausted ? limit.resetAt : undefined, limit.nextRetryAt].filter(
    (at): at is number => at !== undefined && at > now,
  );

  return candidates.length ? Math.max(...candidates) : undefined;
}

// --- Worker -----------------------------------------------------------------

export type WorkerState =
  | { kind: "inline" }
  | { kind: "online" }
  | { kind: "offline"; lastSeenAt: number | null };

export function workerState(config: OperatorConfig | undefined, now: number): WorkerState | null {
  if (!config) return null;

  if (config.handoffState.kind === "configured") return { kind: "inline" };
  const lastSeenAt = config.handoffState.lastSeenAt;

  return lastSeenAt !== null && now - lastSeenAt < WORKER_LIVE_WINDOW_MS
    ? { kind: "online" }
    : { kind: "offline", lastSeenAt };
}

// --- Needs attention --------------------------------------------------------

export type ActionKind =
  | "retry"
  | "logs"
  | "cancel"
  | "provider"
  | "refresh"
  | "search"
  | "performance"
  | "jobs"
  | "accounts";

export type Action = {
  kind: ActionKind;
  label: string;
  primary?: boolean;
  jobId?: Id<"jobs">;
  handle?: string;
};

export type AttentionItem = {
  key: string;
  s: "crit" | "warn" | "info";
  title: string;
  detail: string;
  code?: string;
  actions: Action[];
};

export type AttentionInput = {
  now: number;
  jobs: Job[];
  accounts: OpsAccount[];
  summary: DashboardSummary | undefined;
  health: ServiceStatus[] | undefined;
  limit: ProviderLimit | undefined;
  config: OperatorConfig | undefined;
};

const MAX_LISTED = 5;

const SERVICE_NAME = { indexer: "Indexer", receiver: "Capture receiver", search: "Search service" };

export function attentionItems(input: AttentionInput): AttentionItem[] {
  const { now } = input;
  const items: AttentionItem[] = [];
  const accountByHandle = new Map(input.accounts.map((a) => [a.handle.toLowerCase(), a]));

  const stillSearchable = (job: Job) => {
    const handle = jobHandle(job);
    const account = handle ? accountByHandle.get(handle.toLowerCase()) : undefined;

    return account && searchable(account) > 0
      ? ` Existing ${n(searchable(account))} posts are still searchable.`
      : "";
  };

  const failed = input.jobs.filter((j) => jobState(j, now) === "failed");

  for (const job of failed.slice(0, MAX_LISTED)) {
    const target = jobTarget(job).main;
    items.push({
      key: `failed-${job._id}`,
      s: "crit",
      title: `${jobType(job)} of ${target} failed`,
      code: job.error ?? "No error was recorded",
      detail: ` · ${ago(now - job.updatedAt)}.${stillSearchable(job)}`,
      actions: [
        ...(canRetry(job)
          ? [{ kind: "retry" as const, label: "Retry", primary: true, jobId: job._id }]
          : []),
        { kind: "logs", label: "View error", jobId: job._id },
      ],
    });
  }

  if (failed.length > MAX_LISTED)
    items.push({
      key: "failed-more",
      s: "crit",
      title: `${failed.length - MAX_LISTED} more failed jobs`,
      detail: "Listed on the Jobs page with their errors.",
      actions: [{ kind: "jobs", label: "Open jobs" }],
    });

  for (const job of input.jobs.filter((j) => jobState(j, now) === "stalled"))
    items.push({
      key: `stalled-${job._id}`,
      s: "crit",
      title: `${jobType(job)} of ${jobTarget(job).main} has made no progress for ${dur(now - job.updatedAt)}`,
      detail: `${jobCollected(job)} so far. Cancelling keeps what was collected.`,
      actions: [{ kind: "cancel", label: "Cancel, keep posts", jobId: job._id }],
    });

  const worker = workerState(input.config, now);

  if (worker?.kind === "offline")
    items.push({
      key: "worker",
      s: "crit",
      title: "The download worker is offline",
      detail:
        (worker.lastSeenAt === null
          ? "It has not checked in."
          : `Last seen ${ago(now - worker.lastSeenAt)}.`) +
        " Queued jobs wait until it reconnects; new imports can't start.",
      actions: [{ kind: "jobs", label: "See jobs" }],
    });

  for (const service of input.health ?? []) {
    if (service.kind !== "known") continue;

    if (!service.healthy)
      items.push({
        key: `svc-${service.service}`,
        s: "crit",
        title: `${SERVICE_NAME[service.service]} is failing`,
        code: service.lastError?.message,
        detail: ` · reported ${ago(now - service.observedAt)}.`,
        actions: [{ kind: "performance", label: "See performance" }],
      });
    else if (service.stale)
      items.push({
        key: `svc-${service.service}`,
        s: "warn",
        title: `${SERVICE_NAME[service.service]} hasn't reported for ${dur(now - (service.lastHeartbeatAt ?? service.observedAt))}`,
        detail: "Its last report was healthy. It may have stopped without saying so.",
        actions: [{ kind: "performance", label: "See performance" }],
      });
  }

  const until = throttledUntil(input.limit, now);

  if (until !== undefined && input.limit?.kind === "throttled")
    items.push({
      key: "throttle",
      s: "warn",
      title: `x.md rate limit reached${input.limit.remaining.kind === "known" ? ` · ${n(input.limit.remaining.value)} calls left` : ""}`,
      detail: `New work resumes automatically at ${clock(until)}. Queued jobs stay queued; nothing is lost.`,
      actions: [{ kind: "provider", label: "See provider usage" }],
    });

  const stale = input.accounts
    .filter((a) => isStale(a, now) && activeRun(a) === undefined)
    .sort((x, y) => (lastRefresh(x) ?? 0) - (lastRefresh(y) ?? 0));

  for (const a of stale.slice(0, MAX_LISTED)) {
    const refreshed = lastRefresh(a) ?? now;
    items.push({
      key: `stale-${a.accountId}`,
      s: "warn",
      title: `@${a.handle} last refreshed ${Math.round((now - refreshed) / DAY)} days ago`,
      detail: `Nothing newer than ${day(refreshed)} has been collected. Searches for recent ${a.name} posts return nothing after that.`,
      actions: [
        { kind: "refresh", label: "Refresh now", primary: true, handle: a.handle },
        ...(searchable(a) > 0
          ? [{ kind: "search" as const, label: "Search posts", handle: a.handle }]
          : []),
      ],
    });
  }

  if (stale.length > MAX_LISTED)
    items.push({
      key: "stale-more",
      s: "warn",
      title: `${stale.length - MAX_LISTED} more accounts haven't been refreshed in over a week`,
      detail: "Filter the Accounts table by “Need newer posts” to refresh them together.",
      actions: [{ kind: "accounts", label: "Show accounts" }],
    });

  const backlog = input.summary?.queue.savedCapturesAwaitingIndexing;

  if (backlog?.kind === "known" && backlog.value > 0)
    items.push({
      key: "backlog",
      s: "info",
      title: `${n(backlog.value)} downloaded ${backlog.value === 1 ? "batch is" : "batches are"} waiting to become searchable`,
      detail:
        "The indexer confirms batches as it publishes them. Its throughput isn't tracked yet, so there is no time estimate.",
      actions: [{ kind: "performance", label: "See performance" }],
    });

  return items;
}

// --- Charts -----------------------------------------------------------------

export const hourLabel = (start: number) => `${new Date(start).getHours()}:00`;

export function downloadTotals(activity: OpsActivity | undefined) {
  if (!activity) return undefined;
  const hours = activity.downloads.hours;

  return {
    posts: hours.reduce((sum, h) => sum + h.posts, 0),
    other: hours.reduce((sum, h) => sum + h.other, 0),
    lastHour: hours.at(-1)?.posts ?? 0,
  };
}

/** What a run kept, in the unit it was counted in. */
export function jobResult(job: Job): string | null {
  if (job.postsReceived !== undefined)
    return `${n(job.postsReceived)} post${job.postsReceived === 1 ? "" : "s"} kept`;

  if (job.count > 0) return `${n(job.count)} record${job.count === 1 ? "" : "s"} kept`;

  if (job.status === "complete") return "Response saved";

  return null;
}

/** How much a run has collected so far. x.md never reports a total up
 * front, so there is never a "N of M". */
export function jobCollected(job: Job): string {
  if (job.postsReceived !== undefined) return `${n(job.postsReceived)} posts collected`;

  return `${n(job.count)} records collected`;
}
