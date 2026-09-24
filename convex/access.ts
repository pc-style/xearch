import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
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

export async function requireOperator(ctx: QueryCtx | MutationCtx | ActionCtx) {
  const identity = await ctx.auth.getUserIdentity();
  const email = identity?.email?.trim().toLowerCase();

  if (!email || !operatorEmails().has(email))
    throw new ConvexError("Sign in as an operator to import.");

  // Also asserts a session exists at all (getUserIdentity() already implies
  // this when email is present), and gives callers the stable user id.
  return user(ctx);
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
