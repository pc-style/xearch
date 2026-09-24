import { describe, expect, it } from "vitest";
import { canonicalQuery, parseQuery } from "../convex/lib/search";
import {
  DEFAULT_JOIN_FLOOR,
  addDaysUTC,
  computeWindow,
  historyWindowQuery,
  isFinalWindow,
  nextWindowDays,
} from "../convex/lib/historyWindow";

describe("canonicalQuery with allowDateWindow (deep-history backfill)", () => {
  it("accepts from:<handle> since:<date> until:<date> and renders it byte-identical", () => {
    const result = canonicalQuery("from:theo since:2021-06-01 until:2021-09-01", {
      allowDateWindow: true,
    });

    expect(result.author).toBe("theo");
    expect(result.since).toBe("2021-06-01");
    expect(result.until).toBe("2021-09-01");
    expect(result.canonical).toBe("from:theo since:2021-06-01 until:2021-09-01");
  });

  it("matches historyWindowQuery's own construction exactly", () => {
    const raw = historyWindowQuery("theo", "2021-06-01", "2021-09-01");
    const result = canonicalQuery(raw, { allowDateWindow: true });

    expect(result.canonical).toBe(raw);
  });

  it("requires an author for a dated window", () => {
    expect(() =>
      canonicalQuery("since:2021-06-01 until:2021-09-01", { allowDateWindow: true }),
    ).toThrow("A dated history window requires an author");
  });

  it("still rejects every other operator even with allowDateWindow set", () => {
    expect(() =>
      parseQuery("from:theo min_faves:10 since:2021-06-01", { allowDateWindow: true }),
    ).toThrow("Use @handle to filter authors");
  });

  it("never accepts since:/until: from a person's own search box (allowDateWindow unset)", () => {
    // Public input rules are unchanged: `since:`/`until:` fall through to the
    // ordinary unsupported-operator rejection, exactly as any other operator
    // does today.
    expect(() => parseQuery("from:theo since:2021-06-01")).toThrow("Use @handle to filter authors");
  });

  it("keeps ordinary @handle search behavior unchanged", () => {
    expect(canonicalQuery("@Theo convex").canonical).toBe("@theo convex");
  });
});

describe("addDaysUTC", () => {
  it("shifts a date backward across a month boundary", () => {
    expect(addDaysUTC("2021-09-01", -30)).toBe("2021-08-02");
  });

  it("shifts a date forward", () => {
    expect(addDaysUTC("2021-08-02", 30)).toBe("2021-09-01");
  });
});

describe("computeWindow", () => {
  it("walks a 30-day window back from the cursor", () => {
    expect(computeWindow("2026-07-11", 30, DEFAULT_JOIN_FLOOR)).toEqual({
      since: "2026-06-11",
      until: "2026-07-11",
    });
  });

  it("clamps the window's since to the floor rather than overshooting it", () => {
    expect(computeWindow("2006-04-01", 30, DEFAULT_JOIN_FLOOR)).toEqual({
      since: DEFAULT_JOIN_FLOOR,
      until: "2006-04-01",
    });
  });

  it("returns null once the cursor has already reached the floor", () => {
    expect(computeWindow(DEFAULT_JOIN_FLOOR, 30, DEFAULT_JOIN_FLOOR)).toBeNull();
    expect(computeWindow("2006-01-01", 30, DEFAULT_JOIN_FLOOR)).toBeNull();
  });
});

describe("isFinalWindow", () => {
  it("is true once a window's since reaches the floor", () => {
    expect(
      isFinalWindow({ since: DEFAULT_JOIN_FLOOR, until: "2006-04-01" }, DEFAULT_JOIN_FLOOR),
    ).toBe(true);
  });

  it("is false while the window is still above the floor", () => {
    expect(isFinalWindow({ since: "2020-01-01", until: "2020-02-01" }, DEFAULT_JOIN_FLOOR)).toBe(
      false,
    );
  });
});

describe("nextWindowDays", () => {
  it("keeps the same size after a window that found posts", () => {
    expect(nextWindowDays(30, 120)).toBe(30);
  });

  it("widens ×4 after an empty window", () => {
    expect(nextWindowDays(30, 0)).toBe(120);
  });

  it("caps the widened size at 365 days", () => {
    expect(nextWindowDays(200, 0)).toBe(365);
  });
});
