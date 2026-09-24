import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internalQuery, query } from "./_generated/server";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx, MutationCtx, ActionCtx } from "./_generated/server";

// `getAuthUserId` only ever reads `ctx.auth` (see @convex-dev/auth/server's
// own signature, `ctx: { auth: Auth }`), so this accepts every context kind
// that has one — including ActionCtx — rather than narrowing to
// QueryCtx | MutationCtx and forcing every action-side caller (like
// `requireOperator` below) to cast its way past a restriction the callee
// itself doesn't have.
export async function user(ctx: QueryCtx | MutationCtx | ActionCtx) {
  const id = await getAuthUserId(ctx);

  if (!id) throw new ConvexError("Start a session to use your workspace.");

  return id;
}

/**
 * Provider-spending/operator authorization boundary (decided per the
 * "Authorization boundary for provider-spending actions" item).
 *
 * Ordinary search stays public. Starting or retrying an import
 * (`jobs.start`/`jobs.retry`, any kind), reading web context/linked pages
 * and "Help me search" (the `integrations.*` actions that call Firecrawl/
 * x.md/OpenAI), and cancel/dismiss/restore on jobs must come from a signed-
 * in OPERATOR, not merely a signed-in (possibly anonymous) session.
 *
 * The mechanism is entirely stock: the existing Email OTP provider
 * (convex/auth.ts, src/auth/EmailSignIn.tsx) already gives every caller a
 * verified email once they sign in with a code. `requireOperator` accepts
 * exactly the identities whose verified email is listed in the
 * `OPERATOR_EMAILS` env var (comma-separated, case-insensitive). An
 * anonymous session has no email at all and is refused; a verified email
 * not on the list is refused with the same message so the list itself is
 * never confirmed or denied to the caller.
 *
 * This is authorization, not a quota: nothing here counts or throttles
 * requests (AGENTS.md "Rate limiting" forbids adding one), it only decides
 * who may ask at all.
 */
function operatorEmails(env: Record<string, string | undefined> = process.env): Set<string> {
  return new Set(
    (env.OPERATOR_EMAILS ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

// The `users` row is the authoritative record of whether an email is
// verified (`emailVerificationTime`, set by convex/auth.ts's Email OTP
// provider only once a code is confirmed — see convex/email.ts `send` for
// the same pattern). `ctx.auth.getUserIdentity().email` is NOT a safe
// substitute: `UserIdentity.email` is an optional JWT claim whose presence
// and meaning depend entirely on the identity provider's configuration, and
// nothing ties it to `emailVerificationTime` — reading it directly for an
// authorization decision is exactly CWE-863 (Incorrect Authorization: an
// access-control decision based on the wrong/unverified data). Actions
// don't have `ctx.db`, so they reach the same row through an internal query
// instead.
export const operatorAccount = internalQuery({
  args: { id: v.id("users") },
  returns: v.union(v.null(), schema.doc("users")),
  handler: (ctx, { id }) => ctx.db.get(id),
});

async function loadAccount(
  ctx: QueryCtx | MutationCtx | ActionCtx,
  id: Id<"users">,
): Promise<Doc<"users"> | null> {
  if ("db" in ctx) return ctx.db.get(id);

  return ctx.runQuery(internal.access.operatorAccount, { id });
}

export async function requireOperator(ctx: QueryCtx | MutationCtx | ActionCtx) {
  const id = await getAuthUserId(ctx);
  const account = id === null ? null : await loadAccount(ctx, id);
  // `emailVerificationTime` is only ever set once convex/auth.ts's Email OTP
  // provider confirms a code — this is the one fact this app trusts, never a
  // claim carried on the identity/JWT itself.
  const email = account?.emailVerificationTime ? account.email?.trim().toLowerCase() : undefined;

  if (!id || !email || !operatorEmails().has(email))
    throw new ConvexError("Sign in as an operator to import.");

  return id;
}

/**
 * Whether the CALLER is currently an operator. Lets the public UI show a
 * sign-in path before someone hits the ConvexError from an actual
 * provider-spending call, without exposing the `OPERATOR_EMAILS` list
 * itself (a mismatch reads identically to "not signed in").
 */
export const isOperator = query({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    try {
      await requireOperator(ctx);

      return true;
    } catch {
      return false;
    }
  },
});
