import { v, type Infer } from "convex/values";
import {
  publicationUpdateFields,
  publicationStateValidator,
  reportedPublicationStateValidator,
  countUnitValidator,
  jobStatusValidator,
} from "../schema";

/**
 * Shared wire and return shapes for the publication contract between this
 * app and Pronsh's indexer, plus the dashboard summary shapes built from
 * them. Full prose semantics, idempotency rules, and the open assumptions
 * this file makes are in docs/publication-contract.md — read that before
 * implementing a receiver or a dashboard query against these types.
 *
 * Nothing here talks to the network or the database. These are Convex
 * validators (for `args`/`returns` on the functions other agents write) and
 * the plain TypeScript types `Infer` derives from them.
 *
 * Do NOT implement any indexer, watcher, registry, cursor signing, or retry
 * loop against these shapes on this side — that is Pronsh's side of the
 * fence. This file only freezes what crosses the boundary.
 */

// --- Publication update envelope --------------------------------------------
// The authenticated, idempotent update that carries capture/job identity,
// account identity, a committed generation, unique counts, pending-work
// units, timestamps, and errors across the boundary. Every field below is
// exactly a publicationUpdateFields field (convex/schema.ts) plus a version
// tag, so this envelope and the durable publicationUpdates log it gets
// written to can never drift apart — see docs/publication-contract.md
// section "Envelope fields" for what each one means and who may omit it.
export const publicationUpdateEnvelope = v.object({
  version: v.literal(1),
  ...publicationUpdateFields,
});
export type PublicationUpdateEnvelope = Infer<typeof publicationUpdateEnvelope>;

// --- Counts, labelled and honestly unknown ----------------------------------
// Every count this app shows a person must say what it counts (jobs,
// captures, posts, or accounts) and must be able to say "unknown" instead of
// a number. Never collapse "unknown" into 0: a known count of 0 is a claim
// that we checked and found nothing, "unknown" is a claim that we have not
// checked or the upstream side did not say. Never invent or estimate a
// "known" value to avoid returning "unknown".
export const countValidator = v.union(
  v.object({ kind: v.literal("known"), unit: countUnitValidator, value: v.number() }),
  v.object({ kind: v.literal("unknown"), unit: countUnitValidator }),
);
export type Count = Infer<typeof countValidator>;

// --- Dashboard summary -------------------------------------------------------
// The scope a summary's counts are authorized over.
//   - "owner": every account the signed-in caller has imported themselves,
//     derived server-side from their own `jobs.owner` rows. This is what
//     `convex/summary.ts` returns, and it is the ONLY scope the dashboard
//     presents as the caller's own numbers.
//   - "global": every account in the deployment regardless of who imported
//     it. The summary used to report this while the account list beside it
//     was owner-scoped, so the two contradicted each other and a caller with
//     no imports of their own could still see a nonzero total. Kept in the
//     union because it is a meaningful scope to state, not because anything
//     returns it today.
//   - "account": a single account. Reserved for to-do.md P1's authorized
//     collection access; not wired to anything yet.
export const summaryScopeValidator = v.union(
  v.object({ kind: v.literal("owner") }),
  v.object({ kind: v.literal("global") }),
  v.object({ kind: v.literal("account"), accountId: v.id("accounts") }),
);
export type SummaryScope = Infer<typeof summaryScopeValidator>;

export const queueBreakdownValidator = v.object({
  // unit "jobs" — jobs.status === "queued".
  waitingDownloads: countValidator,
  // unit "jobs" — jobs.status === "running".
  activeDownloads: countValidator,
  // unit "captures" — durable receipts this app has not yet seen confirmed
  // by any accepted publication update (accountPublications.state is
  // "downloaded" | "waiting_for_indexing" | "indexing" territory).
  savedCapturesAwaitingIndexing: countValidator,
  // unit "jobs" — jobs.status in "failed" | "partial" that a person can
  // retry (see jobs.retry). Not the same bucket as a "failed" publication;
  // an account can be accountPublications.state === "failed" while its
  // underlying job is "complete" (the download succeeded, indexing did not).
  failedRetryable: countValidator,
});
export type QueueBreakdown = Infer<typeof queueBreakdownValidator>;

export const dashboardSummaryValidator = v.object({
  // unit "posts" — sum of accountPublications.searchablePostCount across the
  // scope below. NEVER a sum of jobs.count (accepted raw records) or
  // jobs.postsReceived (per-page download counter). "unknown" when any
  // in-scope account's own count is unknown, unless the implementation can
  // state a true partial sum plus which accounts are excluded — see
  // docs/publication-contract.md "what unique means".
  indexedPosts: countValidator,
  // unit "accounts" — distinct in-scope accounts with
  // accountPublications.state === "searchable". With `scope.kind === "owner"`
  // this is drawn from exactly the same account set as the account-library
  // rows it links to, so the number and the list below it agree by
  // construction rather than by coincidence.
  indexedAccounts: countValidator,
  queue: queueBreakdownValidator,
  scope: summaryScopeValidator,
  // When this summary was computed (assigned by the query/action that built
  // it). A summary is a point-in-time read, not a live guarantee.
  observedAt: v.number(),
});
export type DashboardSummary = Infer<typeof dashboardSummaryValidator>;

// --- Account library row -----------------------------------------------------
// The next useful thing a person can do about one account's row. Carries
// only the ids/timestamps a UI needs to pick a label and an action; it does
// not invent copy, since wording is a UI-layer decision (see the "dashboard"
// reader's findings on contradictory copy — this type exists so the copy has
// something honest to read from).
export const nextActionValidator = v.union(
  v.object({ kind: v.literal("retry"), jobId: v.id("jobs") }),
  v.object({ kind: v.literal("wait"), jobId: v.id("jobs"), readyAt: v.number() }),
  v.object({ kind: v.literal("continue"), jobId: v.id("jobs") }),
  v.object({ kind: v.literal("none") }),
);
export type NextAction = Infer<typeof nextActionValidator>;

export const accountLibraryRowValidator = v.object({
  accountId: v.id("accounts"),
  handle: v.string(),
  name: v.string(),
  avatar: v.optional(v.string()),
  // Current pipeline state (accountPublications.state). A failed refresh
  // shows up here without touching searchablePostCount below — see to-do.md
  // "Show indexed accounts even when their latest refresh failed."
  publicationState: publicationStateValidator,
  searchablePostCount: countValidator,
  searchablePostCountAsOf: v.optional(v.number()),
  lastPublishedAt: v.optional(v.number()),
  lastError: v.optional(v.object({ message: v.string(), observedAt: v.number() })),
  // The account's most recent acquisition job, when one exists. Present even
  // when that job failed: an indexed account with a failed latest refresh
  // must keep showing its usable corpus alongside the failure.
  latestJob: v.optional(
    v.object({
      jobId: v.id("jobs"),
      status: jobStatusValidator,
      phase: v.optional(v.string()),
      updatedAt: v.number(),
    }),
  ),
  nextAction: nextActionValidator,
});
export type AccountLibraryRow = Infer<typeof accountLibraryRowValidator>;

// --- Convenience type aliases -------------------------------------------------
// Re-exported so other modules can import one plain TS type instead of
// reaching into convex/schema.ts and calling Infer themselves.
export type PublicationState = Infer<typeof publicationStateValidator>;
export type ReportedPublicationState = Infer<typeof reportedPublicationStateValidator>;
export type JobStatus = Infer<typeof jobStatusValidator>;
