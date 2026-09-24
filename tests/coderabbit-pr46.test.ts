// Regression tests for CodeRabbit findings on PR #46 (2026-09-24) that live
// in App.tsx's own decision logic. App.tsx itself is never rendered in this
// repo's tests (see tests/journey.test.ts's comment on why), so each finding
// that touched App.tsx got its logic extracted into a small pure function
// (src/sortOptions.ts, src/ring.ts) specifically so it could be tested here
// without a ConvexProvider.
import { describe, expect, it } from "vitest";
import { isAlreadySaved, sortChangeQuery } from "../src/sortOptions";
import { splitRing } from "../src/ring";

describe("isAlreadySaved trims raw before comparing (finding: normalise raw)", () => {
  const saved = [{ query: "theo", sort: "relevance" as const }];

  it("matches an exact saved query", () => {
    expect(isAlreadySaved(saved, "theo", "relevance")).toBe(true);
  });

  it("still matches when raw carries stray whitespace from a restored URL", () => {
    expect(isAlreadySaved(saved, "  theo  ", "relevance")).toBe(true);
  });

  it("does not match a different sort", () => {
    expect(isAlreadySaved(saved, "theo", "newest")).toBe(false);
  });

  it("does not match an unsaved query", () => {
    expect(isAlreadySaved(saved, "convex", "relevance")).toBe(false);
  });
});

describe("splitRing counts every omitted item (finding: count omitted ring accounts)", () => {
  it("shows everything and reports no overflow under the limit", () => {
    const { shown, overflow } = splitRing([1, 2, 3], 32);
    expect(shown).toEqual([1, 2, 3]);
    expect(overflow).toBe(0);
  });

  it("shows everything and reports no overflow exactly at the limit", () => {
    const items = Array.from({ length: 32 }, (_, i) => i);
    const { shown, overflow } = splitRing(items, 32);
    expect(shown).toHaveLength(32);
    expect(overflow).toBe(0);
  });

  it("reserves one slot for the chip and counts both omitted items with 33 items", () => {
    const items = Array.from({ length: 33 }, (_, i) => i);
    const { shown, overflow } = splitRing(items, 32);
    // 31 shown + a chip standing in for the 32nd slot = 32 visual slots.
    expect(shown).toHaveLength(31);
    // The old `items.length - limit` (33 - 32 = 1) undercounted this by one;
    // it must count everything not in `shown` (33 - 31 = 2).
    expect(overflow).toBe(2);
  });
});

describe("sortChangeQuery keeps the active result tied to its sort", () => {
  it("re-searches the draft when it has an uncommitted edit", () => {
    expect(sortChangeQuery("bun", "theo")).toBe("bun");
  });

  it("falls back to the active query when the draft was cleared but results are showing", () => {
    // This is the bug: previously nothing re-ran the search here, so
    // `result` (matched on `snapshot.sort === sort`) went stale relative to
    // the newly set `sort` and ResultsSection stuck on "Finding matching
    // posts…" forever.
    expect(sortChangeQuery("", "theo")).toBe("theo");
    expect(sortChangeQuery("   ", "theo")).toBe("theo");
  });

  it("returns null only at the true empty-home state, with nothing to resync", () => {
    expect(sortChangeQuery("", "")).toBeNull();
    expect(sortChangeQuery("   ", "")).toBeNull();
  });
});
