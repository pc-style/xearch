// Plain fixtures for the /ops dashboard tests, shaped exactly like the
// queries' own return types. No renderer here, so node tests can use them.
import type { Doc, Id } from "../convex/_generated/dataModel";
import type { DashboardSummary } from "../convex/lib/contracts";
import type { OpsAccount, OpsActivity } from "../convex/ops";
import type { ServiceStatus } from "../convex/summary";
import type { Timeline } from "../convex/queue";
import type { OperatorConfig } from "../src/ops/model";

export const MINUTE = 60_000;

export const HOUR = 60 * MINUTE;

export const DAY = 24 * HOUR;

// SAFETY: Convex ids are opaque strings; fixtures only need them unique.
export const jobId = (n: number) => `job${n}` as Id<"jobs">;

// SAFETY: as for `jobId`.
export const accountId = (n: number) => `acc${n}` as Id<"accounts">;

export function job(n: number, fields: Partial<Doc<"jobs">> = {}): Doc<"jobs"> {
  const now = Date.now();

  return {
    _id: jobId(n),
    _creationTime: now - 30 * MINUTE,
    // SAFETY: as for `jobId`.
    owner: "user1" as Id<"users">,
    kind: "bulk",
    input: `handle${n}`,
    refresh: false,
    status: "complete",
    count: 0,
    attempt: 1,
    warnings: [],
    updatedAt: now - 20 * MINUTE,
    ...fields,
  };
}

export function account(n: number, fields: Partial<OpsAccount> = {}): OpsAccount {
  const now = Date.now();

  return {
    accountId: accountId(n),
    handle: `handle${n}`,
    name: `Account ${n}`,
    publication: {
      state: "searchable",
      searchablePostCount: 100 * n,
      lastPublishedAt: now - HOUR,
      updatedAt: now - HOUR,
    },
    latestRun: {
      jobId: jobId(1000 + n),
      status: "complete",
      createdAt: now - 2 * HOUR,
      updatedAt: now - HOUR,
      refresh: false,
      postsReceived: 100 * n,
      oldest: "2020-01-01",
    },
    lastCompletedAt: now - HOUR,
    oldestCollected: "2020-01-01",
    ...fields,
  };
}

const known = <U extends "jobs" | "captures" | "posts" | "accounts">(unit: U, value: number) => ({
  kind: "known" as const,
  unit,
  value,
});

export function summary(queue: Partial<DashboardSummary["queue"]> = {}): DashboardSummary {
  return {
    indexedPosts: known("posts", 0),
    indexedAccounts: known("accounts", 0),
    queue: {
      waitingDownloads: known("jobs", 0),
      activeDownloads: known("jobs", 0),
      savedCapturesAwaitingIndexing: known("captures", 0),
      failedRetryable: known("jobs", 0),
      ...queue,
    },
    providerQueuedWork: {
      posts: { kind: "unknown", unit: "posts" },
      captures: { kind: "unknown", unit: "captures" },
      jobs: { kind: "unknown", unit: "jobs" },
    },
    scope: { kind: "global" },
    observedAt: Date.now(),
  };
}

export function activity(fields: Partial<OpsActivity> = {}): OpsActivity {
  const start = Math.floor(Date.now() / HOUR) * HOUR - 23 * HOUR;

  return {
    downloads: {
      hours: Array.from({ length: 24 }, (_, i) => ({
        start: start + i * HOUR,
        posts: 0,
        other: 0,
      })),
      truncated: false,
    },
    search: { queries: 0, failed: 0, timedSample: 0, truncated: false },
    jobs: { byKind: [], failed: 0, truncated: false },
    throttles: { xmd: 0, truncated: false },
    ...fields,
  };
}

export const healthy = (): ServiceStatus[] =>
  (["indexer", "receiver", "search"] as const).map((service) => ({
    service,
    kind: "known",
    healthy: true,
    stale: false,
    lastHeartbeatAt: Date.now(),
    observedAt: Date.now(),
  }));

export const liveWorker = (): OperatorConfig => ({
  indexing: true,
  search: true,
  firecrawl: false,
  openai: false,
  email: false,
  xmd: true,
  handoff: true,
  handoffState: { kind: "live", lastSeenAt: Date.now() },
  collectorMode: "outbound",
});

export const emptyTimeline = (): Timeline => ({
  entries: [],
  estimateInputs: { sampleSize: 0 },
  workerBusy: false,
  truncated: false,
});
