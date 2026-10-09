import { describe, expect, it } from "vitest";
import { canonicalQuery, parseQuery } from "../convex/lib/search";
import {
  DEFAULT_JOIN_FLOOR,
  addDaysUTC,
  computeWindow,
  historyWindowQuery,
  nextWindowDays,
  resumeUntil,
} from "../convex/lib/historyWindow";
import { postSpan } from "../convex/lib/collect";

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

describe("resumeUntil", () => {
  const year = { since: "2021-11-02", until: "2022-11-02" };

  it("walks on from the window's start when x.md paged all the way down", () => {
    expect(resumeUntil(year, undefined)).toBe("2021-11-02");
    expect(resumeUntil(year, "2021-10-31T23:00:00.000Z")).toBe("2021-11-02");
  });

  it("resumes from the oldest post's day when x.md stopped early", () => {
    // Production: this window returned only September and October 2022.
    expect(resumeUntil(year, "2022-09-28T20:43:31.000Z")).toBe("2022-09-29");
  });

  it("always moves earlier than the window's own until", () => {
    expect(resumeUntil(year, "2022-11-01T12:00:00.000Z")).toBe("2022-11-01");
    expect(resumeUntil({ since: "2022-11-01", until: "2022-11-02" }, "2022-11-01T12:00:00Z")).toBe(
      "2022-11-01",
    );
  });
});

describe("postSpan", () => {
  const at = (created_at: string) => ({ created_at });

  it("reads X's created_at format and reports ISO bounds", () => {
    expect(
      postSpan([at("Wed Sep 28 20:43:31 +0000 2022"), at("Fri Oct 07 00:07:03 +0000 2022")]),
    ).toEqual({ newest: "2022-10-07T00:07:03.000Z", oldest: "2022-09-28T20:43:31.000Z" });
  });

  it("leaves out a pinned post from months before the rest", () => {
    // Production @theo timeline: July to September, plus one post from March.
    expect(
      postSpan([
        at("2026-09-24T00:59:29.000Z"),
        at("2026-03-30T03:03:36.000Z"),
        at("2026-07-11T01:08:34.000Z"),
        at("2026-08-10T00:00:00.000Z"),
        at("2026-09-01T00:00:00.000Z"),
      ]),
    ).toEqual({ newest: "2026-09-24T00:59:29.000Z", oldest: "2026-07-11T01:08:34.000Z" });
  });

  it("reports nothing for a page without dated posts", () => {
    expect(postSpan([])).toEqual({});
    expect(postSpan(undefined)).toEqual({});
    expect(postSpan([{ id: "1" }])).toEqual({});
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
