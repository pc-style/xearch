import { Show } from "solid-js";
import type { Doc } from "../../convex/_generated/dataModel";
import {
  connectionDelta,
  deriveSearchMetrics,
  formatDurationMs,
  type ConnectionDelta,
  type SearchAttemptSnapshot,
} from "../searchTelemetry";
import { formatDuration } from "./format";
import { NerdSection } from "../uiState";

const SECTION_LABELS: Record<NerdSection, string> = {
  [NerdSection.Frontend]: "Frontend",
  [NerdSection.Backend]: "Backend",
  [NerdSection.Connection]: "Connection",
  [NerdSection.Render]: "Render",
};

type SessionResult = Doc<"sessions">;

function Row(props: { label: string; value: string }) {
  return (
    <>
      <span>{props.label}</span>
      <span>{props.value}</span>
    </>
  );
}

const reconnects = (delta: ConnectionDelta | null) =>
  delta ? `${delta.connectionCountDelta} (reconnected: ${delta.reconnected ? "yes" : "no"})` : "—";

/**
 * "Stats for nerds": the client's own timings for this search attempt
 * (src/searchTelemetry.ts), and the search service's timings from the
 * session it wrote. Client milliseconds and provider microseconds are
 * formatted by separate helpers so the two units never mix.
 */
export function NerdStatsPanel(props: {
  frontend: SearchAttemptSnapshot | null;
  result: SessionResult | undefined;
}) {
  const metrics = () => deriveSearchMetrics(props.frontend);
  const backend = () => props.result?.stats?.backend;
  const apiStats = () => props.result?.stats?.api;

  const serverTotal = () => {
    const us = apiStats()?.totalUs ?? backend()?.totalUs;

    return us === undefined ? "—" : formatDuration(us);
  };

  return (
    <details class="stats-panel">
      <summary>
        Stats for nerds — {serverTotal()}
        <Show when={metrics().submitToTerminalMs !== null}>
          {" "}
          · client {formatDurationMs(metrics().submitToTerminalMs)}
        </Show>
      </summary>
      <div class="stats-grid">
        <strong>{SECTION_LABELS[NerdSection.Frontend]}</strong>
        <Row
          label="Submit → mutation"
          value={formatDurationMs(metrics().submitToMutationStartMs)}
        />
        <Row label="Mutation → session" value={formatDurationMs(metrics().mutationMs)} />
        <Row
          label="Session → first result"
          value={formatDurationMs(metrics().sessionToFirstResultMs)}
        />
        <Row
          label="Submit → first result"
          value={formatDurationMs(metrics().submitToFirstResultMs)}
        />
        <Row label="First → terminal" value={formatDurationMs(metrics().firstResultToTerminalMs)} />
        <Row label="Submit → terminal" value={formatDurationMs(metrics().submitToTerminalMs)} />
        <Row
          label="First result → paint"
          value={formatDurationMs(metrics().firstResultToPaintMs)}
        />
        <Row label="Trigger" value={props.frontend?.trigger ?? "—"} />
        <Row label="Status" value={props.frontend?.status ?? "—"} />

        <strong>{SECTION_LABELS[NerdSection.Render]}</strong>
        <Row label="DOM update" value={formatDurationMs(metrics().actualDurationMs)} />

        <Show when={backend()}>
          {(b) => (
            <>
              <strong>{SECTION_LABELS[NerdSection.Backend]}</strong>
              <Row label="Total" value={formatDuration(b().totalUs)} />
              <Row label="Reload index" value={formatDuration(b().reloadUs)} />
              <Row label="Fingerprint" value={formatDuration(b().fingerprintUs)} />
              <Row label="Compile query" value={formatDuration(b().compileUs)} />
              <Row label="Retrieve" value={formatDuration(b().retrieveUs)} />
              <Row label="Retrieve + rank" value={`${b().rankingCalls} calls`} />
              <Row label="Materialize rows" value={formatDuration(b().materializeUs)} />
              <Row label="Hits / returned" value={`${b().candidateHits} / ${b().returnedRows}`} />
              <Row label="Index" value={`${b().indexDocs} docs / ${b().segments} segments`} />
            </>
          )}
        </Show>
        <Show when={apiStats()}>
          {(a) => (
            <>
              <strong>API</strong>
              <Row label="Auth" value={formatDuration(a().authUs)} />
              <Row label="Parse" value={formatDuration(a().parseUs)} />
              <Row label="Queue" value={formatDuration(a().queueUs)} />
              <Row label="Engine wall" value={formatDuration(a().engineUs)} />
              <Row label="Post-process" value={formatDuration(a().postprocessUs)} />
              <Row label="API total" value={formatDuration(a().totalUs)} />
            </>
          )}
        </Show>

        <strong>{SECTION_LABELS[NerdSection.Connection]}</strong>
        <Row
          label="Submit → session reconnects"
          value={reconnects(
            connectionDelta(
              props.frontend?.connectionAtSubmit ?? null,
              props.frontend?.connectionAtSession ?? null,
            ),
          )}
        />
        <Row
          label="Session → terminal reconnects"
          value={reconnects(
            connectionDelta(
              props.frontend?.connectionAtSession ?? null,
              props.frontend?.connectionAtTerminal ?? null,
            ),
          )}
        />
      </div>
    </details>
  );
}
