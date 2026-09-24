import { OPERATOR_BUILD } from "./operatorBuild";

export type IndexingStatus = {
  xmd: boolean;
  indexing: boolean;
  handoff: boolean;
  collectorMode: "outbound" | "receiver";
};

/**
 * What the client-facing app says when imports are off.
 *
 * Deliberately one sentence with no diagnosis in it, and no word implying
 * the cause is temporary: imports can be off because the worker is down
 * *or* because this deployment was never given an x.md key, and a visitor
 * cannot tell those apart or act on either. The specific reason is a fact
 * about how the deployment is run, so `indexingUnavailableMessage` below
 * says it only in the operator build, where `integrations.operator`
 * supplies the fields to say it from.
 */
export const IMPORTS_UNAVAILABLE = "Imports are not available on this site.";

/**
 * Starting/retrying an import, reading web context or a linked page, "Help
 * me search", Find on X, and Conversation all spend provider allowance
 * (x.md/Firecrawl/OpenAI) and therefore require a signed-in OPERATOR —
 * convex/access.ts `requireOperator` — not merely a signed-in guest
 * session. Every surface that offers one of those actions to a non-operator
 * shows this exact copy, so the boundary reads the same everywhere instead
 * of one place explaining it and another silently failing.
 *
 * There is no email sign-in path to operator status any more (that flow
 * lived only in the Import modal, and was removed): the operator build
 * carries its own build-time token (src/operatorToken.ts) and is only ever
 * reached on the operator site, which exe.dev's own login already
 * restricts to VM-access accounts — see docs/production.md. This copy just
 * points at where the action actually lives. Deliberately action-neutral
 * ("this action", not "imports") — CodeRabbit #4090910239 caught that the
 * previous "Imports run from the operator dashboard." was wrong on every
 * non-import surface reusing it (web context, linked pages, "Help me
 * search", cancel/dismiss), which don't import anything.
 */
// On the operator dashboard itself, pointing at the dashboard is wrong: the
// real state is that this build's operator token was not accepted (missing
// at build time, or mid-rotation).
export const OPERATOR_SIGN_IN_NOTICE = OPERATOR_BUILD
  ? "Operator access was not accepted. Check the operator token on this deployment."
  : "This action runs from the operator dashboard.";

/** Operator-only. The public build uses `IMPORTS_UNAVAILABLE` above. */
export function indexingUnavailableMessage(config: IndexingStatus): string | undefined {
  if (config.indexing) return undefined;

  if (!config.xmd) return "Indexing needs an x.md key. Configure it in Connections.";

  if (config.collectorMode === "outbound" && !config.handoff)
    return "The download worker is offline. Imports will be available when it reconnects.";

  if (!config.handoff) return "Indexing needs a raw-capture receiver. Configure it in Connections.";

  return "Indexing is temporarily unavailable.";
}

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
   * `lastSeenAt` is null when the worker is known to be down, and absent
   * when it was not disclosed at all. Those are different claims: absent
   * resolves to undefined so the caller reports "unknown" rather than
   * asserting something it was never told. Worker timing reaches only the
   * operator build now (`integrations.operator`), and the public bootstrap
   * query carries no handoff state whatsoever.
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

export type Connection = {
  name: string;
  ready: boolean | undefined;
  purpose: string;
  env?: string;
  note?: string;
  /**
   * What `ready` actually proves. Almost every row reports whether an
   * environment variable is set, which is a configuration fact and must not
   * be worded as connectivity. A row is only "live" when its readiness comes
   * from a real signal, such as the download worker's heartbeat.
   */
  proves?: "configured" | "live";
};

/**
 * The "stores imported posts" row in the Connections panel means two
 * different things depending on `convex/integrations.ts`'s `configured`
 * query: in receiver mode it's a config question (set the env vars), in
 * outbound mode it's a liveness question about the download worker (which
 * reads RAW_CAPTURE_URL/TOKEN on its own machine — setting them here does
 * nothing). Keep the vocabulary consistent with
 * `integrationStatus.ts`'s `indexingUnavailableMessage`.
 */
export function receiverConnection(
  collectorMode: "outbound" | "receiver" | undefined,
  ready: boolean | undefined,
): Connection {
  if (collectorMode === "outbound")
    return {
      name: "Download worker",
      ready,
      purpose: "Stores imported posts",
      note: "Connects to this deployment on its own and reconnects automatically — there's nothing to set here.",
      proves: "live",
    };

  return {
    name: "Raw capture receiver",
    ready,
    env: "RAW_CAPTURE_URL, RAW_CAPTURE_TOKEN",
    purpose: "Stores imported posts",
  };
}
