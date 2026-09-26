// Result highlighting marks what the search service matched, and only that.
import { describe, expect, it } from "vitest";
import { highlightParts, highlightPattern, queryWords, wordForms } from "../src/highlight";

const marked = (text: string, query: string) =>
  highlightParts(text, query)
    .filter((part) => part.mark)
    .map((part) => part.text);

describe("wordForms mirrors the search service's plural matching", () => {
  it.each([
    ["ssd", ["ssds"]],
    ["ssds", ["ssd"]],
    ["battery", ["batteries"]],
    ["batteries", ["battery"]],
    ["box", ["boxes"]],
    ["boxes", ["box"]],
    ["day", ["days"]],
    ["news", []],
    ["bus", ["buses"]],
    ["ai", []],
    ["React", []],
  ])("%s → %j", (word, forms) => {
    expect(wordForms(word)).toEqual(forms);
  });
});

describe("queryWords", () => {
  it("skips exclusions, OR, handles and operators; quoted words stay exact", () => {
    expect(queryWords('ssd @theo -"hard drive" -hdd OR from:theo "boxes"').sort()).toEqual(
      ["boxes", "ssd", "ssds"].sort(),
    );
  });

  it("splits words the way the index does and keeps two-letter words", () => {
    expect(queryWords("next.js ai").sort()).toEqual(["ai", "js", "next", "nexts"].sort());
  });

  it("has nothing to mark for a filter alone", () => {
    expect(highlightPattern("@theo")).toBeNull();
  });
});

describe("highlightParts", () => {
  it("marks whole words, plurals included, not words containing them", () => {
    expect(marked("React is reactive; I use React.", "react")).toEqual(["React", "React"]);
    expect(marked("Two SSDs beat one ssd", "ssd")).toEqual(["SSDs", "ssd"]);
    expect(marked("AI said email", "ai")).toEqual(["AI"]);
  });

  it("marks nothing for excluded words", () => {
    expect(marked("rust and go", "go -rust")).toEqual(["go"]);
  });

  it("marks letters beyond ASCII", () => {
    expect(marked("Ça marche, café!", "café")).toEqual(["café"]);
  });
});
