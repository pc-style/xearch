import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");

describe("worker job priority", () => {
  it("claims due manual jobs before older history windows, FIFO within each group", async () => {
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) => ctx.db.insert("users", { isAnonymous: true }));

    const insert = (
      input: string,
      origin?: "manual" | "history" | "discovered",
      readyAt?: number,
    ) =>
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

    for (let i = 0; i < 22; i++) await insert(`history-${i}`, "history");
    await insert("discovered", "discovered");
    const legacyManual = await insert("legacy-manual");
    await insert("legacy-not-due", undefined, Date.now() + 60_000);
    const firstManual = await insert("manual-one", "manual", Date.now() - 5_000);

    for (let i = 0; i < 101; i++) await insert(`not-due-${i}`, "manual", Date.now() + 60_000);
    const secondManual = await insert("manual-two", "manual", Date.now() - 10_000);

    expect((await t.mutation(anyApi.worker.claimNext, {}))?._id).toBe(legacyManual);
    await t.run(async (ctx) => {
      await ctx.db.patch(legacyManual, { status: "complete" });
    });
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
    expect((await t.mutation(anyApi.worker.claimNext, {}))?.origin).toBe("history");
  });
});
