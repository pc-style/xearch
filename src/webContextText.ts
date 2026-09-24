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
  truncateSegments,
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

// Matches the *start* of either a Markdown link (up to and including its
// opening "(") or a bare URL. A Markdown link's href is scanned separately
// by `scanBalancedHref` below rather than captured by this regex: a fixed
// character class like `[^\s)]+` can't tell a URL-owned ")" (as in
// `Mercury_(planet)`) from the one that closes the Markdown link syntax
// itself, so it always picks the first ")" — wrong for either case.
const INLINE_START = /\[([^\]]*)\]\(|https?:\/\/[^\s<>"']+/g;

const HEADING_PREFIX = /^#{1,6}\s+/;

const BULLET_PREFIX = /^(?:[-*+]|\d+\.)\s+/;

const BLOCKQUOTE_PREFIX = /^>+\s?/;

// Matches only the *start* of a Markdown image, up through its opening "(":
// the same reasoning as `INLINE_START` above applies — a fixed `[^)]*`
// class would stop at the first ")", leaving the rest of an image URL like
// `https://example.com/a(b).png)` behind as stray text.
const IMAGE_START = /!\[[^\]]*\]\(/g;

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

/**
 * From `start` (just after a Markdown link's opening "("), scan for the
 * matching closing ")", counting nested parens so a URL like
 * `Mercury_(planet)` doesn't end the href at its own inner ")". Bails on
 * whitespace/newlines — a real href never contains them — so malformed or
 * unterminated input falls back to being treated as plain text rather than
 * consuming the rest of the document.
 */
function scanBalancedHref(text: string, start: number): { href: string; end: number } | null {
  let depth = 1;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;

      if (depth === 0) return { href: text.slice(start, i), end: i + 1 };
    } else if (ch === " " || ch === "\n" || ch === "\t") return null;
  }

  return null;
}

/**
 * Remove every complete Markdown image (`![alt](url)`), scanning each url
 * for its matching closing ")" the same way `scanBalancedHref` does for
 * links, instead of stopping at the first ")". A malformed/unterminated
 * image is left in place rather than swallowing the rest of the document.
 */
function stripMarkdownImages(text: string): string {
  let result = "";
  let cursor = 0;

  IMAGE_START.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = IMAGE_START.exec(text))) {
    const start = match.index;
    const hrefStart = IMAGE_START.lastIndex;
    const parsed = scanBalancedHref(text, hrefStart);

    if (!parsed) continue; // unterminated image target; leave it as plain text

    result += text.slice(cursor, start);
    cursor = parsed.end;
    IMAGE_START.lastIndex = cursor;
  }

  result += text.slice(cursor);

  return result;
}

function parseInlineSegments(text: string): WebContextSegment[] {
  const segments: WebContextSegment[] = [];
  let cursor = 0;
  INLINE_START.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = INLINE_START.exec(text))) {
    const start = match.index;
    const mdLabel = match[1];

    if (mdLabel !== undefined) {
      const hrefStart = INLINE_START.lastIndex;

      const isHttp =
        text.startsWith("http://", hrefStart) || text.startsWith("https://", hrefStart);

      const parsed = isHttp ? scanBalancedHref(text, hrefStart) : null;

      if (!parsed) continue; // not a well-formed http(s) Markdown link; leave as plain text

      if (start > cursor) segments.push({ type: "text", value: text.slice(cursor, start) });
      segments.push({
        type: "link",
        href: parsed.href,
        label: mdLabel || shortenUrlForDisplay(parsed.href),
      });
      cursor = parsed.end;
      INLINE_START.lastIndex = cursor;
      continue;
    }

    // Bare URL.
    let href = match[0];
    const trailingMatch = href.match(TRAILING_PUNCTUATION);
    let trailing = "";

    if (trailingMatch) {
      trailing = trailingMatch[0];
      href = href.slice(0, href.length - trailing.length);
      // Keep a closing ")" that the URL's own path needs, e.g.
      // `…/Mercury_(planet)` — otherwise it's stripped as trailing
      // punctuation and the link points at a URL that doesn't exist.
      ({ raw: href, trailing } = restoreBalancedParens(href, trailing));
    }

    if (!href) continue;

    if (start > cursor) segments.push({ type: "text", value: text.slice(cursor, start) });
    segments.push({ type: "link", href, label: shortenUrlForDisplay(href) });
    cursor = start + href.length;

    if (trailing) {
      segments.push({ type: "text", value: trailing });
      cursor += trailing.length;
    }

    INLINE_START.lastIndex = cursor;
  }

  if (cursor < text.length) segments.push({ type: "text", value: text.slice(cursor) });

  return segments.length ? segments : [{ type: "text", value: text }];
}

/** Convert Firecrawl's Markdown-ish dump into paragraphs of text/link segments. */
export function parseWebContextMarkdown(markdown: string): WebContextParagraph[] {
  const withoutImages = stripMarkdownImages(markdown);
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
 * Keep whole paragraphs up to `maxChars` of plain text. Always shows at
 * least some of the first paragraph, even if it alone exceeds the cap: an
 * oversized first paragraph is truncated at the segment level (links stay
 * whole — see `truncateSegments`) rather than shown in full, so the
 * collapsed preview never exceeds `maxChars` regardless of how Firecrawl
 * broke its response into paragraphs. The full paragraph is still what a
 * caller re-parses for the expanded view — this only ever affects the
 * collapsed one.
 */
export function truncateWebContextParagraphs(
  paragraphs: readonly WebContextParagraph[],
  maxChars: number,
): TruncatedWebContext {
  const shown: WebContextParagraph[] = [];
  let used = 0;

  for (const paragraph of paragraphs) {
    const length = paragraphLength(paragraph);

    if (shown.length > 0 && used + length > maxChars) {
      return { shown, truncated: true };
    }

    if (used + length > maxChars) {
      // The very first paragraph alone already exceeds the cap: cut it at
      // a segment boundary instead of showing it whole.
      shown.push({ key: paragraph.key, segments: truncateSegments(paragraph.segments, maxChars) });

      return { shown, truncated: true };
    }

    shown.push(paragraph);
    used += length;

    if (used >= maxChars) {
      return { shown, truncated: shown.length < paragraphs.length };
    }
  }

  return { shown, truncated: false };
}
