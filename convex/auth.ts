import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
import { Email } from "@convex-dev/auth/providers/Email";
import {
  convexAuth,
  getAuthUserId,
  type GenericActionCtxWithAuthConfig,
} from "@convex-dev/auth/server";
import { AgentMail } from "@agentmail/convex";
import { components } from "./_generated/api";
import { query } from "./_generated/server";
import type { DataModel } from "./_generated/dataModel";

type AuthActionCtx = GenericActionCtxWithAuthConfig<DataModel>;

// @convex-dev/auth 0.0.95's Email() helper (node_modules/@convex-dev/auth/src/
// providers/Email.ts) only forwards `sendVerificationRequest` from this config;
// id/type/name/maxAge/authorize are fixed by the helper itself, so the OTP
// lifetime is that library's hardcoded 1 hour regardless of what we pass here.
// The library also calls sendVerificationRequest with a second `ctx` argument
// at runtime even though its own exported type only declares one parameter
// (server/implementation/signIn.ts suppresses that exact mismatch with its own
// `@ts-expect-error`). Declaring `ctx` as a rest parameter here - rather than a
// second required one - keeps this function's own type honestly assignable to
// `EmailConfig["sendVerificationRequest"]` without a cast: a rest parameter of
// array type makes a function assignable anywhere fewer arguments are
// expected, while still requiring (and receiving, every real call) exactly
// one `ctx` argument at runtime.
async function sendVerificationRequest(
  { identifier, token, expires }: { identifier: string; token: string; expires: Date },
  ...ctxArgs: AuthActionCtx[]
): Promise<void> {
  const [ctx] = ctxArgs;

  if (!ctx) throw new Error("@convex-dev/auth did not pass an action context.");

  if (!process.env.AGENTMAIL_API_KEY || !process.env.AGENTMAIL_INBOX_ID)
    throw new Error("Configure AgentMail on the backend to send sign-in codes.");
  const mail = new AgentMail(components.agentmail);

  // SAFETY: `ctx.runMutation` is Convex's own generic `runMutation`, just
  // instantiated against this action's overload (which additionally accepts a
  // `transactionLimits` option @agentmail/convex's vendored, narrower
  // RunMutationCtx type never declares or passes). Both are the same function
  // with the same runtime contract for the one call this wrapper makes
  // (mutation reference plus its args, no transactionLimits) - only their
  // independently-authored ambient generic signatures disagree. Same gap as
  // convex/http.ts's agentmail webhook route.
  const mutationCtx: Parameters<typeof mail.sendMessage>[0] = {
    runMutation: ctx.runMutation as Parameters<typeof mail.sendMessage>[0]["runMutation"],
  };

  await mail.sendMessage(mutationCtx, process.env.AGENTMAIL_INBOX_ID, {
    to: identifier,
    subject: "Your Xearch sign-in code",
    text:
      `Your Xearch sign-in code is ${token}.\n\n` +
      `It expires at ${expires.toISOString()}. If you didn't request this, you can ignore this email.`,
  });
}

const EmailOTP = Email<DataModel>({
  sendVerificationRequest,
});

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Anonymous, EmailOTP],
});

// The caller's own identity only - never accepts a userId argument, so there
// is nothing here for an ownership check to guard (see convex/access.ts).
export const me = query({
  args: {},
  handler: async (ctx) => {
    const id = await getAuthUserId(ctx);

    if (!id) return null;
    const account = await ctx.db.get(id);

    if (!account) return null;

    return {
      isAnonymous: account.isAnonymous ?? false,
      email: account.email ?? null,
      emailVerified: !!account.emailVerificationTime,
    };
  },
});
