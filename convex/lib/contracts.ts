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
//     derived server-side from their own `jobs.owner` rows. No longer
//     returned by `convex/summary.ts` — the imported corpus is shared
//     infrastructure, not personal data (to-do.md, convex/lib/search.ts), so
//     every signed-in caller now sees the same totals — but kept as a
//     declared shape for any future per-owner view.
//   - "global": every account in the deployment. This is what
//     `convex/summary.ts` now always returns, and it is also an accepted
//     INPUT: `convex/search.ts` takes a caller-supplied scope and this is
//     the one value its fail-closed gate allows, meaning "the whole shared
//     corpus".
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

// --- Provider-reported queued work -------------------------------------------
// What the INDEXER says is still outstanding for the in-scope accounts:
// accountPublications.pendingWork, written from
// publicationUpdateFields.pendingWork on any applied update
// (convex/schema.ts, convex/publication.ts).
//
// Deliberately NOT a fifth field inside queueBreakdownValidator above. Those
// four buckets are work this app can see for itself, derived from our own
// jobs and receipts; this is the far side's self-reported backlog, in
// whichever unit the far side chose. Sitting it beside them would invite
// reading it as one more slice of the same total, and it is not the same
// total.
//
// One Count PER UNIT, never one merged number. `pendingWork.unit` is
// jobs | captures | posts (schema.ts pendingWorkUnitValidator) and two
// accounts in one summary can report different units, so a single figure
// would have to add captures (files) to posts and then label the result
// something — exactly the "count of files labelled as a count of posts" that
// docs/publication-contract.md "What 'unique' means" and to-do.md forbid.
// Split per unit, every number keeps the label it was reported under.
//
// A unit is "known" only when at least one in-scope account actually
// reported pendingWork in that unit. An account whose publication row has no
// pendingWork has told us nothing — convex/publication.ts is explicit that an
// update omitting the field means "this update has nothing to say about
// outstanding work", not "there is none" — so silence reads "unknown", never
// 0. A known 0 here means an account did report, in that unit, that nothing
// is left.
export const providerQueuedWorkValidator = v.object({
  posts: countValidator,
  captures: countValidator,
  jobs: countValidator,
});

export type ProviderQueuedWork = Infer<typeof providerQueuedWorkValidator>;

export const dashboardSummaryValidator = v.object({
  // unit "posts" — sum of accountPublications.searchablePostCount across the
  // scope below. NEVER a sum of jobs.count (accepted raw records) or
  // jobs.postsReceived (per-page download counter). "unknown" when any
  // in-scope account's own count is unknown, unless the implementation can
  // state a true partial sum plus which accounts are excluded — see
  // docs/publication-contract.md "what unique means".
  indexedPosts: countValidator,
  // unit "accounts" — distinct in-scope accounts with
  // accountPublications.state === "searchable". With `scope.kind === "global"`
  // this is drawn from exactly the same account set as the account-library
  // rows it links to, so the number and the list below it agree by
  // construction rather than by coincidence.
  indexedAccounts: countValidator,
  queue: queueBreakdownValidator,
  // The indexer's own outstanding work for the in-scope accounts, one
  // Count per unit it can report in. See providerQueuedWorkValidator above
  // for why this is three separate counts rather than one total, and why a
  // unit nobody reported is "unknown" rather than 0.
  providerQueuedWork: providerQueuedWorkValidator,
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
//
// No "continue" kind: acquisition never waits on a person to ask for the
// next page. `convex/jobs.ts` `finish` requeues a job with more to fetch on
// its own (bulk history via `nextUntil`, every other kind via `nextCursor`)
// and backs off and requeues a transient failure on its own too — "wait"
// already covers a queued job with a future `readyAt`, whichever of those it
// is.
export const nextActionValidator = v.union(
  v.object({ kind: v.literal("retry"), jobId: v.id("jobs") }),
  v.object({ kind: v.literal("wait"), jobId: v.id("jobs"), readyAt: v.number() }),
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
      // Copied straight from the job doc, same as convex/library.ts
      // `history`'s per-run rows: how much history this run downloaded and
      // whether it hit the provider's own floor, so a caller can say
      // "3,155 posts back to 2026-07-11 · x.md has no older history"
      // instead of a bare status word.
      postsReceived: v.optional(v.number()),
      oldest: v.optional(v.string()),
      floorReached: v.optional(v.boolean()),
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
