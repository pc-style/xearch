import { describe, expect, it } from "vitest";
import {
  report,
  sample,
  says,
  sideBySide,
  thin,
  violations,
  type Row,
} from "../scripts/lib/rankingCheck.mjs";

let next = 0;

function row(text: string, likes: number, extra: Partial<Row> = {}): Row {
  next += 1;

  return { tweetId: String(next), text, likes, ...extra };
}

describe("what a result says", () => {
  it("counts its words, whole handles and its link's title, not link paths", () => {
    const words = says(
      row("ask @perplexity_ai, thanks @convex https://onepl.us/na_event6", 0, {
        card: { title: "Series B" },
      }),
    );

    expect(words).toEqual(["ask", "perplexityai", "thanks", "convex", "series", "b"]);
  });

  it("matches a searched word's plural or singular, as the engine does", () => {
    expect(violations("reaches", "relevance", [row("ready to reach orbit", 10)])).toEqual([]);
  });

  it("leaves out a reply's leading handles", () => {
    expect(says(row("@bob @carol nice one", 0, { replyTo: "bob" }))).toEqual(["nice", "one"]);
  });
});

describe("constraints", () => {
  it("flags a scattered match above a side-by-side one with similar engagement", () => {
    const scattered = row("typescript ships a new compiler", 300);
    const close = row("the typescript compiler is slow", 20);

    const found = violations("typescript compiler", "relevance", [scattered, close]);

    expect(found).toEqual([{ constraint: "phrase", row: scattered, below: close }]);
    // Over ten times the engagement is enough under "Relevant + engagement",
    // but not thirty under "Relevant".
    expect(violations("typescript compiler", "engagement", [scattered, close])).toEqual([]);
    expect(sideBySide(close, ["typescript", "compiler"])).toBe(true);
  });

  it("flags a quiet post only when a better-engaged, equally close match waits below", () => {
    const quiet = row("rust is fun", 0);
    const engaged = Array.from({ length: 9 }, (_, i) => row(`rust ${i} is fine`, 100));

    expect(violations("rust", "relevance", [quiet, ...engaged, row("rust is great", 40)])).toEqual([
      { constraint: "quiet", row: quiet },
    ]);
    // Nothing better waits below: the quiet post is the best there is.
    expect(violations("rust", "relevance", [quiet, ...engaged])).toEqual([]);
  });

  it("flags a thin post above a fuller one", () => {
    const lol = row("rust lol", 500);

    expect(thin(lol)).toBe(true);

    const found = violations("rust", "relevance", [
      lol,
      ...Array.from({ length: 9 }, (_, i) => row(`rust ${i} is fine`, 100)),
      row("rust compile times are fine", 100),
    ]);

    expect(found).toEqual([{ constraint: "thin", row: lol }]);
  });

  it("flags a result that matches only through a link or part of a handle", () => {
    const linked = row("launch https://onepl.us/na_event6", 10);

    expect(violations("na", "relevance", [linked])).toEqual([{ constraint: "says", row: linked }]);
  });
});

describe("report", () => {
  it("sums violations per mode and measures how much the modes agree", () => {
    const a = row("rust", 5);
    const b = row("rust is fast", 10);

    const results = new Map([
      ["relevance\nrust", [a, b]],
      ["engagement\nrust", [b]],
    ]);

    expect(report({ common: ["rust"] }, results)).toEqual({
      common: {
        queries: 1,
        overlap: 0.5,
        medianEngagement: { relevance: 7.5, engagement: 10 },
      },
    });
  });
});

describe("sample", () => {
  it("is the same on every run and skips links, handles and stop words", () => {
    const texts = Array.from({ length: 30 }, () => "@bob the convex database https://x.co/abc");
    const first = sample(texts, { count: 5 });

    expect(first).toEqual(sample(texts, { count: 5 }));
    expect(first.words.sort()).toEqual(["convex", "database"]);
    expect(first.phrases).toEqual(["convex database"]);
  });
});
