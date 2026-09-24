import { describe, expect, it } from "vitest";
import {
  keyLinkifySegments,
  linkifyText,
  shortenUrlForDisplay,
  truncateSegments,
  type LinkifySegment,
} from "../src/linkify";

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

  it("keeps a closing paren that has a matching opening one inside the URL", () => {
    const segments = linkifyText("See https://en.wikipedia.org/wiki/Mercury_(planet) for more.");
    expect(segments).toEqual([
      { type: "text", value: "See " },
      {
        type: "link",
        href: "https://en.wikipedia.org/wiki/Mercury_(planet)",
        label: "en.wikipedia.org/wiki/Mercury_(planet)",
      },
      { type: "text", value: " for more." },
    ]);
  });

  it("still strips a genuinely trailing paren the URL itself doesn't own", () => {
    const segments = linkifyText("(see https://example.com/page)");
    expect(segments).toEqual([
      { type: "text", value: "(see " },
      { type: "link", href: "https://example.com/page", label: "example.com/page" },
      { type: "text", value: ")" },
    ]);
  });

  it("only restores as many closing parens as the URL has unmatched opens", () => {
    // Two unmatched "(" inside the URL, three trailing ")" — only two come
    // back onto the href; the third is genuinely the surrounding text's.
    const segments = linkifyText("https://example.com/a(b(c)))");
    const link = segments.find((s) => s.type === "link");
    expect(link).toEqual({
      type: "link",
      href: "https://example.com/a(b(c))",
      label: "example.com/a(b(c))",
    });
  });
});

describe("truncateSegments", () => {
  it("returns everything unchanged when under the cap", () => {
    const segments: LinkifySegment[] = [{ type: "text", value: "short" }];
    expect(truncateSegments(segments, 100)).toEqual(segments);
  });

  it("cuts a text segment and appends an ellipsis, never touching a link", () => {
    const segments: LinkifySegment[] = [
      { type: "text", value: "a".repeat(10) },
      { type: "link", href: "https://example.com/long/path", label: "example.com/long/path" },
    ];

    const result = truncateSegments(segments, 5);
    expect(result).toEqual([
      { type: "text", value: "aaaaa" },
      { type: "text", value: "…" },
    ]);
  });

  it("drops a link segment whole rather than cutting its href", () => {
    const segments: LinkifySegment[] = [
      { type: "text", value: "see " },
      { type: "link", href: "https://example.com/a-very-long-path", label: "example.com/a-very" },
    ];

    const result = truncateSegments(segments, 4);
    expect(result).toEqual([
      { type: "text", value: "see " },
      { type: "text", value: "…" },
    ]);
    expect(result.some((s) => s.type === "link")).toBe(false);
  });

  it("keeps a link segment whole when it fits exactly at the cap", () => {
    const segments: LinkifySegment[] = [
      { type: "link", href: "https://x.com/a", label: "x.com/a" },
    ];

    expect(truncateSegments(segments, "x.com/a".length)).toEqual(segments);
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
