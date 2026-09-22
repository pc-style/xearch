import type { Doc } from "../../convex/_generated/dataModel";
import {
  connectionDelta,
  deriveSearchMetrics,
  formatDurationMs,
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

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span>{label}</span>
      <span>{value}</span>
    </>
  );
}

export function NerdStatsPanel({
  frontend,
  result,
}: {
  frontend: SearchAttemptSnapshot | null;
  result: SessionResult | undefined;
}) {
  const metrics = deriveSearchMetrics(frontend);
  const submitToSession = connectionDelta(
    frontend?.connectionAtSubmit ?? null,
    frontend?.connectionAtSession ?? null,
  );
  const sessionToTerminal = connectionDelta(
    frontend?.connectionAtSession ?? null,
    frontend?.connectionAtTerminal ?? null,
  );
  const backend = result?.stats?.backend;
  const apiStats = result?.stats?.api;

  return (
    <details className="stats-panel" open={false}>
      <summary>
        Stats for nerds —{" "}
        {(() => {
          const us = apiStats?.totalUs ?? backend?.totalUs;
          return us === undefined ? "—" : formatDuration(us);
        })()}
        {metrics.submitToTerminalMs !== null && (
          <> · client {formatDurationMs(metrics.submitToTerminalMs)}</>
        )}
      </summary>
      <div className="stats-grid">
        <strong>{SECTION_LABELS[NerdSection.Frontend]}</strong>
        <Row label="Submit → mutation" value={formatDurationMs(metrics.submitToMutationStartMs)} />
        <Row label="Mutation → session" value={formatDurationMs(metrics.mutationMs)} />
        <Row
          label="Session → first result"
          value={formatDurationMs(metrics.sessionToFirstResultMs)}
        />
        <Row
          label="Submit → first result"
          value={formatDurationMs(metrics.submitToFirstResultMs)}
        />
        <Row label="First → terminal" value={formatDurationMs(metrics.firstResultToTerminalMs)} />
        <Row label="Submit → terminal" value={formatDurationMs(metrics.submitToTerminalMs)} />
        <Row label="First result → paint" value={formatDurationMs(metrics.firstResultToPaintMs)} />
        <Row label="Trigger" value={frontend?.trigger ?? "—"} />
        <Row label="Status" value={frontend?.status ?? "—"} />

        <strong>{SECTION_LABELS[NerdSection.Render]}</strong>
        <Row label="Commit (actual)" value={formatDurationMs(metrics.actualDurationMs)} />
        <Row label="Commit (base)" value={formatDurationMs(metrics.baseDurationMs)} />

        {backend && (
          <>
            <strong>{SECTION_LABELS[NerdSection.Backend]}</strong>
            <Row label="Total" value={formatDuration(backend.totalUs)} />
            <Row label="Reload index" value={formatDuration(backend.reloadUs)} />
            <Row label="Fingerprint" value={formatDuration(backend.fingerprintUs)} />
            <Row label="Compile query" value={formatDuration(backend.compileUs)} />
            <Row label="Retrieve" value={formatDuration(backend.retrieveUs)} />
            <Row label="Retrieve + rank" value={`${backend.rankingCalls} calls`} />
            <Row label="Materialize rows" value={formatDuration(backend.materializeUs)} />
            <Row
              label="Hits / returned"
              value={`${backend.candidateHits} / ${backend.returnedRows}`}
            />
            <Row label="Index" value={`${backend.indexDocs} docs / ${backend.segments} segments`} />
          </>
        )}
        {apiStats && (
          <>
            <strong>API</strong>
            <Row label="Auth" value={formatDuration(apiStats.authUs)} />
            <Row label="Parse" value={formatDuration(apiStats.parseUs)} />
            <Row label="Queue" value={formatDuration(apiStats.queueUs)} />
            <Row label="Engine wall" value={formatDuration(apiStats.engineUs)} />
            <Row label="Post-process" value={formatDuration(apiStats.postprocessUs)} />
            <Row label="API total" value={formatDuration(apiStats.totalUs)} />
          </>
        )}

        <strong>{SECTION_LABELS[NerdSection.Connection]}</strong>
        <Row
          label="Submit → session reconnects"
          value={
            submitToSession
              ? `${submitToSession.connectionCountDelta} (reconnected: ${submitToSession.reconnected ? "yes" : "no"})`
              : "—"
          }
        />
        <Row
          label="Session → terminal reconnects"
          value={
            sessionToTerminal
              ? `${sessionToTerminal.connectionCountDelta} (reconnected: ${sessionToTerminal.reconnected ? "yes" : "no"})`
              : "—"
          }
        />
      </div>
    </details>
  );
}
