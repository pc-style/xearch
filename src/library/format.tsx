import type { ReactNode } from "react";
import type { Count, PublicationState } from "../../convex/lib/contracts";
import type { JobStatus } from "../../convex/lib/contracts";

/**
 * Shared formatting and small presentational primitives for src/library/*.
 * Every number a person sees here traces back to a `Count` — see
 * docs/publication-contract.md "Dashboard-facing shapes" — so the one rule
 * that matters everywhere in this file is: "unknown" renders as the word
 * "unknown", never as 0 and never as an invented estimate.
 */

export type Tone = "neutral" | "positive" | "info" | "warning" | "danger";

const UNIT_LABEL: Record<Count["unit"], [singular: string, plural: string]> = {
  jobs: ["job", "jobs"],
  captures: ["capture", "captures"],
  posts: ["post", "posts"],
  accounts: ["account", "accounts"],
};

/** A count with its unit spelled out, e.g. "1,204 posts" or "unknown jobs".
 * Never call this without the unit already baked into `count` — that is the
 * whole point of the `Count` shape (a bare number can't say what it counts). */
export function countWithUnit(count: Count): string {
  const [singular, plural] = UNIT_LABEL[count.unit];
  if (count.kind === "unknown") return `unknown ${plural}`;
  return `${count.value.toLocaleString()} ${count.value === 1 ? singular : plural}`;
}

/** Just the value half of a `Count`, for a stat tile where the unit is
 * already the tile's own label. Still never 0-for-unknown. */
export function countValue(count: Count): string {
  return count.kind === "unknown" ? "unknown" : count.value.toLocaleString();
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "3m ago" / "2h ago" / "5d ago" style relative time, falling back to a
 * plain date once it is more than 30 days old. `now` is a parameter (not
 * read internally) so a caller can pin it for a stable render / a test. */
export function formatRelative(ms: number, now: number = Date.now()): string {
  const diff = now - ms;
  if (diff < 45_000) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  return new Date(ms).toLocaleDateString();
}

/** A run counts as possibly stalled only while it is still supposed to be
 * moving (queued/running) and has gone quiet well past a normal batch
 * cadence. This is a UI-only heuristic, not a stored fact — nothing in the
 * schema currently flags a stuck job, which is exactly the gap the
 * "dashboard" mapping run found (no comparison of Date.now()-updatedAt
 * exists anywhere in the app before this file). */
export const STALL_THRESHOLD_MS = 10 * MINUTE;
export function isStalledRun(
  status: JobStatus,
  updatedAt: number,
  now: number = Date.now(),
): boolean {
  return (status === "running" || status === "queued") && now - updatedAt > STALL_THRESHOLD_MS;
}

/** Copy + tone for accountPublications.state — the search-publication
 * pipeline, never to be conflated with the acquisition-job status below.
 * See docs/publication-contract.md "Publication states". */
export const PUBLICATION_STATE_META: Record<
  PublicationState,
  { label: string; tone: Tone; detail: string }
> = {
  downloaded: {
    label: "Downloaded",
    tone: "neutral",
    detail: "Saved from x.md. Not yet picked up for indexing.",
  },
  waiting_for_indexing: {
    label: "Waiting for indexing",
    tone: "neutral",
    detail: "Available for the indexer to pick up; no update from it yet.",
  },
  indexing: {
    label: "Indexing",
    tone: "info",
    detail: "The indexer is processing this account now.",
  },
  searchable: {
    label: "Searchable",
    tone: "positive",
    detail: "Confirmed live in the search index.",
  },
  failed: {
    label: "Publication failed",
    tone: "danger",
    detail: "The indexer reported a failure for the latest publication attempt.",
  },
};

/** Tone for an acquisition-job status, kept separate from
 * PUBLICATION_STATE_META above on purpose — an account can be
 * `publicationState: "failed"` while its latest job is `"complete"` (the
 * download succeeded, indexing did not), or vice versa. */
export function acquisitionStatusTone(status: JobStatus): Tone {
  switch (status) {
    case "complete":
      return "neutral";
    case "running":
    case "queued":
      return "info";
    case "cancelled":
      return "neutral";
    case "partial":
      return "warning";
    case "failed":
      return "danger";
  }
}

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`library-badge tone-${tone}`}>{children}</span>;
}
