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
 * Two independent paths grant operator status:
 *
 *   1. The operator build's own build-time token (`src/operatorToken.ts`,
 *      `VITE_OPERATOR_TOKEN`). The operator site is already restricted to
 *      exe.dev accounts with VM access (docs/production.md) — being on that
 *      site IS the operator proof, so this is the primary path and asks for
 *      no sign-in of any kind. Checked against `OPERATOR_TOKEN` on this
 *      deployment (or `OPERATOR_TOKEN_PREVIOUS`, set only transiently during
 *      a rotation — docs/production.md "To rotate it") with a constant-time
 *      comparison so a wrong guess cannot be narrowed down by timing.
 *   2. A fallback allowlist: the existing Email OTP provider (convex/auth.ts,
 *      src/auth/EmailSignIn.tsx) already gives every caller a verified email
 *      once they sign in with a code. This path accepts exactly the
 *      identities whose verified email is listed in the `OPERATOR_EMAILS`
 *      env var (comma-separated, case-insensitive; an entry like
 *      "@pcstyle.dev" admits every verified address on that domain). This is
 *      what the public site and the test suite use, since neither carries
 *      the build-time token.
 *
 * Either way a real session is still required — even the token path needs a
 * signed-in (possibly anonymous) caller to have a user id to record as
 * `owner` — and a caller with neither a matching token nor an allowlisted
 * email is refused with the same message, so neither the token nor the list
 * is ever confirmed or denied to the caller.
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

/**
 * Whether a verified email is an operator. An entry is either a full
 * address ("me@pcstyle.dev") or a domain ("@pcstyle.dev"), which admits every
 * verified address on that domain — the operator's own domain, not a public
 * mail provider, is the intended use.
 */
export function isOperatorEmail(email: string, entries: Set<string>): boolean {
  const address = email.trim().toLowerCase();
  const at = address.lastIndexOf("@");

  if (at <= 0 || at === address.length - 1) return false;

  return entries.has(address) || entries.has(address.slice(at));
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

/**
 * Constant-time string comparison. Convex queries/mutations run in a V8
 * isolate with no `node:crypto` (only actions can opt into the Node
 * runtime), so this is a plain manual equivalent of
 * `crypto.timingSafeEqual`: every character is compared regardless of where
 * an earlier mismatch occurred, so a wrong token takes the same time to
 * reject whether the first character is wrong or the last one is. The
 * length check short-circuits — leaking a token's length is not the secret
 * being protected here.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let mismatch = 0;

  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);

  return mismatch === 0;
}

export async function requireOperator(
  ctx: QueryCtx | MutationCtx | ActionCtx,
  operatorToken?: string,
) {
  const id = await getAuthUserId(ctx);

  // Both paths below need a real session (even the token path records
  // `owner` from it), so refuse up front rather than repeating this check
  // twice.
  if (!id) throw new ConvexError("Sign in as an operator to import.");

  // Path 1: the operator build's own token. Fails closed when
  // `OPERATOR_TOKEN` is unset on this deployment — an unset env var must
  // never make this branch trivially satisfiable by an empty/undefined
  // token on either side.
  //
  // `OPERATOR_TOKEN_PREVIOUS` (optional) exists only to make rotation
  // gapless (CodeRabbit #4090910221): the deployed operator bundle has ONE
  // token baked in at build time, and this deployment can only ever hold
  // one `OPERATOR_TOKEN` value, so publishing a new build and updating the
  // deployment are two separate, non-atomic steps — whichever happens
  // second, the live bundle's still-old (or already-new) token stops
  // matching for that gap. Setting the OLD value here during a rotation
  // lets both the not-yet-republished and freshly-republished bundle work
  // at once; see docs/production.md "To rotate it" for the exact sequence.
  const configuredToken = process.env.OPERATOR_TOKEN;
  const previousToken = process.env.OPERATOR_TOKEN_PREVIOUS;

  if (operatorToken) {
    if (configuredToken && timingSafeEqual(operatorToken, configuredToken)) return id;

    if (previousToken && timingSafeEqual(operatorToken, previousToken)) return id;
  }

  // Path 2: the verified-email allowlist, unchanged from before the token
  // existed. `emailVerificationTime` is only ever set once convex/auth.ts's
  // Email OTP provider confirms a code — this is the one fact this app
  // trusts, never a claim carried on the identity/JWT itself.
  const account = await loadAccount(ctx, id);
  const email = account?.emailVerificationTime ? account.email?.trim().toLowerCase() : undefined;

  if (!email || !isOperatorEmail(email, operatorEmails()))
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
  args: { operatorToken: v.optional(v.string()) },
  returns: v.boolean(),
  handler: async (ctx, { operatorToken }) => {
    try {
      await requireOperator(ctx, operatorToken);

      return true;
    } catch {
      return false;
    }
  },
});
