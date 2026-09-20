import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
import { Email } from "@convex-dev/auth/providers/Email";
import {
  convexAuth,
  getAuthUserId,
  type EmailConfig,
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
// `@ts-expect-error`) - the cast below matches that same, already-intentional
// widening rather than inventing a parallel auth mechanism.
async function sendVerificationRequest(
  { identifier, token, expires }: { identifier: string; token: string; expires: Date },
  ctx: AuthActionCtx,
): Promise<void> {
  if (!process.env.AGENTMAIL_API_KEY || !process.env.AGENTMAIL_INBOX_ID)
    throw new Error("Configure AgentMail on the backend to send sign-in codes.");
  const mail = new AgentMail(components.agentmail);
  // Actions' `runMutation` carries an extra (transactionLimits) overload that
  // @agentmail/convex's RunMutationCtx - typed against plain MutationCtx -
  // doesn't declare; convex/email.ts's mutation-context call needs no such
  // cast. Same kind of unavoidable cross-package type gap as the ctx cast
  // above, not a new pattern.
  await mail.sendMessage(ctx as unknown as Parameters<typeof mail.sendMessage>[0], process.env.AGENTMAIL_INBOX_ID, {
    to: identifier,
    subject: "Your Xearch sign-in code",
    text:
      `Your Xearch sign-in code is ${token}.\n\n` +
      `It expires at ${expires.toISOString()}. If you didn't request this, you can ignore this email.`,
  });
}

const EmailOTP = Email<DataModel>({
  sendVerificationRequest: sendVerificationRequest as unknown as EmailConfig<DataModel>["sendVerificationRequest"],
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
