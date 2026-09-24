import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { QueryCtx, MutationCtx } from "./_generated/server";

export async function user(ctx: QueryCtx | MutationCtx) {
  const id = await getAuthUserId(ctx);

  if (!id) throw new ConvexError("Start a session to use your workspace.");

  return id;
}
