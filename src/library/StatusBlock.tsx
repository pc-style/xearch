import { For, Show } from "solid-js";
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
import { formatRelative, type Tone } from "./format";
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
export default function StatusBlock(props: {
  config: OperatorConfig | undefined;
  health: ServiceStatus[] | undefined;
  limits: ProviderLimit[] | undefined;
  // The SAME exact, unbucketed clock `config` was fetched with: `operator`
  // computes `config.handoff` against convex/worker.ts's tight 45s window,
  // and `handoffReady` below re-derives that liveness against a ticking
  // clock — see src/library/clock.ts's `useLiveNow` for why a bucketed
  // `now` can feed neither safely.
  liveNow: number;
  isAuthenticated: boolean;
}) {
  const connections = (): Connection[] => [
    {
      name: "x.md",
      ready: props.config?.xmd,
      purpose: "Account histories, live search, conversations",
    },
    receiverConnection(
      props.config?.collectorMode,
      handoffReady(props.config?.handoffState, props.liveNow),
    ),
    { name: "Search backend", ready: props.config?.search, purpose: "Finds posts in the library" },
    { name: "Firecrawl", ready: props.config?.firecrawl, purpose: "Reads pages linked in posts" },
    {
      name: "OpenAI",
      ready: props.config?.openai,
      purpose: "Turns a question into a clearer search",
    },
    { name: "AgentMail", ready: props.config?.email, purpose: "Emails search results" },
  ];

  // `lastSeenAt` is the last heartbeat ever received, not the moment the
  // worker went offline — so it is a separate "last seen" detail, kept out
  // of the live region so a clock tick never re-announces an unchanged status.
  const workerLastSeenAt = () =>
    props.config?.handoffState?.kind === "live" ? props.config.handoffState.lastSeenAt : undefined;

  const tone = (status: ServiceStatus): Tone =>
    status.kind === "unknown"
      ? "neutral"
      : status.stale
        ? "warning"
        : status.healthy
          ? "positive"
          : "danger";

  return (
    <div class="library-status">
      <h3 class="library-subhead">Status</h3>
      <div class="library-status-connections">
        <For each={connections()}>
          {(c) => {
            const state = () =>
              connectionStatus(c, props.config, props.isAuthenticated, workerLastSeenAt());

            return (
              <div class="library-status-row">
                <span>{c.name}</span>
                <span class="library-muted">
                  <span aria-live="polite">{state().word}</span>
                  <Show when={state().detail}>
                    {(detail) => ` · last seen ${formatRelative(detail(), props.liveNow)}`}
                  </Show>
                </span>
              </div>
            );
          }}
        </For>
      </div>
      <div class="library-health-row">
        <Show
          when={props.health}
          fallback={
            <For each={["indexer", "receiver", "search"] as const}>
              {(service) => (
                <Badge tone="neutral">
                  <span aria-live="polite">
                    {SERVICE_DISPLAY_NAME[service]}:{" "}
                    {props.isAuthenticated ? "loading…" : "connect to view"}
                  </span>
                </Badge>
              )}
            </For>
          }
        >
          <For each={props.health!}>
            {(status) => (
              <Badge tone={tone(status)}>
                {/* Only the result sits in the live region; the ticking
                    "last success" text stays outside it. */}
                <span aria-live="polite">
                  {SERVICE_DISPLAY_NAME[status.service]}: {serviceHealthLabel(status)}
                </span>
                {status.kind === "known" && status.lastSuccessAt !== undefined
                  ? ` (last success ${formatRelative(status.lastSuccessAt)})`
                  : ""}
              </Badge>
            )}
          </For>
        </Show>
      </div>
      <ProviderLimits limits={props.limits} isAuthenticated={props.isAuthenticated} />
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
/** A connection's one-word state, and when there is one, the last heartbeat
 * time the ticking detail line is rendered from. */
type ConnectionStatus = { word: string; detail?: number };

function connectionStatus(
  c: Connection,
  config: OperatorConfig | undefined,
  isAuthenticated: boolean,
  workerLastSeenAt: number | null | undefined,
): ConnectionStatus {
  if (!isAuthenticated) return { word: "Sign in to view" };

  if (!config) return { word: "Checking…" };

  if (c.proves === "live") {
    if (c.ready) return { word: "Online" };

    // "Never observed" and "observed, now offline" both arrive as a null
    // `lastSeenAt` today (convex/integrations.ts); report the honest,
    // weaker claim: a real last-heartbeat time when there is one.
    return workerLastSeenAt === undefined || workerLastSeenAt === null
      ? { word: "Offline" }
      : { word: "Offline", detail: workerLastSeenAt };
  }

  return { word: c.ready ? "Configured" : "Not configured" };
}
