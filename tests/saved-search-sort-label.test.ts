// QA report /tmp/issues.md item 13 (2026-09-24): saving the same query under
// two different sorts produced two identical-looking rows in the Saved
// searches modal. src/App.tsx now renders each row's sort via `sortLabel`
// (src/sortOptions.ts), reusing the same labels as the sort <select>. No
// test in this repo renders src/App.tsx itself (see tests/journey.test.ts),
// so this exercises the exported pure function directly rather than the
// modal markup.
import { describe, expect, it } from "vitest";
import { sortLabel } from "../src/sortOptions";

describe("item 13: sortLabel", () => {
  it("maps every sort value to the same label shown in the sort <select>", () => {
    expect(sortLabel("relevance")).toBe("Relevant");
    expect(sortLabel("engagement")).toBe("Relevant + engagement");
    expect(sortLabel("likes")).toBe("Most liked");
    expect(sortLabel("newest")).toBe("Newest");
    expect(sortLabel("oldest")).toBe("Oldest");
  });

  it("distinguishes two saved rows for the same query under different sorts", () => {
    expect(sortLabel("relevance")).not.toBe(sortLabel("newest"));
  });
});
