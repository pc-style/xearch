import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { QueryCtx, MutationCtx } from "./_generated/server";
export async function user(ctx: QueryCtx | MutationCtx) {
  const id = await getAuthUserId(ctx);
  if (!id) throw new ConvexError("Start a session to use your workspace.");
  return id;
}

// The identity without the guard: returns null instead of throwing when
// there is no session. A live query re-runs on its own after sign-out, token
// expiry, or a reconnect that lands before the token is back, and in that
// window there is no identity yet. Throwing there turns an expected auth
// transition into an uncaught ConvexError that error tracking files as a
// high-severity issue. Auth-gated queries call this and return an empty
// result for the transition; mutations keep `user` so an unauthenticated
// write still fails loudly.
export async function maybeUser(ctx: QueryCtx | MutationCtx) {
  return await getAuthUserId(ctx);
}
