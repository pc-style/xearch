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
// example.com. (with the period). Exported so `src/webContextText.ts` uses
// this exact set rather than its own copy that could drift.
export const TRAILING_PUNCTUATION = /[.,;:!?'")\]]+$/;

const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;

export interface RestoredParens {
  readonly raw: string;
  readonly trailing: string;
}

/**
 * Put back a stripped closing ")" for every unmatched "(" still inside the
 * URL — a Wikipedia-style link like `…/Mercury_(planet)` would otherwise
 * lose its closing paren to `TRAILING_PUNCTUATION` and point at a URL that
 * doesn't exist (`…/Mercury_(planet`).
 */
export function restoreBalancedParens(raw: string, trailing: string): RestoredParens {
  let restoredRaw = raw;
  let remainingTrailing = trailing;

  while (remainingTrailing.startsWith(")")) {
    const opens = (restoredRaw.match(/\(/g) ?? []).length;
    const closes = (restoredRaw.match(/\)/g) ?? []).length;

    if (opens <= closes) break;
    restoredRaw += ")";
    remainingTrailing = remainingTrailing.slice(1);
  }

  return { raw: restoredRaw, trailing: remainingTrailing };
}

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
      ({ raw, trailing } = restoreBalancedParens(raw, trailing));
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

/**
 * Truncate already-linkified segments to roughly `maxChars` of plain text
 * without cutting through a link segment. Cutting a `href` mid-string (as
 * slicing the raw text before linkifying would do whenever a URL crosses
 * the cutoff) turns a real link into a broken one; this only ever shortens
 * a `text` segment, and appends "…" as one more text segment.
 */
export function truncateSegments(
  segments: readonly LinkifySegment[],
  maxChars: number,
): LinkifySegment[] {
  const out: LinkifySegment[] = [];
  let used = 0;

  for (const segment of segments) {
    const length = segment.type === "link" ? segment.label.length : segment.value.length;

    if (used + length <= maxChars) {
      out.push(segment);
      used += length;
      continue;
    }

    if (segment.type === "text") {
      const remaining = maxChars - used;

      if (remaining > 0) out.push({ type: "text", value: segment.value.slice(0, remaining) });
    }

    out.push({ type: "text", value: "…" });

    return out;
  }

  return out;
}
