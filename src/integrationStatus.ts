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
