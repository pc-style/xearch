/**
 * The ranking constraints in docs/search-ranking.md, checked on real
 * results. Pure: scripts/ranking-check.mjs feeds it search responses from
 * `xearch-search query -`, and tests feed it fixtures.
 */

/** Unicode words, split as Tantivy's SimpleTokenizer does: on anything not a letter or digit. */
export function tokens(text) {
  return (text.match(/[\p{L}\p{N}]+/gu) ?? []).map((token) => token.toLowerCase());
}

/** What the author wrote: a reply without the @handles it starts with. */
export function body(row) {
  const text = row.text ?? "";

  return row.replyTo ? text.replace(/^\s*(@\w+\s*)+/u, "") : text;
}

/**
 * What a search may match: the body's words, each @handle as one word, and
 * the linked page's title — not a link's path or a piece of a handle.
 */
export function says(row) {
  const text = body(row)
    .replace(/https?:\/\/\S+/gu, " ")
    .replace(/(?<![\p{L}\p{N}_])@(\w+)/gu, (_, handle) => ` ${handle.replaceAll("_", "")}`);

  return tokens(`${text} ${row.card?.title ?? ""}`);
}

/** A searched word's spellings the engine also matches: plural or singular. */
function forms(term) {
  const out = new Set([term]);

  if (term.length >= 3 && /^[a-z]+$/u.test(term)) {
    const endings = [
      [true, `${term}s`],
      [true, `${term}es`],
      [term.endsWith("s"), term.slice(0, -1)],
      [term.endsWith("es"), term.slice(0, -2)],
      [term.endsWith("ies"), `${term.slice(0, -3)}y`],
      [term.endsWith("y"), `${term.slice(0, -1)}ies`],
    ];

    for (const [applies, form] of endings) if (applies) out.add(form);
  }

  return out;
}

/** Engagement as the prior weighs it (search/crates/ranking `prior`). */
export function weighted(row) {
  const count = (key) => row[key] ?? 0;

  return (
    count("likes") +
    2 * count("replies") +
    2 * count("bookmarks") +
    3 * count("reposts") +
    4 * count("quotes")
  );
}

/** Likes, replies, reposts and quotes: what "quiet" is measured in. */
export function engagement(row) {
  return ["likes", "replies", "reposts", "quotes"].reduce((sum, key) => sum + (row[key] ?? 0), 0);
}

/** Under three words of its own and nothing attached (search/crates/ranking `is_thin`). */
export function thin(row) {
  if (row.media?.length || row.card || row.quote) return false;

  const words = body(row)
    .split(/\s+/u)
    .filter(
      (word) => !word.startsWith("@") && !word.startsWith("http") && /[\p{L}\p{N}]/u.test(word),
    );

  return words.length < 3;
}

/** Whether the post has the searched words side by side, exactly as typed. */
export function sideBySide(row, terms) {
  const words = tokens(body(row));

  for (let start = 0; start + terms.length <= words.length; start++)
    if (terms.every((term, offset) => words[start + offset] === term)) return true;

  return false;
}

/**
 * How many times more engagement a scattered match needs to rank above one
 * with the words side by side, per mode (search/crates/ranking `phrase`).
 */
export const PHRASE_WORTH = { relevance: 30, engagement: 10 };

/** Engagement below this is quiet (search/crates/ranking `QUIET_PRIOR`). */
const QUIET = 3;

/**
 * Every constraint broken by one query's first page (20 rows, of which the
 * top 10 are judged and the rest are what could have replaced them).
 */
export function violations(query, sort, rows) {
  const terms = tokens(query);
  const top = rows.slice(0, 10);
  const rest = rows.slice(10, 20);
  const found = [];
  const close = (row) => terms.length < 2 || sideBySide(row, terms);

  for (const row of top) {
    const words = new Set(says(row));

    if (!terms.every((term) => [...forms(term)].some((form) => words.has(form))))
      found.push({ constraint: "says", row });
  }

  // A quiet post is avoidable when a better-engaged one that matches at
  // least as closely waits below it.
  const better = rest.filter((row) => engagement(row) >= QUIET);

  const avoidable = top.filter(
    (row) => engagement(row) < QUIET && better.some((other) => close(other) || !close(row)),
  );

  for (const row of avoidable.slice(0, better.length)) found.push({ constraint: "quiet", row });
  const full = rest.filter((row) => !thin(row));

  for (const row of top.filter(thin).slice(0, full.length)) found.push({ constraint: "thin", row });

  if (terms.length > 1)
    top.forEach((row, rank) => {
      if (sideBySide(row, terms)) return;

      const below = top
        .slice(rank + 1)
        .find(
          (other) =>
            sideBySide(other, terms) &&
            weighted(row) + 1 < PHRASE_WORTH[sort] * (weighted(other) + 1),
        );

      if (below) found.push({ constraint: "phrase", row, below });
    });

  return found;
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * Violations per constraint and mode for each group of queries, how much
 * the two modes' top 10s overlap, and the median engagement of each.
 * `results` maps `${sort}\n${query}` to that search's rows.
 */
export function report(groups, results) {
  const out = {};

  for (const [group, queries] of Object.entries(groups)) {
    const counts = {};
    const overlaps = [];
    const medians = { relevance: [], engagement: [] };

    for (const query of queries) {
      const tops = {};

      for (const sort of ["relevance", "engagement"]) {
        const rows = results.get(`${sort}\n${query}`) ?? [];

        tops[sort] = new Set(rows.slice(0, 10).map((row) => row.tweetId));

        if (rows.length) medians[sort].push(median(rows.slice(0, 10).map(weighted)));

        for (const { constraint } of violations(query, sort, rows))
          counts[`${sort} ${constraint}`] = (counts[`${sort} ${constraint}`] ?? 0) + 1;
      }

      const union = new Set([...tops.relevance, ...tops.engagement]);
      const both = [...tops.relevance].filter((id) => tops.engagement.has(id));

      if (union.size) overlaps.push(both.length / union.size);
    }

    out[group] = {
      queries: queries.length,
      ...counts,
      overlap: overlaps.length
        ? Math.round((overlaps.reduce((a, b) => a + b, 0) / overlaps.length) * 100) / 100
        : null,
      medianEngagement: {
        relevance: medians.relevance.length ? median(medians.relevance) : null,
        engagement: medians.engagement.length ? median(medians.engagement) : null,
      },
    };
  }

  return out;
}

/** Queries everyone tries, kept fixed so runs compare. */
export const COMMON = [
  "rust",
  "convex",
  "react server components",
  "typescript compiler",
  "bun",
  "nextjs",
  "ai",
  "local first",
  "open source",
  "claude code",
  "vibe coding",
  "ssd",
  "database",
  "tailwind",
  "javascript",
  "postgres",
  "startup",
  "ML rust",
  "cursor",
  "vercel",
];

const STOP = new Set(
  `a an the and or but if of to in on at for with by from as is are was were be been it its this
  that these those i you he she we they me my your our their not no so do does did just like get
  got im can will would should could have has had what when where who how why all any some more
  most very really about into out up down over than then there here also only rt amp`.split(/\s+/u),
);

/** A small seeded generator, so a sample is the same on every run. */
function random(seed) {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;

    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);

    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Random words and two-word phrases from post texts: words used 20 to 2,000
 * times and phrases used 8 to 400 times, so each has a page of matches.
 */
export function sample(texts, { count = 120, seed = 7 } = {}) {
  const words = new Map();
  const pairs = new Map();
  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

  for (const text of texts) {
    const plain = text.toLowerCase().replace(/https?:\/\/\S+|@\w+/gu, " ");
    const found = plain.match(/[a-z][a-z0-9]+/gu) ?? [];

    found.forEach((word, index) => {
      if (STOP.has(word)) return;
      bump(words, word);
      const next = found[index + 1];

      if (next && !STOP.has(next)) bump(pairs, `${word} ${next}`);
    });
  }

  const next = random(seed);

  const pick = (map, low, high) => {
    const pool = [...map]
      .flatMap(([key, uses]) => (uses >= low && uses <= high ? [key] : []))
      .sort();

    for (let index = pool.length - 1; index > 0; index--) {
      const other = Math.floor(next() * (index + 1));

      [pool[index], pool[other]] = [pool[other], pool[index]];
    }

    return pool.slice(0, count);
  };

  return { common: COMMON, words: pick(words, 20, 2000), phrases: pick(pairs, 8, 400) };
}
