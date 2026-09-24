import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { jobsForAccount } from "../convex/lib/accounts";

const modules = import.meta.glob("../convex/**/*.ts");

/**
 * These bounds exist so one request cannot read unboundedly. Hitting one
 * does not mean the account is absent — it means the search stopped. The
 * caller has to be able to tell those apart, or it reports an absence it
 * never established.
 *
 * The imported corpus is shared infrastructure, not personal data: this
 * lookup walks account-history jobs across every owner, not one person's
 * own runs.
 */
describe("a targeted account lookup reports whether it finished", () => {
  it("collects every run for the account across every owner and says the search completed", async () => {
    const t = convexTest(schema, modules);

    const { accountId } = await t.run(async (ctx) => {
      const alice = await ctx.db.insert("users", { isAnonymous: true });
      const bob = await ctx.db.insert("users", { isAnonymous: true });

      const accountId = await ctx.db.insert("accounts", {
        handle: "mine",
        userId: "55",
        name: "Mine",
      });

      for (const i of [0, 1, 2]) {
        // Alternate owners so the lookup is proven to cross owner
        // boundaries, not just to read one owner's rows.
        await ctx.db.insert("jobs", {
          owner: i % 2 === 0 ? alice : bob,
          kind: "bulk",
          input: "mine",
          expectedUserId: "55",
          refresh: false,
          status: "complete",
          count: i,
          attempt: 1,
          warnings: [],
          updatedAt: Date.now() + i,
        });
        // Interleave another account's runs, which must not be collected.
        await ctx.db.insert("jobs", {
          owner: alice,
          kind: "bulk",
          input: "other",
          expectedUserId: "66",
          refresh: false,
          status: "complete",
          count: 0,
          attempt: 1,
          warnings: [],
          updatedAt: Date.now(),
        });
      }

      return { accountId };
    });

    const found = await t.run((ctx) => jobsForAccount(ctx.db, accountId));
    expect(found.exhausted).toBe(true);
    expect(found.jobs).toHaveLength(3);
    expect(found.jobs.every((job) => job.expectedUserId === "55")).toBe(true);
  });

  it("returns exhausted for an account nobody has ever run a job for", async () => {
    const t = convexTest(schema, modules);

    const strangerAccount = await t.run((ctx) =>
      ctx.db.insert("accounts", { handle: "stranger", userId: "99", name: "Stranger" }),
    );

    const found = await t.run((ctx) => jobsForAccount(ctx.db, strangerAccount));

    // Nothing found AND the search finished — only this combination
    // justifies telling someone the account is not there.
    expect(found.jobs).toHaveLength(0);
    expect(found.exhausted).toBe(true);
  });
});
