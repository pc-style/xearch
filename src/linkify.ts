/**
 * Turn bare http(s) URLs inside plain post text into clickable segments.
 *
 * Pure and framework-free on purpose: `src/ResultsSection.tsx` renders the
 * `link` segments as real anchors, but the splitting/shortening logic is
 * worth unit-testing without mounting a component. This only recognizes
 * bare URLs — `post.links` (rendered separately, unaffected by this file)
 * remains the source of truth for link metadata the search API already
 * extracted.
 */

export interface LinkifyTextSegment {
  readonly type: "text";
  readonly value: string;
}
export interface LinkifyLinkSegment {
  readonly type: "link";
  readonly href: string;
  readonly label: string;
}
export type LinkifySegment = LinkifyTextSegment | LinkifyLinkSegment;

// Trailing characters that are almost always punctuation closing a
// sentence/parenthetical rather than part of the URL itself. Left out of
// the match so "see https://example.com." links to example.com, not
// example.com. (with the period).
const TRAILING_PUNCTUATION = /[.,;:!?'")\]]+$/;
const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;

/** Shorten a URL for display: hostname + path, capped, no scheme/query noise. */
export function shortenUrlForDisplay(href: string, maxLength = 40): string {
  let display: string;
  try {
    const url = new URL(href);
    display = `${url.hostname}${url.pathname}`.replace(/\/$/, "");
  } catch {
    display = href.replace(/^https?:\/\//, "");
  }
  if (display.length <= maxLength) return display;
  return `${display.slice(0, maxLength - 1)}…`;
}

export interface KeyedLinkifySegment {
  readonly key: string;
  readonly segment: LinkifySegment;
}

/**
 * Pair each segment with a stable React key derived from its running
 * character offset (segments never overlap, so the offset a segment starts
 * at is already unique) rather than its array index — kept in this
 * component-free module so the accumulator here isn't a render-scope
 * variable a lint rule (or React Compiler) needs to reason about.
 */
export function keyLinkifySegments(segments: readonly LinkifySegment[]): KeyedLinkifySegment[] {
  let offset = 0;
  return segments.map((segment) => {
    const key = `${segment.type}-${offset}`;
    offset += segment.type === "link" ? segment.href.length : segment.value.length;
    return { key, segment };
  });
}

export function linkifyText(text: string): LinkifySegment[] {
  const segments: LinkifySegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    let raw = match[0];
    const trailingMatch = raw.match(TRAILING_PUNCTUATION);
    let trailing = "";
    if (trailingMatch) {
      trailing = trailingMatch[0];
      raw = raw.slice(0, raw.length - trailing.length);
    }
    if (!raw) continue;
    if (start > cursor) segments.push({ type: "text", value: text.slice(cursor, start) });
    segments.push({ type: "link", href: raw, label: shortenUrlForDisplay(raw) });
    cursor = start + raw.length;
    if (trailing) {
      segments.push({ type: "text", value: trailing });
      cursor += trailing.length;
    }
  }
  if (cursor < text.length) segments.push({ type: "text", value: text.slice(cursor) });
  return segments;
}
