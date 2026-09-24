import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { upsertAccount } from "./jobs";
import { canonicalAccountForUserId } from "./lib/accounts";

/**
 * Rebuild `accounts` from profiles that were collected but never delivered.
 *
 * An account row is only ever written by `jobs.report` when the worker sends
 * a profile alongside a finished page. Between 2026-09-19 and 2026-09-21 the
 * VM worker ran a build that destructured the profile away before reporting
 * (fixed in #28, but the running checkout was two days stale), so production
 * finished twenty-six account imports and wrote zero account rows. Without
 * them `library.ts` resolves no account for any job and drops every one, so
 * the account library was empty and the UI fell back to a raw job log.
 *
 * The profiles were never lost — they are in the retained raw captures on
 * the collecting machine. `scripts/backfill-accounts.mjs` reads them back
 * out and calls this. Nothing here contacts a provider or spends anything.
 *
 * Idempotent, because it is `upsertAccount` — the same function the live
 * path uses, deliberately not a second copy of the identity rules. A
 * reassigned handle forks a row here exactly as it would in production.
 */
export const accountsFromProfiles = internalMutation({
  args: {
    profiles: v.array(
      v.object({
        handle: v.string(),
        userId: v.string(),
        name: v.string(),
        avatar: v.optional(v.string()),
      }),
    ),
  },
  returns: v.object({
    created: v.number(),
    existing: v.number(),
  }),
  handler: async (ctx, { profiles }) => {
    let created = 0;
    let existing = 0;

    for (const profile of profiles) {
      // Asked before the write so the caller learns what actually happened:
      // upsertAccount returns the same id whether it inserted or patched.
      if (await canonicalAccountForUserId(ctx.db, profile.userId)) existing++;
      else created++;
      await upsertAccount(ctx, profile);
    }

    return { created, existing };
  },
});
