import { v, ConvexError, type Infer } from "convex/values";
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { user } from "./access";
import { publicationStateValidator, jobStatusValidator } from "./schema";
import {
  accountLibraryRowValidator,
  type AccountLibraryRow,
  type NextAction,
} from "./lib/contracts";
import {
  accountPublicationCandidates,
  allAccountJobs,
  currentPublication,
  jobsForAccount,
  resolveJobAccount,
} from "./lib/accounts";

/**
 * The account-library query that replaces the job wall (to-do.md P0
 * "Replace the job wall with an account library"). One row per resolved
 * account identity, built strictly from accountPublications (never summed
 * job/receipt counters) plus that account's own acquisition jobs. Full
 * semantics: docs/publication-contract.md.
 *
 * The imported corpus is shared infrastructure, not personal data: every
 * signed-in caller sees the same rows, built from account-history jobs
 * across every owner, not just their own. `jobs.owner` still records who
 * started each run (an audit trail); it is no longer a visibility boundary
 * here. Saved searches, bookmarks, sessions, and email deliveries remain
 * per-owner and are untouched by this file.
 */
// Bounded reads for one account's expandable history (Convex query
// guidelines: no unbounded .collect()). Generous relative to how many runs
// people work through by hand.
const MAX_HISTORY_JOBS = 50;

const MAX_HISTORY_RECEIPTS = 100;

type AccountBucket = { account: Doc<"accounts">; jobs: Doc<"jobs">[] };

// Group every bulk job in the shared corpus by resolved account. A job whose
// identity cannot be resolved to an existing account row is dropped, not
// shown as a row of its own: this app never creates an account row from
// anything but a successful acquisition profile pin (convex/jobs.ts finish),
// so an unresolved first-ever run belongs to the queue, not the library —
// see docs/publication-contract.md "Account identity".
async function groupJobsByAccount(
  ctx: QueryCtx,
): Promise<{ byAccount: Map<Id<"accounts">, AccountBucket>; truncated: boolean }> {
  const { jobs, truncated } = await allAccountJobs(ctx.db);
  const identityCache = new Map<string, Doc<"accounts"> | null>();
  const byAccount = new Map<Id<"accounts">, AccountBucket>();

  for (const job of jobs) {
    const account = await resolveJobAccount(ctx.db, job, identityCache);

    if (!account) continue;
    const bucket = byAccount.get(account._id);

    if (bucket) bucket.jobs.push(job);
    else byAccount.set(account._id, { account, jobs: [job] });
  }

  return { byAccount, truncated };
}

function latestOf(jobs: Doc<"jobs">[]): Doc<"jobs"> {
  return jobs.reduce((latest, job) => (job.updatedAt > latest.updatedAt ? job : latest));
}

// The single most relevant next action for one account's latest run.
// Publication state (searchable/failed/etc.) never factors in here — a
// failed *publication* update and a failed *acquisition* job are different
// things (docs/publication-contract.md), and this app has no receiver for
// the former yet; this only reasons about the job's own acquisition status.
//
// There is no "continue" action: acquisition never waits on a person to ask
// for the next page or the next retry — convex/jobs.ts `finish` requeues a
// job with more to fetch (bulk history via `nextUntil`, every other kind via
// `nextCursor`) and backs off and requeues a transient failure on its own.
// A "queued" job with a `readyAt` is either of those in flight, which is
// exactly what "wait" reports. Whether that time has already passed is the
// client's call against its own clock: a query only re-runs when a document
// it read changes, never because wall-clock time moved, so comparing here
// would leave a row saying "retrying at 10:05" long after 10:05.
function nextActionFor(job: Doc<"jobs">): NextAction {
  if (job.status === "failed" || job.status === "partial" || job.status === "cancelled")
    return { kind: "retry", jobId: job._id };

  if (job.status === "queued" && job.readyAt !== undefined)
    return { kind: "wait", jobId: job._id, readyAt: job.readyAt };

  return { kind: "none" };
}

export const rows = query({
  args: {
    search: v.optional(v.string()),
    status: v.optional(publicationStateValidator),
  },
  returns: v.object({
    rows: v.array(accountLibraryRowValidator),
    // True when the shared corpus has more account imports than one bounded
    // read covers, so `rows` is a page rather than the whole library.
    // Returned rather than hidden: a list silently missing its oldest
    // accounts looks identical to a complete one, and the counts beside it
    // are derived from the same bound.
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    // Authenticated callers only; every signed-in caller sees the same
    // shared corpus, so nothing about the identity narrows what comes back.
    await user(ctx);
    const { byAccount, truncated } = await groupJobsByAccount(ctx);
    const search = args.search?.trim().toLowerCase();

    // The search filter doesn't depend on publication state, so it is
    // applied first to shrink which accounts need a publication lookup at
    // all. What remains is then fetched CONCURRENTLY — one indexed lookup
    // per account is unavoidable without a join Convex doesn't offer, but
    // issuing them all at once turns N sequential round trips into a single
    // batch instead of a query-per-row loop.
    const candidates = [...byAccount.entries()].filter(
      ([, { account }]) =>
        !search ||
        account.handle.toLowerCase().includes(search) ||
        account.name.toLowerCase().includes(search),
    );

    // Not `.unique()`: `by_account` is not uniqueness-enforced by the
    // schema — a second row for one account would make `.unique()` throw,
    // and because these lookups run inside `Promise.all`, that one throw
    // would fail the whole `rows` query and show no rows at all (CodeRabbit
    // #4089340887). Not a bare `.first()` either: that picks whichever row
    // Convex's default `_creationTime` order puts first, which can be a
    // stale duplicate rather than the row `currentPublication` actually
    // identifies as current (CodeRabbit #4089916545).
    const publications = await Promise.all(
      candidates.map(([accountId]) =>
        accountPublicationCandidates(ctx.db, accountId).then(currentPublication),
      ),
    );

    const out: AccountLibraryRow[] = [];

    for (let i = 0; i < candidates.length; i++) {
      const [accountId, { account, jobs }] = candidates[i];
      const publication = publications[i];

      // No publication row yet means no publication update has ever arrived
      // for this account; docs/publication-contract.md collapses "downloaded"
      // and "waiting_for_indexing" into the same instant once acquisition has
      // a durable receipt, and every account row here came from at least one
      // successful acquisition (see groupJobsByAccount), so
      // "waiting_for_indexing" is the honest default.
      const publicationState = publication?.state ?? "waiting_for_indexing";

      if (args.status && args.status !== publicationState) continue;
      // Dismissed runs stay in `jobs` (and in this account's expandable
      // history, which is the evidence trail) but must not be what the row
      // reports as its latest activity or base its next action on —
      // otherwise clearing a failure would leave the row still advertising
      // it. An account whose every run has been dismissed keeps its row and
      // its published counts, and simply reports no latest run.
      const visible = jobs.filter((job) => job.dismissedAt === undefined);
      const latestJob = visible.length > 0 ? latestOf(visible) : undefined;
      out.push({
        accountId,
        handle: account.handle,
        name: account.name,
        avatar: account.avatar,
        publicationState,
        // NEVER derived from jobs.count / jobs.postsReceived / receipts — see
        // docs/publication-contract.md "What unique means". "unknown" (not
        // 0) whenever no accepted "searchable" update has ever set this.
        searchablePostCount:
          publication?.searchablePostCount !== undefined
            ? { kind: "known", unit: "posts", value: publication.searchablePostCount }
            : { kind: "unknown", unit: "posts" },
        searchablePostCountAsOf: publication?.searchablePostCountAsOf,
        lastPublishedAt: publication?.lastPublishedAt,
        // accountPublications.lastError also carries `generation` (for
        // correlating with publicationUpdates); the row's shape is narrower
        // by design (accountLibraryRowValidator), so only message/observedAt
        // cross into it.
        lastError: publication?.lastError
          ? { message: publication.lastError.message, observedAt: publication.lastError.observedAt }
          : undefined,
        latestJob: latestJob && {
          jobId: latestJob._id,
          status: latestJob.status,
          phase: latestJob.phase,
          updatedAt: latestJob.updatedAt,
          postsReceived: latestJob.postsReceived,
          oldest: latestJob.oldest,
          floorReached: latestJob.floorReached,
          origin: latestJob.origin,
          discoveredFrom: latestJob.discoveredFrom,
        },
        nextAction: latestJob ? nextActionFor(latestJob) : { kind: "none" },
      });
    }

    out.sort((a, b) => (b.latestJob?.updatedAt ?? 0) - (a.latestJob?.updatedAt ?? 0));

    return { rows: out, truncated };
  },
});

// Expandable per-account history: every run (retry, batch, older attempt)
// with its receipts, newest first. Nothing is deleted or collapsed to hide
// duplicates (to-do.md P0) — this is exactly the raw evidence the account
// library row above summarizes.
const historyRunValidator = v.object({
  jobId: v.id("jobs"),
  status: jobStatusValidator,
  phase: v.optional(v.string()),
  error: v.optional(v.string()),
  count: v.number(),
  postsReceived: v.optional(v.number()),
  // How far back this run's downloaded history reaches, and whether it hit
  // the provider's own floor — copied straight from the job doc so the UI
  // can say "3,155 posts back to 2026-07-11 · x.md has no older history"
  // instead of a bare status word.
  oldest: v.optional(v.string()),
  floorReached: v.optional(v.boolean()),
  attempt: v.number(),
  updatedAt: v.number(),
  // Set when the owner dismissed this run from their feeds. History still
  // lists it — dismissing hides a run, it never deletes the evidence — so
  // the UI can mark it and offer to restore it.
  dismissedAt: v.optional(v.number()),
  receipts: v.array(
    v.object({
      captureId: v.string(),
      receiptId: v.string(),
      records: v.number(),
    }),
  ),
});

export type HistoryRun = Infer<typeof historyRunValidator>;

export const history = query({
  args: { accountId: v.id("accounts") },
  returns: v.array(historyRunValidator),
  handler: async (ctx, args) => {
    // Authenticated callers only; the account's history is shared corpus
    // evidence, not this caller's own.
    await user(ctx);
    // A targeted lookup, NOT the bounded library page. Deriving this from the
    // page meant a caller reaching past its bound was told "not found" for
    // an account that genuinely exists, and lost both its run history and
    // the evidence behind a dismissed run.
    const { jobs, exhausted } = await jobsForAccount(ctx.db, args.accountId);

    // Checked BEFORE looking at what was found, not only when nothing was.
    // An incomplete scan that happened to find some runs is still incomplete:
    // the scan walks _creationTime order while this list is presented by
    // updatedAt, so a run it never reached can belong in the newest fifty.
    // Returning those anyway would present a partial scan as the account's
    // history, which is the same lie as presenting a partial count as a
    // total.
    if (!exhausted)
      throw new ConvexError(
        "Could not read this account's full history — there are too many imports to search in one request.",
      );

    // Same message whether the account does not exist or has no jobs yet —
    // never confirm state beyond what the corpus actually shows.
    if (jobs.length === 0) throw new ConvexError("Account not found.");
    // Exact over the scanned window: every match was collected before
    // sorting, so ordering by updatedAt cannot drop a job that the index's
    // own _creationTime order happened to place later.
    const sorted = [...jobs].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_HISTORY_JOBS);

    // One receipts query per displayed run is unavoidable (receipts are
    // indexed by jobId, and the caller needs each run's actual receipts, not
    // a count), but issuing all of them CONCURRENTLY rather than one run at
    // a time turns up to MAX_HISTORY_JOBS sequential round trips into one
    // batch.
    const receiptsByJob = await Promise.all(
      sorted.map((job) =>
        ctx.db
          .query("receipts")
          .withIndex("by_capture", (q) => q.eq("jobId", job._id))
          .take(MAX_HISTORY_RECEIPTS),
      ),
    );

    return sorted.map((job, i) => ({
      jobId: job._id,
      status: job.status,
      phase: job.phase,
      error: job.error,
      count: job.count,
      postsReceived: job.postsReceived,
      oldest: job.oldest,
      floorReached: job.floorReached,
      attempt: job.attempt,
      updatedAt: job.updatedAt,
      dismissedAt: job.dismissedAt,
      receipts: receiptsByJob[i].map((r) => ({
        captureId: r.captureId,
        receiptId: r.receiptId,
        records: r.records,
      })),
    }));
  },
});
