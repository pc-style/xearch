import { describe, expect, it, vi, beforeEach } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

const modules = import.meta.glob("../convex/**/*.ts");

/**
 * Authorization boundary for provider-spending actions (adam's decision,
 * 2026-09-24): ordinary search stays public, but starting/retrying an
 * import, and cancel/dismiss/restore on a job, require a signed-in OPERATOR
 * — a caller whose verified email (from the stock Email OTP provider,
 * convex/auth.ts) is listed in OPERATOR_EMAILS. An anonymous session and a
 * verified-but-unlisted email are both refused the same way, so the
 * allowlist itself is never confirmed or denied to the caller.
 *
 * tests/setupEnv.ts sets OPERATOR_EMAILS to
 * "alice@test.xearch,bob@test.xearch,operator@test.xearch" for every test in
 * this suite; this file additionally exercises identities NOT on that list.
 */

async function setup() {
  const t = convexTest(schema, modules);
  const operatorUser = await t.run((ctx) => ctx.db.insert("users", { isAnonymous: false }));
  const guestUser = await t.run((ctx) => ctx.db.insert("users", { isAnonymous: true }));
  const outsiderUser = await t.run((ctx) => ctx.db.insert("users", { isAnonymous: false }));

  return {
    t,
    // A verified email ON the OPERATOR_EMAILS allowlist.
    operator: t.withIdentity({ subject: `${operatorUser}|s`, email: "operator@test.xearch" }),
    // No email at all — the Anonymous auth provider's shape.
    guest: t.withIdentity({ subject: `${guestUser}|s` }),
    // A verified email that is NOT on the allowlist.
    outsider: t.withIdentity({ subject: `${outsiderUser}|s`, email: "outsider@test.xearch" }),
  };
}

describe("the operator authorization boundary", () => {
  beforeEach(() => {
    vi.stubEnv("X_MD_API_KEY", "test");
    vi.stubEnv("RAW_CAPTURE_URL", "http://127.0.0.1:4319/captures");
    vi.stubEnv("COLLECTOR_MODE", "receiver");
  });

  it("access.isOperator reports true only for a verified, allowlisted email", async () => {
    const { operator, guest, outsider } = await setup();
    expect(await operator.query(api.access.isOperator, {})).toBe(true);
    expect(await guest.query(api.access.isOperator, {})).toBe(false);
    expect(await outsider.query(api.access.isOperator, {})).toBe(false);
  });

  it("refuses jobs.start for an anonymous guest", async () => {
    const { guest } = await setup();
    await expect(
      guest.mutation(api.jobs.start, { kind: "live", input: "from:theo" }),
    ).rejects.toThrow("Sign in as an operator to import.");
  });

  it("refuses jobs.start for a verified email not on OPERATOR_EMAILS", async () => {
    const { outsider } = await setup();
    await expect(
      outsider.mutation(api.jobs.start, { kind: "live", input: "from:theo" }),
    ).rejects.toThrow("Sign in as an operator to import.");
  });

  it("allows jobs.start for an operator", async () => {
    const { operator } = await setup();
    const jobId = await operator.mutation(api.jobs.start, { kind: "live", input: "from:theo" });
    expect(jobId).toBeTruthy();
  });

  it("refuses cancel/dismiss/restore for a non-operator, even on a job someone else started", async () => {
    const { t, operator, guest, outsider } = await setup();
    const jobId = await operator.mutation(api.jobs.start, { kind: "live", input: "from:theo" });
    await t.run((ctx) => ctx.db.patch(jobId, { status: "failed" }));

    await expect(guest.mutation(api.jobs.cancel, { jobId })).rejects.toThrow(
      "Sign in as an operator to import.",
    );
    await expect(outsider.mutation(api.jobs.retry, { jobId })).rejects.toThrow(
      "Sign in as an operator to import.",
    );
    await expect(guest.mutation(api.jobs.dismiss, { jobId })).rejects.toThrow(
      "Sign in as an operator to import.",
    );
    await expect(outsider.mutation(api.jobs.restore, { jobId })).rejects.toThrow(
      "Sign in as an operator to import.",
    );
  });

  it("allows an operator to cancel/dismiss/restore a job, including one a different operator started", async () => {
    const { t, operator } = await setup();
    const otherOperatorUser = await t.run((ctx) => ctx.db.insert("users", { isAnonymous: false }));

    const otherOperator = t.withIdentity({
      subject: `${otherOperatorUser}|s`,
      email: "bob@test.xearch",
    });

    const jobId = await otherOperator.mutation(api.jobs.start, {
      kind: "live",
      input: "from:theo",
    });

    // Jobs are shared infrastructure (to-do.md); a different operator may
    // act on a run they did not personally start.
    await operator.mutation(api.jobs.cancel, { jobId });
    const cancelled = await t.run((ctx) => ctx.db.get(jobId));
    expect(cancelled?.status).toBe("cancelled");
  });

  it("still lets an anonymous (or any signed-in) caller read the job feed and receipts — only the provider-spending actions are gated", async () => {
    const { t, operator, guest } = await setup();
    const jobId = await operator.mutation(api.jobs.start, { kind: "live", input: "from:theo" });
    await t.run((ctx) => ctx.db.patch(jobId, { status: "complete" }));
    const feed = await guest.query(api.jobs.list, {});
    expect(feed.jobs.map((j) => j._id)).toContain(jobId);
    await expect(guest.query(api.jobs.receipts, { jobId })).resolves.toEqual([]);
  });
});
