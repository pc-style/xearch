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
  liveNow,
  isAuthenticated,
}: {
  config: OperatorConfig | undefined;
  health: ServiceStatus[] | undefined;
  limits: ProviderLimit[] | undefined;
  // The SAME exact, unbucketed clock `config` was fetched with (a prop, not
  // its own `useDashboardClock()`/`useLiveNow()` call): convex/integrations.ts's
  // `operator` requires `now` to compute `config.handoff` against
  // convex/worker.ts's tight 45s `isWorkerLive` window, and `handoffReady`
  // below re-derives that same liveness fact against a ticking clock so the
  // reading keeps decaying between query re-runs — see src/library/clock.ts's
  // `useLiveNow` comment for why a bucketed `now` cannot feed either of those
  // safely, and src/operator/Connections.tsx for the same one-clock pattern.
  liveNow: number;
  isAuthenticated: boolean;
}) {
  const connections: Connection[] = [
    { name: "x.md", ready: config?.xmd, purpose: "Account histories, live search, conversations" },
    receiverConnection(config?.collectorMode, handoffReady(config?.handoffState, liveNow)),
    { name: "Search backend", ready: config?.search, purpose: "Finds posts in the library" },
    { name: "Firecrawl", ready: config?.firecrawl, purpose: "Reads pages linked in posts" },
    { name: "OpenAI", ready: config?.openai, purpose: "Turns a question into a clearer search" },
    { name: "AgentMail", ready: config?.email, purpose: "Emails search results" },
  ];

  // The download worker's row (`proves: "live"`) is a liveness fact — a
  // heartbeat observed or not — never a configuration fact, so it must
  // never share the word "Configured"/"Not configured" with the rows that
  // really are env-var presence checks.
  //
  // CodeRabbit (PR #48): `workerLastSeenAt` is the last heartbeat this app
  // ever received, not the moment the worker went offline — those are
  // different claims, and "Offline since {x}" reads as the latter. Split
  // the row into a stable status word (`word`, in a polite live region) and
  // a separately-rendered "last seen" detail: correct wording, and the
  // still-ticking relative-time text no longer sits inside the announced
  // region, so `useDashboardClock`'s periodic refresh does not re-announce
  // the same unchanged status every tick.
  const workerLastSeenAt =
    config?.handoffState?.kind === "live" ? config.handoffState.lastSeenAt : undefined;

  return (
    <div className="library-status">
      <h3 className="library-subhead">Status</h3>
      <div className="library-status-connections">
        {connections.map((c) => {
          const { word, detail } = connectionStatus(c, config, isAuthenticated, workerLastSeenAt);

          return (
            <div className="library-status-row" key={c.name}>
              <span>{c.name}</span>
              <span className="library-muted">
                {/* Only `word` is inside the live region: it changes when
                    the connection's actual state changes, never on its own
                    just because the clock ticked. */}
                <span aria-live="polite">{word}</span>
                {detail && ` · last seen ${formatRelative(detail, liveNow)}`}
              </span>
            </div>
          );
        })}
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

/**
 * The stable status word for one connection row, plus an optional raw
 * timestamp `detail` (never pre-formatted here — the caller decides whether
 * and how to render it against the live clock, and whether it belongs
 * inside or outside an announced region). Kept a pure function, separate
 * from render, so a screen reader's live region only ever receives `word`
 * — the fact that actually changed — never the ticking relative-time text.
 */
function connectionStatus(
  c: Connection,
  config: OperatorConfig | undefined,
  isAuthenticated: boolean,
  workerLastSeenAt: number | null | undefined,
) {
  if (!isAuthenticated) return { word: "Sign in to view" };

  if (!config) return { word: "Checking…" };

  if (c.proves === "live") {
    if (c.ready) return { word: "Online" };

    // CodeRabbit (PR #48): a real fix for "never observed" vs. "observed
    // offline" needs `convex/integrations.ts` to stop collapsing "no
    // worker record has ever existed" into the same `lastSeenAt: null` it
    // uses for "observed, and not currently online" (still true as of #44 —
    // that PR reworked worker-liveness plumbing but kept this exact
    // collapse) — out of scope here, since convex/ is owned by other work.
    // This still reports the honest, weaker claim available from what the
    // backend sends today: a real last-heartbeat time when there is one,
    // "Offline" with no invented time when there isn't. A domain check
    // (nullish, not `typeof`) is enough: `workerLastSeenAt` is already
    // `number | null | undefined` at its one source (`config.handoffState`,
    // parsed at that boundary), never an unparsed representation.
    return workerLastSeenAt === undefined || workerLastSeenAt === null
      ? { word: "Offline" }
      : { word: "Offline", detail: workerLastSeenAt };
  }

  return { word: c.ready ? "Configured" : "Not configured" };
}
