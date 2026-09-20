import { v, type Infer } from "convex/values";
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { user } from "./access";
import { throttleProviderValidator } from "./schema";

/**
 * Provider-limit facts for the dashboard (to-do.md P0 "Provider limits").
 * Built strictly from `providerThrottleEvents` (convex/schema.ts) — the only
 * place a live, provider-reported throttle fact is recorded. This file must
 * never read `jobs.error`: that column is free text and can hold a stale
 * historical message (for example a pre-PR#12 "Paused at today's import
 * limit. Your downloaded posts are safe. Try again tomorrow." string left on
 * an old job row) that is indistinguishable from a live message by content
 * alone. See docs/publication-contract.md "Provider throttle facts".
 *
 * This app has no application-side quota of its own left to report: the
 * daily/global import caps (the `budgets` table and `budget()`/`budgets()`
 * helpers) were removed in PR #12 (merge commit e6bfb61, "remove
 * self-imposed rate limits") — verified absent from this tree before writing
 * this file (`grep -rn "budget" convex/` returns no matches). Every limit
 * this file can ever report is one the provider itself supplied; nothing
 * here reintroduces a self-imposed cap.
 *
 * Nothing writes to `providerThrottleEvents` yet — that is acquisition-side
 * implementation (convex/importer.ts / convex/lib/xmd.ts), out of scope for
 * this file per docs/publication-contract.md ("This table only records
 * observations; nothing in this task adds the code that writes to it").
 * Until something does, every query below honestly returns `{ kind: "none" }`
 * for every provider.
 *
 * Scope note — to-do.md P0 "Provider limits" is four separate bullets. This
 * file, by itself, closes exactly one of them:
 *   - CLOSED: "Expose safe summary data through authenticated backend
 *     contracts." `current`/`all` are auth-gated via `user(ctx)` and return
 *     only derived provider-limit facts (never a raw state file, credential,
 *     or another user's data).
 *   - NOT CLOSED: "show provider-reported throttling, remaining allowance
 *     ..., the affected operation, and the next retry time." This is a
 *     dashboard requirement and nothing in `src/` calls `limits.current` or
 *     `limits.all` yet (verified this session:
 *     `rg -n "limits\.(current|all)|api\.limits" src/` — no matches). Until a
 *     panel (e.g. in src/library/OverviewStats.tsx) consumes these queries,
 *     no user can see this data.
 *   - NOT CLOSED: "Respect provider Retry-After/retryAfter." `nextRetryAt`
 *     is computed correctly from `retryAfterMs` when a row has one, but no
 *     row is ever written in production yet (see the paragraph above), so
 *     this is only true of hypothetical rows a test inserts, not of running
 *     code. Closing it needs the write path in convex/importer.ts /
 *     convex/lib/xmd.ts, which is out of scope for this file.
 *   - NOT CLOSED (only trivially, today): "Separate current provider
 *     throttling from historical 'today's import limit' errors." True right
 *     now only because nothing is ever shown (empty table). Once the write
 *     path above exists, add a test that exercises this against data the
 *     acquisition path actually produced, not only synthetic rows a test
 *     inserts directly.
 * Do not report this file as closing the other three bullets until the
 * dashboard wiring and the write path above both exist and are tested
 * end-to-end.
 */

// Bounded read (Convex query guidelines: no unbounded `.collect()`).
// `providerThrottleEvents` has no index on `observedAt` (adding one is a
// schema change, out of scope for this file), so `by_provider` ordered
// desc by the index's trailing `_creationTime` gives a bounded candidate
// window; picking the max by `observedAt` within it — rather than trusting
// insertion order — is what actually honors "the most recent row by
// observedAt" (docs/publication-contract.md) when events are ever recorded
// slightly out of order.
const RECENT_WINDOW = 20;

// Every provider this app can be throttled by. Kept as a plain array here
// (rather than deriving it from throttleProviderValidator's internal shape)
// so this file does not reach into convex/values internals to enumerate a
// union — schema.ts is the single source of truth for which providers exist.
const PROVIDERS = ["xmd", "receiver", "search"] as const;

// "known" only when the provider's own response actually carried a
// remaining-allowance figure (providerThrottleEvents.remaining is optional
// and left unset otherwise) — never estimated, defaulted, or backfilled.
// Deliberately its own shape rather than reusing lib/contracts.ts's
// `countValidator`: that validator's `unit` is one of
// "jobs" | "captures" | "posts" | "accounts", none of which honestly
// describes a provider's remaining rate-limit allowance, so forcing it
// through that shape would misrepresent what is being counted.
export const remainingAllowanceValidator = v.union(
  v.object({ kind: v.literal("known"), value: v.number() }),
  v.object({ kind: v.literal("unknown") }),
);
export type RemainingAllowance = Infer<typeof remainingAllowanceValidator>;

export const providerLimitValidator = v.union(
  v.object({
    kind: v.literal("throttled"),
    provider: throttleProviderValidator,
    // The specific call this throttle was observed on (e.g. "history",
    // "bulk"), verbatim from the observation — never invented.
    operation: v.string(),
    // The provider's own reason text, verbatim — never reworded.
    reason: v.string(),
    remaining: remainingAllowanceValidator,
    // Epoch ms the provider said its allowance window resets, when supplied.
    resetAt: v.optional(v.number()),
    // Epoch ms this app should not retry the affected operation before,
    // derived only from the provider's own retryAfterMs (see
    // convex/lib/xmd.ts retryDelay, the source of that field) — never
    // invented when the provider did not supply one.
    nextRetryAt: v.optional(v.number()),
    // When this was observed. Lets a caller judge staleness for itself;
    // this file never editorializes about that — it reports the most
    // recent fact, honestly timestamped.
    observedAt: v.number(),
  }),
  // No provider throttle has ever been observed for this provider. This is
  // the only response when nothing is currently known — never a guessed
  // "not throttled" claim manufactured from the absence of a jobs.error
  // string, and never an old jobs.error surfaced as a substitute.
  v.object({ kind: v.literal("none"), provider: throttleProviderValidator }),
);
export type ProviderLimit = Infer<typeof providerLimitValidator>;

async function loadProviderLimit(
  ctx: QueryCtx,
  provider: (typeof PROVIDERS)[number],
): Promise<ProviderLimit> {
  const recent = await ctx.db
    .query("providerThrottleEvents")
    .withIndex("by_provider", (q) => q.eq("provider", provider))
    .order("desc")
    .take(RECENT_WINDOW);
  if (recent.length === 0) return { kind: "none", provider };
  const latest = recent.reduce((a, b) => (b.observedAt > a.observedAt ? b : a));
  return {
    kind: "throttled",
    provider: latest.provider,
    operation: latest.operation,
    reason: latest.reason,
    remaining:
      latest.remaining !== undefined
        ? { kind: "known", value: latest.remaining }
        : { kind: "unknown" },
    resetAt: latest.resetAt,
    nextRetryAt:
      latest.retryAfterMs !== undefined ? latest.observedAt + latest.retryAfterMs : undefined,
    observedAt: latest.observedAt,
  };
}

// The current throttle status for one provider. Requires a signed-in user
// (to-do.md P0 "Expose safe summary data through authenticated backend
// contracts") even though the fact itself is not per-user: it is an
// observed, shared fact about this app's own calls to that provider, not
// another user's data, but it still only goes to an authenticated caller.
export const current = query({
  args: { provider: throttleProviderValidator },
  returns: providerLimitValidator,
  handler: async (ctx, { provider }) => {
    await user(ctx);
    return loadProviderLimit(ctx, provider);
  },
});

// The current throttle status for every provider this app calls, in one
// round trip — the shape a dashboard's "Provider limits" panel actually
// needs, without guessing which providers matter.
export const all = query({
  args: {},
  returns: v.array(providerLimitValidator),
  handler: async (ctx): Promise<ProviderLimit[]> => {
    await user(ctx);
    const out: ProviderLimit[] = [];
    for (const provider of PROVIDERS) out.push(await loadProviderLimit(ctx, provider));
    return out;
  },
});
