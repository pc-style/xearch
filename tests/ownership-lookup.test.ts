import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { ownerJobsForAccount } from "../convex/lib/accounts";
import type { Id } from "../convex/_generated/dataModel";

const modules = import.meta.glob("../convex/**/*.ts");

/**
 * These bounds exist so one request cannot read unboundedly. Hitting one
 * does not mean the account is absent — it means the search stopped. The
 * caller has to be able to tell those apart, or it reports an absence it
 * never established.
 */
describe("a targeted ownership lookup reports whether it finished", () => {
  it("collects every run for the account and says the search completed", async () => {
    const t = convexTest(schema, modules);
    const { owner, accountId } = await t.run(async (ctx) => {
      const owner = await ctx.db.insert("users", { isAnonymous: true });
      const accountId = await ctx.db.insert("accounts", {
        handle: "mine",
        userId: "55",
        name: "Mine",
      });
      for (const i of [0, 1, 2]) {
        await ctx.db.insert("jobs", {
          owner,
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
          owner,
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
      return { owner, accountId };
    });

    const found = await t.run((ctx) =>
      ownerJobsForAccount(ctx.db, owner as Id<"users">, accountId),
    );
    expect(found.exhausted).toBe(true);
    expect(found.jobs).toHaveLength(3);
    expect(found.jobs.every((job) => job.expectedUserId === "55")).toBe(true);
  });

  it("returns exhausted for an account the owner genuinely does not have", async () => {
    const t = convexTest(schema, modules);
    const { owner, strangerAccount } = await t.run(async (ctx) => {
      const owner = await ctx.db.insert("users", { isAnonymous: true });
      const strangerAccount = await ctx.db.insert("accounts", {
        handle: "stranger",
        userId: "99",
        name: "Stranger",
      });
      return { owner, strangerAccount };
    });
    const found = await t.run((ctx) =>
      ownerJobsForAccount(ctx.db, owner as Id<"users">, strangerAccount),
    );
    // Nothing found AND the search finished — only this combination
    // justifies telling someone the account is not theirs.
    expect(found.jobs).toHaveLength(0);
    expect(found.exhausted).toBe(true);
  });
});
