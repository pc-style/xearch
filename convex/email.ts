import { mutation, query } from "./_generated/server";
import { components } from "./_generated/api";
import { AgentMail, type OutboundId } from "@agentmail/convex";
import { v, ConvexError } from "convex/values";
import { user } from "./access";
import type { Doc } from "./_generated/dataModel";
const mail = new AgentMail(components.agentmail);
const DIGEST_ROW_LIMIT = 10;

// Single source of truth for the digest's subject/body so `preview` (safe,
// no send) and `send` (explicit, AgentMail-backed) can never drift apart -
// this is the whole "digest", there is no second mail outbox to keep in sync.
function buildDigest(result: Doc<"sessions">) {
  const rows = result.rows.slice(0, DIGEST_ROW_LIMIT);
  return {
    subject: `Xearch: ${result.raw.replace(/[\r\n]/g, " ").slice(0, 100)}`,
    text:
      `Xearch results for: ${result.raw}\n\nFirst ${rows.length} of ${result.rows.length} results on this page.\n${result.warnings.join("\n")}\n\n` +
      rows.map((p) => `@${p.author}\n${p.text.slice(0, 1500)}\n${p.url}`).join("\n\n---\n\n"),
    rowCount: rows.length,
    totalCount: result.rows.length,
  };
}

// Read-only: ownership-checked, sends nothing. Lets the UI show exactly what
// `send` would deliver, and who it would go to by default, before the user
// commits to an explicit send.
export const preview = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const owner = await user(ctx);
    const result = await ctx.db.get(args.sessionId);
    if (!result || result.owner !== owner || result.status !== "complete" || !result.rows.length)
      throw new ConvexError("There are no completed search results to preview.");
    const account = await ctx.db.get(owner);
    const { subject, text, rowCount, totalCount } = buildDigest(result);
    return {
      subject,
      text,
      rowCount,
      totalCount,
      verifiedEmail: account?.emailVerificationTime ? (account.email ?? null) : null,
    };
  },
});

export const send = mutation({
  args: { sessionId: v.id("sessions"), recipient: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const owner = await user(ctx);
    // Unconditional: an authenticated identity (including an Anonymous-
    // provider guest, see convex/auth.ts) must have a verified email that
    // matches the recipient before any real AgentMail send goes out. This
    // used to be gated behind REQUIRE_VERIFIED_EMAIL, which defaulted to
    // fail-open (off) on every deployment except one hardcoded prod target
    // in scripts/setup-production.mjs - a config flag is not a substitute
    // for a default-secure check.
    const account = await ctx.db.get(owner);
    if (
      !account?.emailVerificationTime ||
      account.email?.toLowerCase() !== args.recipient.trim().toLowerCase()
    )
      throw new ConvexError("Email sending requires sign-in with a verified email address.");
    if (!process.env.AGENTMAIL_API_KEY || !process.env.AGENTMAIL_INBOX_ID)
      throw new ConvexError("Configure AgentMail on the backend to send results.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.recipient) || args.recipient.length > 254)
      throw new ConvexError("Enter a valid email address.");
    const result = await ctx.db.get(args.sessionId);
    if (!result || result.owner !== owner || result.status !== "complete" || !result.rows.length)
      throw new ConvexError("There are no completed search results to send.");
    const { subject, text } = buildDigest(result);
    const outboundId = await mail.sendMessage(ctx, process.env.AGENTMAIL_INBOX_ID, {
      to: args.recipient,
      subject,
      text,
    });
    await ctx.db.insert("deliveries", { owner, outboundId, query: result.raw });
  },
});
export const deliveries = query({
  args: {},
  handler: async (ctx) => {
    const owner = await user(ctx);
    const rows = await ctx.db
      .query("deliveries")
      .withIndex("by_owner", (q) => q.eq("owner", owner))
      .order("desc")
      .take(5);
    return Promise.all(
      rows.map(async (row) => ({
        ...row,
        delivery: await mail.status(ctx, row.outboundId as OutboundId),
      })),
    );
  },
});
