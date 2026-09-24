import { describe, expect, it } from "vitest";
import { keyLinkifySegments, linkifyText, shortenUrlForDisplay } from "../src/linkify";

describe("linkifyText", () => {
  it("returns the whole string as one text segment when there is no URL", () => {
    expect(linkifyText("no links here")).toEqual([{ type: "text", value: "no links here" }]);
  });

  it("splits text around a bare URL into text/link/text segments", () => {
    expect(linkifyText("see https://example.com/post for more")).toEqual([
      { type: "text", value: "see " },
      { type: "link", href: "https://example.com/post", label: "example.com/post" },
      { type: "text", value: " for more" },
    ]);
  });

  it("strips trailing sentence punctuation from the URL and keeps it as text", () => {
    expect(linkifyText("check https://round.t3.gg.")).toEqual([
      { type: "text", value: "check " },
      { type: "link", href: "https://round.t3.gg", label: "round.t3.gg" },
      { type: "text", value: "." },
    ]);
  });

  it("linkifies multiple URLs in the same text", () => {
    const text = "https://a.example/one and https://b.example/two";
    expect(linkifyText(text)).toEqual([
      { type: "link", href: "https://a.example/one", label: "a.example/one" },
      { type: "text", value: " and " },
      { type: "link", href: "https://b.example/two", label: "b.example/two" },
    ]);
  });

  it("handles a URL with no surrounding text", () => {
    expect(linkifyText("https://example.com")).toEqual([
      { type: "link", href: "https://example.com", label: "example.com" },
    ]);
  });
});

describe("keyLinkifySegments", () => {
  it("gives every segment a unique key based on its position, not array index", () => {
    const segments = linkifyText("https://a.example/one and https://b.example/two");
    const keyed = keyLinkifySegments(segments);
    const keys = keyed.map((k) => k.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keyed.map((k) => k.segment)).toEqual(segments);
  });
});

describe("shortenUrlForDisplay", () => {
  it("shows hostname and path without a trailing slash", () => {
    expect(shortenUrlForDisplay("https://example.com/")).toBe("example.com");
    expect(shortenUrlForDisplay("https://example.com/a/b")).toBe("example.com/a/b");
  });

  it("truncates long paths with an ellipsis", () => {
    const long = `https://example.com/${"a".repeat(60)}`;
    const label = shortenUrlForDisplay(long, 40);
    expect(label.length).toBe(40);
    expect(label.endsWith("…")).toBe(true);
  });

  it("falls back to stripping the scheme when the URL can't be parsed", () => {
    expect(shortenUrlForDisplay("https://not a url")).toBe("not a url");
  });
});
