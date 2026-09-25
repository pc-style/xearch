import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");

describe("worker job priority", () => {
  it("claims due manual jobs before older history windows, FIFO within each group", async () => {
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) => ctx.db.insert("users", { isAnonymous: true }));

    const insert = (input: string, origin: "manual" | "history" | "discovered", readyAt?: number) =>
      t.run((ctx) =>
        ctx.db.insert("jobs", {
          owner,
          kind: "live",
          input,
          origin,
          refresh: false,
          status: "queued",
          count: 0,
          attempt: 0,
          warnings: [],
          updatedAt: Date.now(),
          readyAt,
        }),
      );

    const history = await insert("history", "history");
    const discovered = await insert("discovered", "discovered");
    const firstManual = await insert("manual-one", "manual");
    await insert("not-due", "manual", Date.now() + 60_000);
    const secondManual = await insert("manual-two", "manual");

    expect((await t.mutation(anyApi.worker.claimNext, {}))?._id).toBe(firstManual);
    await t.run(async (ctx) => {
      await ctx.db.patch(firstManual, { status: "complete" });
    });
    expect((await t.mutation(anyApi.worker.claimNext, {}))?._id).toBe(secondManual);
    await t.run(async (ctx) => {
      await ctx.db.patch(secondManual, { status: "complete" });
    });
    expect((await t.mutation(anyApi.worker.claimNext, {}))?._id).toBe(history);
    await t.run(async (ctx) => {
      await ctx.db.patch(history, { status: "complete" });
    });
    expect((await t.mutation(anyApi.worker.claimNext, {}))?._id).toBe(discovered);
  });
});
