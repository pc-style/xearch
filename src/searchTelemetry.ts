import type { Id } from "../convex/_generated/dataModel";

export type SearchAttemptId = number;

export type SearchSessionId = Id<"sessions">;

export type MonotonicClock = () => number;

export type FrameScheduler = (callback: () => void) => void;

/** The UI entry point that created a client-side search attempt. */
export enum SearchTrigger {
  Submit = "submit",
  InitialUrl = "initial-url",
  Retry = "retry",
  NextPage = "next-page",
  SavedSearch = "saved-search",
  Author = "author",
}

/** Client-side lifecycle state; provider and Convex stats use separate units and types. */
export enum SearchStatus {
  Submitted = "submitted",
  MutationStarted = "mutation-started",
  SessionReady = "session-ready",
  Queued = "queued",
  Running = "running",
  Complete = "complete",
  Failed = "failed",
}

export type SearchResultStatus =
  | SearchStatus.Queued
  | SearchStatus.Running
  | SearchStatus.Complete
  | SearchStatus.Failed;

export type SearchTerminalStatus = SearchStatus.Complete | SearchStatus.Failed;

/** The part of Convex's connection state useful at a search boundary. */
export interface ConvexConnectionState {
  readonly isWebSocketConnected: boolean;
  readonly hasEverConnected: boolean;
  readonly connectionCount: number;
  readonly connectionRetries?: number;
  readonly hasInflightRequests?: boolean;
  readonly inflightMutations?: number;
  readonly inflightActions?: number;
}

export interface ConnectionObservation extends ConvexConnectionState {
  readonly observedAt: number;
}

export interface SearchAttemptSnapshot {
  readonly attemptId: SearchAttemptId;
  readonly trigger: SearchTrigger;
  readonly submittedAt: number;
  readonly mutationStartedAt: number | null;
  readonly sessionAt: number | null;
  readonly sessionId: SearchSessionId | null;
  readonly firstResultCommitAt: number | null;
  readonly terminalCommitAt: number | null;
  readonly status: SearchStatus;
  readonly terminalStatus: SearchTerminalStatus | null;
  readonly terminalRowCount: number | null;
  readonly nextFramePaintAt: number | null;
  readonly actualDurationMs: number | null;
  readonly baseDurationMs: number | null;
  readonly connectionAtSubmit: ConnectionObservation | null;
  readonly connectionAtSession: ConnectionObservation | null;
  readonly connectionAtTerminal: ConnectionObservation | null;
}

export interface StartAttemptInput {
  readonly trigger: SearchTrigger;
  readonly attemptId?: SearchAttemptId;
  readonly connection?: ConvexConnectionState;
}

export interface ResultCommitInput {
  readonly attemptId: SearchAttemptId;
  readonly status: SearchResultStatus;
  readonly rowCount: number;
  readonly sessionId?: SearchSessionId;
  readonly connection?: ConvexConnectionState;
}

export interface TerminalInput {
  readonly attemptId: SearchAttemptId;
  readonly status: SearchTerminalStatus;
  readonly rowCount: number;
  readonly sessionId?: SearchSessionId;
  readonly connection?: ConvexConnectionState;
}

export interface SearchTelemetryOptions {
  readonly clock?: MonotonicClock;
  readonly scheduleFrame?: FrameScheduler;
}

export interface SearchTelemetryStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => SearchAttemptSnapshot | null;
  readonly getServerSnapshot: () => SearchAttemptSnapshot | null;
  readonly startAttempt: (input: StartAttemptInput) => SearchAttemptId;
  readonly markMutationStarted: (attemptId: SearchAttemptId) => boolean;
  readonly markSession: (
    attemptId: SearchAttemptId,
    sessionId: SearchSessionId,
    connection?: ConvexConnectionState,
  ) => boolean;
  readonly markResultCommit: (input: ResultCommitInput) => boolean;
  readonly markTerminal: (input: TerminalInput) => boolean;
  readonly recordProfiler: (
    attemptId: SearchAttemptId,
    actualDurationMs: number,
    baseDurationMs: number,
  ) => boolean;
  readonly reset: () => void;
}

export interface SearchTimingMetrics {
  readonly submitToMutationStartMs: number | null;
  readonly mutationMs: number | null;
  readonly sessionToFirstResultMs: number | null;
  readonly submitToFirstResultMs: number | null;
  readonly firstResultToTerminalMs: number | null;
  readonly sessionToTerminalMs: number | null;
  readonly submitToTerminalMs: number | null;
  readonly firstResultToPaintMs: number | null;
  readonly actualDurationMs: number | null;
  readonly baseDurationMs: number | null;
}

export interface CommitResult {
  readonly changed: boolean;
  readonly firstResult: boolean;
}

export interface ConnectionDelta {
  readonly elapsedMs: number;
  readonly connectionCountDelta: number;
  readonly connectionRetriesDelta: number | null;
  readonly connectivityChanged: boolean;
  readonly everConnectedChanged: boolean;
  readonly reconnected: boolean;
}

const EMPTY_SERVER_SNAPSHOT: SearchAttemptSnapshot | null = null;

const STATUS_RANK: Record<SearchStatus, number> = {
  [SearchStatus.Submitted]: 0,
  [SearchStatus.MutationStarted]: 1,
  [SearchStatus.SessionReady]: 2,
  [SearchStatus.Queued]: 3,
  [SearchStatus.Running]: 4,
  [SearchStatus.Complete]: 5,
  [SearchStatus.Failed]: 5,
};

const defaultClock: MonotonicClock = () =>
  typeof performance === "undefined" ? Date.now() : performance.now();

const defaultScheduleFrame: FrameScheduler = (callback) => {
  if (typeof requestAnimationFrame === "undefined") return;
  requestAnimationFrame(() => callback());
};

function isTerminalStatus(status: SearchResultStatus): status is SearchTerminalStatus {
  return status === SearchStatus.Complete || status === SearchStatus.Failed;
}

function advanceStatus(current: SearchStatus, next: SearchStatus): SearchStatus {
  return STATUS_RANK[next] >= STATUS_RANK[current] ? next : current;
}

function observeConnection(
  state: ConvexConnectionState | undefined,
  observedAt: number,
): ConnectionObservation | null {
  if (!state) return null;

  const observation: ConnectionObservation = {
    observedAt,
    isWebSocketConnected: state.isWebSocketConnected,
    hasEverConnected: state.hasEverConnected,
    connectionCount: state.connectionCount,
    connectionRetries: state.connectionRetries,
    hasInflightRequests: state.hasInflightRequests,
    inflightMutations: state.inflightMutations,
    inflightActions: state.inflightActions,
  };

  return Object.freeze(observation);
}

function freezeAttempt(attempt: SearchAttemptSnapshot): SearchAttemptSnapshot {
  return Object.freeze(attempt);
}

function difference(end: number | null, start: number | null): number | null {
  return end === null || start === null ? null : end - start;
}

function validDuration(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

export function createSearchTelemetryStore(
  options: SearchTelemetryOptions = {},
): SearchTelemetryStore {
  const clock = options.clock ?? defaultClock;
  const scheduleFrame = options.scheduleFrame ?? defaultScheduleFrame;
  const listeners = new Set<() => void>();
  let current: SearchAttemptSnapshot | null = null;
  let nextAttemptId = 0;

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  const update = (
    attemptId: SearchAttemptId,
    change: (attempt: SearchAttemptSnapshot) => SearchAttemptSnapshot,
  ): boolean => {
    if (!current || current.attemptId !== attemptId) return false;
    const next = change(current);

    if (next === current) return false;
    current = freezeAttempt(next);
    notify();

    return true;
  };

  const schedulePaint = (attemptId: SearchAttemptId) => {
    scheduleFrame(() => {
      update(attemptId, (attempt) => {
        if (attempt.nextFramePaintAt !== null) return attempt;

        return { ...attempt, nextFramePaintAt: clock() };
      });
    });
  };

  const commitResult = (
    input: ResultCommitInput,
    committedAt: number,
  ): CommitResult => {
    if (!current || current.attemptId !== input.attemptId) {
      return { changed: false, firstResult: false };
    }

    if (input.sessionId && current.sessionId && input.sessionId !== current.sessionId) {
      return { changed: false, firstResult: false };
    }

    if (current.terminalCommitAt !== null) return { changed: false, firstResult: false };

    const firstResult = current.firstResultCommitAt === null;
    const terminal = isTerminalStatus(input.status);
    const nextStatus = advanceStatus(current.status, input.status);

    const nextTerminal = terminal
      ? {
          terminalCommitAt: committedAt,
          terminalStatus: input.status,
          terminalRowCount: input.rowCount,
          connectionAtTerminal: observeConnection(input.connection, committedAt),
        }
      : {};

    const changed = update(input.attemptId, (attempt) => ({
      ...attempt,
      firstResultCommitAt: attempt.firstResultCommitAt ?? committedAt,
      status: nextStatus,
      ...nextTerminal,
    }));

    if (changed && firstResult) schedulePaint(input.attemptId);

    return { changed, firstResult };
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);

    return () => {
      listeners.delete(listener);
    };
  };

  const getSnapshot = (): SearchAttemptSnapshot | null => current;
  const getServerSnapshot = (): SearchAttemptSnapshot | null => EMPTY_SERVER_SNAPSHOT;

  const startAttempt = (input: StartAttemptInput): SearchAttemptId => {
    const attemptId = input.attemptId ?? nextAttemptId + 1;

    if (attemptId > nextAttemptId) nextAttemptId = attemptId;

    if (
      current &&
      (attemptId < current.attemptId ||
        (attemptId === current.attemptId && input.attemptId !== undefined))
    )
      return attemptId;

    const submittedAt = clock();
    current = freezeAttempt({
      attemptId,
      trigger: input.trigger,
      submittedAt,
      mutationStartedAt: null,
      sessionAt: null,
      sessionId: null,
      firstResultCommitAt: null,
      terminalCommitAt: null,
      status: SearchStatus.Submitted,
      terminalStatus: null,
      terminalRowCount: null,
      nextFramePaintAt: null,
      actualDurationMs: null,
      baseDurationMs: null,
      connectionAtSubmit: observeConnection(input.connection, submittedAt),
      connectionAtSession: null,
      connectionAtTerminal: null,
    });
    notify();

    return attemptId;
  };

  const markMutationStarted = (attemptId: SearchAttemptId): boolean => {
    if (!current || current.attemptId !== attemptId || current.mutationStartedAt !== null)
      return false;
    const mutationStartedAt = clock();

    return update(attemptId, (attempt) => ({
      ...attempt,
      mutationStartedAt,
      status: advanceStatus(attempt.status, SearchStatus.MutationStarted),
    }));
  };

  const markSession = (
    attemptId: SearchAttemptId,
    sessionId: SearchSessionId,
    connection?: ConvexConnectionState,
  ): boolean => {
    if (!current || current.attemptId !== attemptId) return false;

    if (current.sessionId && current.sessionId !== sessionId) return false;
    const sessionAt = current.sessionAt ?? clock();

    const sessionConnection =
      current.connectionAtSession ?? observeConnection(connection, sessionAt);

    if (
      current.sessionAt !== null &&
      current.connectionAtSession === sessionConnection &&
      current.status === advanceStatus(current.status, SearchStatus.SessionReady)
    )
      return false;

    return update(attemptId, (attempt) => ({
      ...attempt,
      sessionAt: attempt.sessionAt ?? sessionAt,
      sessionId: attempt.sessionId ?? sessionId,
      status: advanceStatus(attempt.status, SearchStatus.SessionReady),
      connectionAtSession: attempt.connectionAtSession ?? sessionConnection,
    }));
  };

  const markResultCommit = (input: ResultCommitInput): boolean => {
    if (!current || current.attemptId !== input.attemptId) return false;

    if (current.terminalCommitAt !== null) return false;
    const committedAt = clock();

    return commitResult(input, committedAt).changed;
  };

  const markTerminal = (input: TerminalInput): boolean =>
    markResultCommit({
      attemptId: input.attemptId,
      status: input.status,
      rowCount: input.rowCount,
      sessionId: input.sessionId,
      connection: input.connection,
    });

  const recordProfiler = (
    attemptId: SearchAttemptId,
    actualDurationMs: number,
    baseDurationMs: number,
  ): boolean => {
    if (
      !current ||
      current.attemptId !== attemptId ||
      !validDuration(actualDurationMs) ||
      !validDuration(baseDurationMs) ||
      (current.actualDurationMs === actualDurationMs && current.baseDurationMs === baseDurationMs)
    )
      return false;

    return update(attemptId, () => ({
      ...current!,
      actualDurationMs,
      baseDurationMs,
    }));
  };

  const reset = () => {
    if (current === null) return;
    current = null;
    notify();
  };

  return Object.freeze({
    subscribe,
    getSnapshot,
    getServerSnapshot,
    startAttempt,
    markMutationStarted,
    markSession,
    markResultCommit,
    markTerminal,
    recordProfiler,
    reset,
  });
}

export function deriveSearchMetrics(attempt: SearchAttemptSnapshot | null): SearchTimingMetrics {
  if (!attempt)
    return {
      submitToMutationStartMs: null,
      mutationMs: null,
      sessionToFirstResultMs: null,
      submitToFirstResultMs: null,
      firstResultToTerminalMs: null,
      sessionToTerminalMs: null,
      submitToTerminalMs: null,
      firstResultToPaintMs: null,
      actualDurationMs: null,
      baseDurationMs: null,
    };

  return {
    submitToMutationStartMs: difference(attempt.mutationStartedAt, attempt.submittedAt),
    mutationMs: difference(attempt.sessionAt, attempt.mutationStartedAt),
    sessionToFirstResultMs: difference(attempt.firstResultCommitAt, attempt.sessionAt),
    submitToFirstResultMs: difference(attempt.firstResultCommitAt, attempt.submittedAt),
    firstResultToTerminalMs: difference(attempt.terminalCommitAt, attempt.firstResultCommitAt),
    sessionToTerminalMs: difference(attempt.terminalCommitAt, attempt.sessionAt),
    submitToTerminalMs: difference(attempt.terminalCommitAt, attempt.submittedAt),
    firstResultToPaintMs: difference(attempt.nextFramePaintAt, attempt.firstResultCommitAt),
    actualDurationMs: attempt.actualDurationMs,
    baseDurationMs: attempt.baseDurationMs,
  };
}

export const deriveTimingMetrics = deriveSearchMetrics;

export function connectionDelta(
  before: ConnectionObservation | null,
  after: ConnectionObservation | null,
): ConnectionDelta | null {
  if (!before || !after) return null;

  const retriesAvailable =
    before.connectionRetries !== undefined && after.connectionRetries !== undefined;

  return {
    elapsedMs: after.observedAt - before.observedAt,
    connectionCountDelta: after.connectionCount - before.connectionCount,
    connectionRetriesDelta: retriesAvailable
      ? after.connectionRetries! - before.connectionRetries!
      : null,
    connectivityChanged: before.isWebSocketConnected !== after.isWebSocketConnected,
    everConnectedChanged: before.hasEverConnected !== after.hasEverConnected,
    reconnected: !before.isWebSocketConnected && after.isWebSocketConnected,
  };
}

export const getConnectionDelta = connectionDelta;

export interface SearchConnectionDeltas {
  readonly submitToSession: ConnectionDelta | null;
  readonly sessionToTerminal: ConnectionDelta | null;
}

export function deriveConnectionDeltas(
  attempt: SearchAttemptSnapshot | null,
): SearchConnectionDeltas {
  if (!attempt)
    return {
      submitToSession: null,
      sessionToTerminal: null,
    };

  return {
    submitToSession: connectionDelta(attempt.connectionAtSubmit, attempt.connectionAtSession),
    sessionToTerminal: connectionDelta(attempt.connectionAtSession, attempt.connectionAtTerminal),
  };
}

/** Formats client timings in browser milliseconds; it never treats them as provider microseconds. */
export function formatDurationMs(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs)) return "—";

  if (Math.abs(durationMs) >= 1_000) return `${(durationMs / 1_000).toFixed(2)} s`;

  return `${durationMs.toFixed(2)} ms`;
}

export const formatFrontendDuration = formatDurationMs;

export const searchTelemetryStore = createSearchTelemetryStore();

export const searchTelemetry = searchTelemetryStore;

export const subscribe = searchTelemetryStore.subscribe;

export const getSnapshot = searchTelemetryStore.getSnapshot;

export const getServerSnapshot = searchTelemetryStore.getServerSnapshot;
