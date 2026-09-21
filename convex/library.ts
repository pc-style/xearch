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
import { ownedAccountJobs, ownerJobsForAccount, resolveJobAccount } from "./lib/accounts";

/**
 * The account-library query that replaces the job wall (to-do.md P0
 * "Replace the job wall with an account library"). One row per resolved
 * account identity, built strictly from accountPublications (never summed
 * job/receipt counters) plus that account's own acquisition jobs. Full
 * semantics: docs/publication-contract.md.
 */
// Bounded reads for one account's expandable history (Convex query
// guidelines: no unbounded .collect()). Generous relative to how many runs
// one person works through by hand.
const MAX_HISTORY_JOBS = 50;
const MAX_HISTORY_RECEIPTS = 100;

type AccountBucket = { account: Doc<"accounts">; jobs: Doc<"jobs">[] };

// Group this owner's bulk jobs by resolved account. A job whose identity
// cannot be resolved to an existing account row is dropped, not shown as a
// row of its own: this app never creates an account row from anything but a
// successful acquisition profile pin (convex/jobs.ts finish), so an
// unresolved first-ever run belongs to the queue, not the library — see
// docs/publication-contract.md "Account identity".
async function groupOwnedJobsByAccount(
  ctx: QueryCtx,
  owner: Id<"users">,
): Promise<{ byAccount: Map<Id<"accounts">, AccountBucket>; truncated: boolean }> {
  const { jobs, truncated } = await ownedAccountJobs(ctx.db, owner);
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
function nextActionFor(job: Doc<"jobs">): NextAction {
  if (job.status === "failed" || job.status === "partial" || job.status === "cancelled")
    return { kind: "retry", jobId: job._id };
  if (job.status === "queued" && job.readyAt !== undefined && job.readyAt > Date.now())
    return { kind: "wait", jobId: job._id, readyAt: job.readyAt };
  if (job.status === "complete" && (job.nextUntil !== undefined || job.nextCursor !== undefined))
    return { kind: "continue", jobId: job._id };
  return { kind: "none" };
}

export const rows = query({
  args: {
    search: v.optional(v.string()),
    status: v.optional(publicationStateValidator),
  },
  returns: v.object({
    rows: v.array(accountLibraryRowValidator),
    // True when this owner has more account imports than one bounded read
    // covers, so `rows` is a page rather than their whole library. Returned
    // rather than hidden: a list silently missing its oldest accounts looks
    // identical to a complete one, and the counts beside it are derived from
    // the same bound.
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const owner = await user(ctx);
    const { byAccount, truncated } = await groupOwnedJobsByAccount(ctx, owner);
    const search = args.search?.trim().toLowerCase();
    const out: AccountLibraryRow[] = [];
    for (const [accountId, { account, jobs }] of byAccount) {
      if (
        search &&
        !account.handle.toLowerCase().includes(search) &&
        !account.name.toLowerCase().includes(search)
      )
        continue;
      const publication = await ctx.db
        .query("accountPublications")
        .withIndex("by_account", (q) => q.eq("accountId", accountId))
        .unique();
      // No publication row yet means no publication update has ever arrived
      // for this account; docs/publication-contract.md collapses "downloaded"
      // and "waiting_for_indexing" into the same instant once acquisition has
      // a durable receipt, and every account row here came from at least one
      // successful acquisition (see groupOwnedJobsByAccount), so
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
    const owner = await user(ctx);
    // A targeted ownership lookup, NOT the bounded library page. Deriving
    // this from the page meant an owner with more imports than it holds was
    // told "not found" for an account they genuinely own, and lost both its
    // run history and the evidence behind a dismissed run.
    const { jobs, exhausted } = await ownerJobsForAccount(ctx.db, owner, args.accountId);
    // Checked BEFORE looking at what was found, not only when nothing was.
    // An incomplete scan that happened to find some runs is still incomplete:
    // the scan walks _creationTime order while this list is presented by
    // updatedAt, so a run it never reached can belong in the newest fifty.
    // Returning those anyway would present a partial scan as the account's
    // history, which is the same lie as presenting a partial count as a
    // total.
    if (!exhausted)
      throw new ConvexError(
        "Could not read this account's full history — you have too many imports to search in one request.",
      );
    // Same message whether the account does not exist or simply is not this
    // owner's — never confirm another user's account exists.
    if (jobs.length === 0) throw new ConvexError("Account not found.");
    // Exact over the scanned window: every match was collected before
    // sorting, so ordering by updatedAt cannot drop a job that the index's
    // own _creationTime order happened to place later.
    const sorted = [...jobs].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_HISTORY_JOBS);
    const out: Infer<typeof historyRunValidator>[] = [];
    for (const job of sorted) {
      const receipts = await ctx.db
        .query("receipts")
        .withIndex("by_capture", (q) => q.eq("jobId", job._id))
        .take(MAX_HISTORY_RECEIPTS);
      out.push({
        jobId: job._id,
        status: job.status,
        phase: job.phase,
        error: job.error,
        count: job.count,
        postsReceived: job.postsReceived,
        attempt: job.attempt,
        updatedAt: job.updatedAt,
        dismissedAt: job.dismissedAt,
        receipts: receipts.map((r) => ({
          captureId: r.captureId,
          receiptId: r.receiptId,
          records: r.records,
        })),
      });
    }
    return out;
  },
});
