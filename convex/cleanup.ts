import { internalMutation } from "./_generated/server";

export const transient = internalMutation({
  args: {},
  handler: async (ctx) => {
    const before = Date.now() - 86_400_000;

    // Bounded oldest-first deletion; these are UI snapshots, never corpus storage.
    for (const table of ["sessions", "pages"] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_creation_time", (q) => q.lt("_creationTime", before))
        .take(100);

      for (const row of rows) await ctx.db.delete(row._id);
    }
  },
});
