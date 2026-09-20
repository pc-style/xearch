import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

/**
 * The one place this app decides which `accounts` row something refers to.
 *
 * It used to be three places. `convex/jobs.ts` resolved identity when writing
 * a profile, `convex/library.ts` when grouping an owner's runs into rows, and
 * `convex/summary.ts` when totalling them — each with its own copy of the
 * rules and its own cache. The copies were required to agree (the "Indexed
 * people" tile is meant to be exactly the length of the list it links to) and
 * nothing but a comment made them. Convex has no unique indexes, so the rules
 * cannot be pushed into the schema; a single entry point is the honest fix.
 *
 * Two rules, and the difference between them is the whole point:
 *
 *   - A PROVIDER ACCOUNT ID is the identity. Several rows carrying the same
 *     id are duplicates of one account, so they resolve to one canonical row.
 *   - A HANDLE is not an identity. It can be released on X and claimed by
 *     someone else, so two rows sharing one handle really can be two
 *     different people, and that resolves to nothing rather than a guess.
 *     Guessing is how one person's posts end up under another person's name.
 */

/** Only a full account-history import establishes an account identity. */
export const ACCOUNT_JOB_KIND = "bulk" as const;

type Db = QueryCtx["db"];

/**
 * The canonical row for one provider account id: the oldest.
 *
 * Convex appends `_creationTime` as the final column of every index and
 * ascending order is the default, so `.first()` already returns the oldest
 * matching row — see convex/_generated/ai/guidelines.md ("Rely on this
 * built-in tiebreak instead of re-sorting results in JavaScript"). Stable
 * across calls and independent of read order, which is what lets the write
 * path and every read path land on the same row.
 */
export function canonicalAccountForUserId(
  db: Db,
  userId: string,
): Promise<Doc<"accounts"> | null> {
  return db
    .query("accounts")
    .withIndex("by_user_id", (q) => q.eq("userId", userId))
    .first();
}

/**
 * Resolve an account from a provider id when one is known, falling back to
 * the handle only when no id has ever been pinned. Deliberately does NOT fall
 * back from a non-matching id to a handle match: once an id is asserted,
 * honouring a handle instead is exactly the reassignment merge this module
 * exists to prevent.
 */
export async function resolveAccount(
  db: Db,
  identity: { providerAccountId?: string; handle: string },
): Promise<Doc<"accounts"> | null> {
  if (identity.providerAccountId !== undefined)
    return canonicalAccountForUserId(db, identity.providerAccountId);
  // `.take(2)` rather than `.unique()`: two rows sharing a handle is a
  // legitimate state after a reassignment, and `.unique()` throws on it
  // instead of returning. Two matches is unresolvable, not "pick one".
  const matches = await db
    .query("accounts")
    .withIndex("by_handle", (q) => q.eq("handle", identity.handle))
    .take(2);
  return matches.length === 1 ? matches[0] : null;
}

/** The identity a job asserts: its pinned provider id, else its raw input. */
export function jobIdentity(job: Doc<"jobs">): { providerAccountId?: string; handle: string } {
  return { providerAccountId: job.expectedUserId, handle: job.input };
}

/**
 * `resolveAccount` for a job, memoised across a single query. Keyed on the
 * identity actually used, so a job with a pinned id and a job with only a
 * handle never share an entry.
 */
export async function resolveJobAccount(
  db: Db,
  job: Doc<"jobs">,
  cache: Map<string, Doc<"accounts"> | null>,
): Promise<Doc<"accounts"> | null> {
  const identity = jobIdentity(job);
  const key =
    identity.providerAccountId !== undefined
      ? `id:${identity.providerAccountId}`
      : `handle:${identity.handle}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const found = await resolveAccount(db, identity);
  cache.set(key, found);
  return found;
}

// Bounded read. One person's own account imports, newest first — the set both
// the account library and the owner-scoped totals are built from. Shared so
// the index, the kind filter, the order and the bound are one decision rather
// than two that a comment asks you to keep equal.
export const MAX_OWNED_ACCOUNT_JOBS = 500;

/**
 * This owner's account-history jobs, plus whether there were more than the
 * bound allows. `truncated` exists so a caller can say "unknown" instead of
 * presenting the part it managed to read as a complete total.
 */
export async function ownedAccountJobs(
  db: Db,
  owner: Id<"users">,
): Promise<{ jobs: Doc<"jobs">[]; truncated: boolean }> {
  // Indexed on kind rather than `.filter()`ed: a filter is applied after the
  // index scan and does not reduce documents read, so filtering here would
  // read every job this owner has ever run — including thousands of live
  // searches — to find the account imports among them.
  const scanned = await db
    .query("jobs")
    .withIndex("by_owner_and_kind", (q) => q.eq("owner", owner).eq("kind", ACCOUNT_JOB_KIND))
    .order("desc")
    .take(MAX_OWNED_ACCOUNT_JOBS + 1);
  const truncated = scanned.length > MAX_OWNED_ACCOUNT_JOBS;
  return { jobs: truncated ? scanned.slice(0, MAX_OWNED_ACCOUNT_JOBS) : scanned, truncated };
}

// How far a targeted lookup will walk an owner's account imports, and how
// many matching runs it will keep. Both are bounds on work, and reaching
// either one means the answer is incomplete — which the caller is told,
// rather than left to mistake for a finished search.
const MAX_OWNERSHIP_SCAN = 20_000;
const MAX_ACCOUNT_RUNS = 1_000;

/**
 * Every job this owner ran for ONE account, newest first, plus whether the
 * search actually finished.
 *
 * Deliberately not derived from the bounded library page: an owner with more
 * imports than that page holds would be told "not found" for an account they
 * genuinely own, losing its run history and its dismissal evidence.
 *
 * `exhausted` is the honest part. These bounds exist so one request cannot
 * read unboundedly, but hitting one does NOT mean the account is absent — it
 * means we stopped looking. A caller must not turn that into "not found".
 *
 * No early exit once enough runs are found, either: this index orders by
 * `_creationTime`, while history is presented newest-by-`updatedAt`. Stopping
 * at the first N matches could drop a job created earlier and updated since.
 * Every match inside the scanned window is collected, so the ordering the
 * caller applies is exact over that window.
 */
export async function ownerJobsForAccount(
  db: Db,
  owner: Id<"users">,
  accountId: Id<"accounts">,
): Promise<{ jobs: Doc<"jobs">[]; exhausted: boolean }> {
  const cache = new Map<string, Doc<"accounts"> | null>();
  const jobs: Doc<"jobs">[] = [];
  let scanned = 0;
  for await (const job of db
    .query("jobs")
    .withIndex("by_owner_and_kind", (q) => q.eq("owner", owner).eq("kind", ACCOUNT_JOB_KIND))
    .order("desc")) {
    if (++scanned > MAX_OWNERSHIP_SCAN) return { jobs, exhausted: false };
    const account = await resolveJobAccount(db, job, cache);
    if (account?._id !== accountId) continue;
    jobs.push(job);
    if (jobs.length >= MAX_ACCOUNT_RUNS) return { jobs, exhausted: false };
  }
  return { jobs, exhausted: true };
}
