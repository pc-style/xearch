/** Types for scripts/lib/backfillGaps.mjs, so tests (and the script) are checked. */

export interface Span {
  since: string;
  until: string;
}

export interface WindowRun extends Span {
  oldest: number;
  complete: boolean;
}

export interface Account {
  windows: Map<string, WindowRun>;
  timeline: number[];
}

/** One retained capture, as far as the gaps read it. */
export interface Capture {
  runId?: string;
  terminal?: string;
  request?: { resource?: string; input?: string };
  records?: { payload?: { posts?: { created_at?: string }[] } }[];
}

export function day(time: number): string;

export function addCapture(accounts: Map<string, Account>, capture: Capture): void;

export function covered(account: Account): Span[];

export function gaps(spans: Span[], floor: string, join?: number): Span[];
