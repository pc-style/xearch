import { describe, expect, it } from "vitest";
import {
  paragraphLength,
  parseWebContextMarkdown,
  shortenUrlForDisplay,
  truncateWebContextParagraphs,
  type WebContextParagraph,
} from "../src/webContextText";

function plainText(paragraph: WebContextParagraph): string {
  return paragraph.segments.map((s) => (s.type === "link" ? s.label : s.value)).join("");
}

describe("parseWebContextMarkdown", () => {
  it("strips heading markers", () => {
    const paragraphs = parseWebContextMarkdown("### Anthropic\nSome company info");
    expect(paragraphs.map(plainText)).toEqual(["Anthropic", "Some company info"]);
  });

  it("drops image syntax entirely", () => {
    const paragraphs = parseWebContextMarkdown("Before ![alt text](https://x.com/img.png) after");
    expect(paragraphs).toHaveLength(1);
    expect(plainText(paragraphs[0])).toBe("Before after");
    expect(paragraphs[0].segments.some((s) => s.type === "link")).toBe(false);
  });

  it("turns a markdown link into a link segment with its own label", () => {
    const paragraphs = parseWebContextMarkdown(
      "See [our announcement](https://anthropic.com/news)",
    );
    const link = paragraphs[0].segments.find((s) => s.type === "link");
    expect(link).toEqual({
      type: "link",
      href: "https://anthropic.com/news",
      label: "our announcement",
    });
  });

  it("falls back to a shortened URL as the label when a markdown link has no text", () => {
    const paragraphs = parseWebContextMarkdown("[](https://anthropic.com/news/announcement)");
    const link = paragraphs[0].segments.find((s) => s.type === "link");
    expect(link?.type).toBe("link");
    if (link?.type === "link") expect(link.label).toBe("anthropic.com/news/announcement");
  });

  it("turns a bare URL into a link segment and keeps trailing punctuation as text", () => {
    const paragraphs = parseWebContextMarkdown("Visit https://example.com/page.");
    expect(paragraphs[0].segments).toEqual([
      { type: "text", value: "Visit " },
      { type: "link", href: "https://example.com/page", label: "example.com/page" },
      { type: "text", value: "." },
    ]);
  });

  it("unescapes markdown-escaped punctuation such as escaped dates", () => {
    const paragraphs = parseWebContextMarkdown("Posted on 2024\\-01\\-15\\.");
    expect(plainText(paragraphs[0])).toBe("Posted on 2024-01-15.");
  });

  it("converts a bullet list item into a bullet-prefixed paragraph", () => {
    const paragraphs = parseWebContextMarkdown("- first item\n- second item");
    expect(paragraphs.map(plainText)).toEqual(["• first item", "• second item"]);
  });

  it("collapses internal whitespace from wrapped lines into single spaces", () => {
    const paragraphs = parseWebContextMarkdown("line one\nline   two\ncontinued");
    expect(paragraphs).toHaveLength(1);
    expect(plainText(paragraphs[0])).toBe("line one line two continued");
  });

  it("drops blank lines and produces no empty paragraphs", () => {
    const paragraphs = parseWebContextMarkdown("first\n\n\n\nsecond");
    expect(paragraphs.map(plainText)).toEqual(["first", "second"]);
  });

  it("returns nothing for an empty or whitespace-only document", () => {
    expect(parseWebContextMarkdown("")).toEqual([]);
    expect(parseWebContextMarkdown("   \n\n  ")).toEqual([]);
  });
});

describe("truncateWebContextParagraphs", () => {
  const paragraph = (text: string, key: string): WebContextParagraph => ({
    key,
    segments: [{ type: "text", value: text }],
  });

  it("keeps everything when under the cap", () => {
    const paragraphs = [paragraph("short", "a"), paragraph("also short", "b")];
    const result = truncateWebContextParagraphs(paragraphs, 1000);
    expect(result).toEqual({ shown: paragraphs, truncated: false });
  });

  it("stops before a paragraph that would exceed the cap", () => {
    const paragraphs = [paragraph("a".repeat(50), "a"), paragraph("b".repeat(50), "b")];
    const result = truncateWebContextParagraphs(paragraphs, 60);
    expect(result.shown).toEqual([paragraphs[0]]);
    expect(result.truncated).toBe(true);
  });

  it("always keeps at least the first paragraph, even if it alone exceeds the cap", () => {
    const paragraphs = [paragraph("a".repeat(5000), "a"), paragraph("b", "b")];
    const result = truncateWebContextParagraphs(paragraphs, 100);
    expect(result.shown).toEqual([paragraphs[0]]);
    expect(result.truncated).toBe(true);
  });

  it("is not truncated when the last paragraph exactly fills the cap", () => {
    const paragraphs = [paragraph("a".repeat(10), "a")];
    const result = truncateWebContextParagraphs(paragraphs, 10);
    expect(result).toEqual({ shown: paragraphs, truncated: false });
  });
});

describe("paragraphLength", () => {
  it("counts link labels, not full hrefs", () => {
    const paragraph: WebContextParagraph = {
      key: "p",
      segments: [
        { type: "text", value: "see " },
        { type: "link", href: "https://example.com/a/very/long/path", label: "example.com/a" },
      ],
    };
    expect(paragraphLength(paragraph)).toBe("see ".length + "example.com/a".length);
  });
});

describe("shortenUrlForDisplay", () => {
  it("shows hostname and path without a trailing slash", () => {
    expect(shortenUrlForDisplay("https://example.com/")).toBe("example.com");
    expect(shortenUrlForDisplay("https://example.com/a/b")).toBe("example.com/a/b");
  });

  it("truncates long paths with an ellipsis", () => {
    const long = `https://example.com/${"a".repeat(80)}`;
    const label = shortenUrlForDisplay(long, 60);
    expect(label.length).toBe(60);
    expect(label.endsWith("…")).toBe(true);
  });
});
