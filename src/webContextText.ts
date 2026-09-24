/**
 * Turn the raw Markdown-ish text Firecrawl hands back for "Web context"
 * into something a person can actually read: real paragraphs, real links,
 * no leftover `#`/`![]()`/escape syntax. Pure and framework-free so the
 * parsing can be unit-tested without mounting the modal in `src/App.tsx`
 * that renders it.
 */
// Reused from src/linkify.ts rather than duplicated: a fix to one copy (the
// balanced-parenthesis handling there, for example) would otherwise never
// reach this file's copy.
import {
  restoreBalancedParens,
  shortenUrlForDisplay as shortenUrl,
  TRAILING_PUNCTUATION,
} from "./linkify";

export interface WebContextTextSegment {
  readonly type: "text";
  readonly value: string;
}
export interface WebContextLinkSegment {
  readonly type: "link";
  readonly href: string;
  readonly label: string;
}
export type WebContextSegment = WebContextTextSegment | WebContextLinkSegment;

export interface WebContextParagraph {
  readonly key: string;
  readonly segments: WebContextSegment[];
}

/** Shorten a URL for display: hostname + path, capped, no scheme/query noise. */
export function shortenUrlForDisplay(href: string, maxLength = 60): string {
  return shortenUrl(href, maxLength);
}

// Markdown link `[label](https://…)` or a bare URL, whichever comes first.
// The markdown-link href excludes ")" — it's bounded by the link syntax's
// own closing paren. The bare-URL alternative matches the same charset as
// `src/linkify.ts`'s `URL_PATTERN` (parens included), so a URL like
// `…/Mercury_(planet)` is captured whole and `restoreBalancedParens` below
// can tell a URL-owned ")" apart from one closing surrounding prose.
const INLINE_PATTERN = /\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"']+)/g;
const HEADING_PREFIX = /^#{1,6}\s+/;
const BULLET_PREFIX = /^(?:[-*+]|\d+\.)\s+/;
const BLOCKQUOTE_PREFIX = /^>+\s?/;
const IMAGE_MARKDOWN = /!\[[^\]]*\]\([^)]*\)/g;
// Markdown escapes a fixed set of punctuation with a leading backslash
// (Firecrawl does this for dates like `2024\-01\-15`); unescape all of them.
const ESCAPED_PUNCTUATION = /\\([\\`*_{}[\]()#+\-.!>])/g;

function stripBlockMarkers(block: string): string {
  let text = block.replace(HEADING_PREFIX, "");
  const bulletMatch = text.match(BULLET_PREFIX);
  if (bulletMatch) text = `• ${text.slice(bulletMatch[0].length)}`;
  return text;
}

function splitBlocks(markdown: string): string[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const joined = current.join(" ").trim();
    if (joined) blocks.push(joined);
    current = [];
  };
  for (const rawLine of lines) {
    // Stripped per line, not just at the start of the joined block: a
    // multi-line blockquote ("> first\n> second") would otherwise keep the
    // ">" on every line after the first once the lines are joined with " ".
    const line = rawLine.trim().replace(BLOCKQUOTE_PREFIX, "").trim();
    if (line === "") {
      flush();
      continue;
    }
    if (HEADING_PREFIX.test(line) || BULLET_PREFIX.test(line)) {
      flush();
      blocks.push(line);
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

function parseInlineSegments(text: string): WebContextSegment[] {
  const segments: WebContextSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const start = match.index ?? 0;
    const [whole, mdLabel, mdHref, bareHref] = match;
    let href = mdHref ?? bareHref ?? "";
    let label = mdHref !== undefined ? mdLabel || shortenUrlForDisplay(mdHref) : "";
    let matchedLength = whole.length;
    let trailing = "";
    if (bareHref !== undefined) {
      const trailingMatch = bareHref.match(TRAILING_PUNCTUATION);
      if (trailingMatch) {
        trailing = trailingMatch[0];
        href = bareHref.slice(0, bareHref.length - trailing.length);
        // Keep a closing ")" that the URL's own path needs, e.g.
        // `…/Mercury_(planet)` — otherwise it's stripped as trailing
        // punctuation and the link points at a URL that doesn't exist.
        ({ raw: href, trailing } = restoreBalancedParens(href, trailing));
        matchedLength = whole.length - trailing.length;
      }
      label = shortenUrlForDisplay(href);
    }
    if (!href) continue;
    if (start > cursor) segments.push({ type: "text", value: text.slice(cursor, start) });
    segments.push({ type: "link", href, label });
    cursor = start + matchedLength;
    if (trailing) {
      segments.push({ type: "text", value: trailing });
      cursor += trailing.length;
    }
  }
  if (cursor < text.length) segments.push({ type: "text", value: text.slice(cursor) });
  return segments.length ? segments : [{ type: "text", value: text }];
}

/** Convert Firecrawl's Markdown-ish dump into paragraphs of text/link segments. */
export function parseWebContextMarkdown(markdown: string): WebContextParagraph[] {
  const withoutImages = markdown.replace(IMAGE_MARKDOWN, "");
  const paragraphs: WebContextParagraph[] = [];
  let offset = 0;
  for (const rawBlock of splitBlocks(withoutImages)) {
    const cleaned = stripBlockMarkers(rawBlock)
      .replace(ESCAPED_PUNCTUATION, "$1")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) continue;
    const key = `p-${offset}`;
    offset += cleaned.length;
    paragraphs.push({ key, segments: parseInlineSegments(cleaned) });
  }
  return paragraphs;
}

/** Plain-text length of one paragraph (link labels count, not full hrefs). */
export function paragraphLength(paragraph: WebContextParagraph): number {
  return paragraph.segments.reduce(
    (n, segment) => n + (segment.type === "link" ? segment.label.length : segment.value.length),
    0,
  );
}

export interface KeyedWebContextSegment {
  readonly key: string;
  readonly segment: WebContextSegment;
}

/**
 * Pair each segment in a paragraph with a stable key derived from its
 * running offset within that paragraph, rather than its array index — kept
 * here (no JSX/React import in this module) so the running-offset
 * accumulator isn't a render-scope variable a lint rule needs to reason
 * about.
 */
export function keyWebContextSegments(paragraph: WebContextParagraph): KeyedWebContextSegment[] {
  let offset = 0;
  return paragraph.segments.map((segment) => {
    const key = `${paragraph.key}-${offset}`;
    offset += segment.type === "link" ? segment.label.length : segment.value.length;
    return { key, segment };
  });
}

export interface TruncatedWebContext {
  readonly shown: WebContextParagraph[];
  readonly truncated: boolean;
}

/**
 * Keep whole paragraphs up to `maxChars` of plain text. Always keeps at
 * least the first paragraph, even if it alone exceeds the cap, so a single
 * long paragraph can never collapse the preview to nothing.
 */
export function truncateWebContextParagraphs(
  paragraphs: readonly WebContextParagraph[],
  maxChars: number,
): TruncatedWebContext {
  const shown: WebContextParagraph[] = [];
  let used = 0;
  for (const paragraph of paragraphs) {
    if (shown.length > 0 && used + paragraphLength(paragraph) > maxChars) {
      return { shown, truncated: true };
    }
    shown.push(paragraph);
    used += paragraphLength(paragraph);
    if (used >= maxChars) {
      return { shown, truncated: shown.length < paragraphs.length };
    }
  }
  return { shown, truncated: false };
}
