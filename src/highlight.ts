// Which words to mark in a result, matched the way the search service
// matches them (search/crates/tantivy/src/lib.rs): a word is a run of
// letters and digits, lowercased; a plain word also matches its plural or
// singular; quoted words match exactly; words after "-" are excluded, so
// never in a result; "OR" and @handles are not words.

/** Words that end in "s" without being plurals of anything worth finding. */
const NOT_PLURAL = new Set([
  "news",
  "series",
  "species",
  "always",
  "perhaps",
  "sometimes",
  "whereas",
  "towards",
]);

const SIBILANT = ["s", "x", "z", "ch", "sh"];

/** The other number of `word` the search service also matches. Mirrors `word_forms`. */
export function wordForms(word: string): string[] {
  if (word.length < 3 || !/^[a-z]+$/.test(word) || NOT_PLURAL.has(word)) return [];

  if (word.endsWith("ies") && word.length > 4) return [`${word.slice(0, -3)}y`];

  if (word.endsWith("es") && SIBILANT.some((end) => word.slice(0, -2).endsWith(end)))
    return [word.slice(0, -2)];

  // A stem under three letters is a word like "its", "has" or "was".
  if (word.endsWith("s")) {
    const stem = word.slice(0, -1);

    if (stem.length >= 3 && !["s", "u", "i"].some((end) => stem.endsWith(end))) return [stem];
  }

  if (SIBILANT.some((end) => word.endsWith(end))) return [`${word}es`];

  if (word.endsWith("y") && !/[aeiou]$/.test(word.slice(0, -1))) return [`${word.slice(0, -1)}ies`];

  return [`${word}s`];
}

/**
 * Every word a query can match in a post, longest first. Single letters
 * are left out: marking every "a" helps no one.
 */
export function queryWords(query: string): string[] {
  const words = new Set<string>();

  for (const token of query.match(/-?"[^"]*"?|[^\s()"]+/g) ?? []) {
    if (token.startsWith("-") || token === "OR" || token.startsWith("@")) continue;

    // Operators (`from:theo`) filter; they are not words in the post.
    if (/^[a-z_]+:/i.test(token)) continue;
    const quoted = token.startsWith('"');

    for (const word of token.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
      if (word.length < 2) continue;
      words.add(word);

      if (!quoted) for (const form of wordForms(word)) words.add(form);
    }
  }

  return [...words].sort((a, b) => b.length - a.length);
}

/** A pattern marking whole query words (not "react" inside "reactive"), or null. */
export function highlightPattern(query: string): RegExp | null {
  const words = queryWords(query);

  if (!words.length) return null;

  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.join("|")})(?![\\p{L}\\p{N}])`, "giu");
}

// The last query's pattern. Every text segment of every row asks for the
// same query's pattern, so it is compiled once rather than per call.
let cache: { query: string; pattern: RegExp | null } | null = null;

/** Split `text` around the query's words so each match can be marked. */
export function highlightParts(text: string, query: string) {
  if (cache?.query !== query) cache = { query, pattern: highlightPattern(query) };
  const { pattern } = cache;

  if (!pattern) return [{ text, mark: false }];
  const parts: { text: string; mark: boolean }[] = [];
  let cursor = 0;

  // `matchAll` copies the pattern, so sharing one `g` regex is safe.
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;

    if (start > cursor) parts.push({ text: text.slice(cursor, start), mark: false });
    parts.push({ text: match[0], mark: true });
    cursor = start + match[0].length;
  }

  if (cursor < text.length) parts.push({ text: text.slice(cursor), mark: false });

  return parts;
}
