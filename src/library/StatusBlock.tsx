import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { ServiceStatus } from "../../convex/summary";
import type { ProviderLimit } from "../../convex/limits";
import type { Connection } from "../integrationStatus";
import {
  SERVICE_DISPLAY_NAME,
  serviceHealthLabel,
  receiverConnection,
  handoffReady,
} from "../integrationStatus";
import { formatRelative } from "./format";
import { Badge } from "./format.tsx";
import { useDashboardClock } from "./clock";
import ProviderLimits from "./ProviderLimits";

type OperatorConfig = FunctionReturnType<typeof api.integrations.operator>;

/**
 * B2: one compact status block, replacing the three places this app used to
 * report status separately (the dashboard's own "Connections" list,
 * "Dependency health", and "Provider limits" sections). Connection
 * readiness never prints an env var name to the person looking at it — that
 * belongs in an operator's own deployment config, not in product copy — and
 * provider limits only ever appear when a provider has actually reported
 * being throttled, never as a permanent "all clear" row nobody asked for.
 */
export default function StatusBlock({
  config,
  health,
  limits,
  isAuthenticated,
}: {
  config: OperatorConfig | undefined;
  health: ServiceStatus[] | undefined;
  limits: ProviderLimit[] | undefined;
  isAuthenticated: boolean;
}) {
  const now = useDashboardClock();
  const connections: Connection[] = [
    { name: "x.md", ready: config?.xmd, purpose: "Account histories, live search, conversations" },
    receiverConnection(config?.collectorMode, handoffReady(config?.handoffState, now)),
    { name: "Search backend", ready: config?.search, purpose: "Finds posts in the library" },
    { name: "Firecrawl", ready: config?.firecrawl, purpose: "Reads pages linked in posts" },
    { name: "OpenAI", ready: config?.openai, purpose: "Turns a question into a clearer search" },
    { name: "AgentMail", ready: config?.email, purpose: "Emails search results" },
  ];
  // The download worker's row (`proves: "live"`) is a liveness fact — a
  // heartbeat observed or not — never a configuration fact, so it must
  // never share the word "Configured"/"Not configured" with the rows that
  // really are env-var presence checks. When it isn't currently online,
  // say since when, using the same `lastSeenAt` the worker itself reported
  // (never a guess) — "Not connected" alone hid that this is about a
  // process going quiet, not a missing setting.
  const workerLastSeenAt =
    config?.handoffState?.kind === "live" ? config.handoffState.lastSeenAt : undefined;

  return (
    <div className="library-status">
      <h3 className="library-subhead">Status</h3>
      <div className="library-status-connections">
        {connections.map((c) => (
          <div className="library-status-row" key={c.name}>
            <span>{c.name}</span>
            <span className="library-muted">
              {!isAuthenticated
                ? "Sign in to view"
                : !config
                  ? "Checking…"
                  : c.proves === "live"
                    ? c.ready
                      ? "Online"
                      : typeof workerLastSeenAt === "number"
                        ? `Offline since ${formatRelative(workerLastSeenAt, now)}`
                        : "Offline"
                    : c.ready
                      ? "Configured"
                      : "Not configured"}
            </span>
          </div>
        ))}
      </div>
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
      <ProviderLimits limits={limits} isAuthenticated={isAuthenticated} />
    </div>
  );
}
