export type IndexingStatus = {
  xmd: boolean;
  indexing: boolean;
  handoff: boolean;
  collectorMode: "outbound" | "receiver";
};

export function indexingUnavailableMessage(config: IndexingStatus): string | undefined {
  if (config.indexing) return undefined;
  if (!config.xmd) return "Indexing needs an x.md key. Configure it in Connections.";
  if (config.collectorMode === "outbound" && !config.handoff)
    return "The download worker is offline. Imports will be available when it reconnects.";
  if (!config.handoff) return "Indexing needs a raw-capture receiver. Configure it in Connections.";
  return "Indexing is temporarily unavailable.";
}

/**
 * Human copy for `convex/summary.ts`'s `ServiceStatus` (the
 * indexer/receiver/search health rows). Kept apart from
 * `indexingUnavailableMessage` above on purpose: that function answers "can
 * I configure/start a new import" from env-var presence; this one answers
 * "is a dependency actually alive right now", from observed facts with
 * timestamps. `integrations.configured` conflating the two ("configured" as
 * if it meant "healthy") is exactly the gap docs/publication-contract.md's
 * "Worker/indexer/service health" section and to-do.md P0 call out — see
 * both before changing this. A stale "healthy: true" reading must never
 * read the same as a fresh one, so `stale` is checked before `healthy`.
 */
export type ServiceHealthStatus =
  | { kind: "unknown" }
  | { kind: "known"; healthy: boolean; stale: boolean; observedAt: number };

export function serviceHealthLabel(status: ServiceHealthStatus): string {
  if (status.kind === "unknown") return "No health report received yet";
  if (status.stale)
    return `Stale reading from ${new Date(status.observedAt).toLocaleString()} — treat with caution`;
  return status.healthy ? "Healthy" : "Unhealthy";
}

export const SERVICE_DISPLAY_NAME: Record<"indexer" | "receiver" | "search", string> = {
  indexer: "Search indexer",
  receiver: "Raw-capture receiver",
  search: "Search backend",
};

/**
 * How recently the download worker must have checked in for the UI to call
 * it live. Mirrors the worker's own expiry in `convex/worker.ts`, which
 * schedules a row flip 45s after each heartbeat.
 *
 * Freshness is judged HERE, against the caller's own clock, and never
 * server-side: a Convex query re-runs when a document it read changes, not
 * because time passed, so a boolean decided inside the query would freeze at
 * the last write and keep claiming the worker is live after it stopped.
 */
export const WORKER_LIVE_WINDOW_MS = 45_000;

export type HandoffState =
  | { kind: "configured"; ok: boolean }
  /**
   * `lastSeenAt` is absent for a signed-out caller — worker timing is not
   * part of the public bootstrap response — and null when the worker is
   * known to be down. Absent means "not disclosed", which is not the same
   * claim as "down", so it resolves to undefined and the caller falls back
   * to the public flag rather than asserting something it was not told.
   */
  | { kind: "live"; lastSeenAt?: number | null };

/**
 * Whether the capture handoff is currently usable, as of `now`.
 * `undefined` means "not knowable from what we were given" — never "no".
 */
export function handoffReady(state: HandoffState | undefined, now: number): boolean | undefined {
  if (!state) return undefined;
  if (state.kind === "configured") return state.ok;
  if (state.lastSeenAt === undefined) return undefined;
  return state.lastSeenAt !== null && now - state.lastSeenAt < WORKER_LIVE_WINDOW_MS;
}
