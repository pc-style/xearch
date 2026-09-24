// Pure ranking for automatic account discovery. No I/O: the script feeds it
// posts from the raw captures on disk and the sets it read from Convex, and
// it returns who the indexed accounts interact with most. Tested directly.

const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

/** A normalised handle, or null when the value is not one. */
export function normalizeHandle(value) {
  // No `typeof`: the same string test scripts/backfill-accounts.mjs uses.
  if (Object.prototype.toString.call(value) !== "[object String]") return null;

  const handle = value.trim().replace(/^@/, "");

  return HANDLE.test(handle) ? handle.toLowerCase() : null;
}

/**
 * Every handle one post interacts with: reply targets, the quoted post's
 * author, @mentions in the text, and the reposted author (when the post was
 * reposted by an indexed account, the original author is the interaction).
 */
export function interactionsOf(post) {
  const out = new Set();

  const add = (value) => {
    const handle = normalizeHandle(value);

    if (handle) out.add(handle);
  };

  for (const target of Array.isArray(post.replying_to) ? post.replying_to : [])
    add(target?.screen_name);
  add(post.quote?.author?.screen_name);

  for (const facet of post.raw_text?.facets ?? [])
    if (facet?.type === "mention") add(facet.original);

  if (Array.isArray(post.reposted_by) && post.reposted_by.length) add(post.author?.screen_name);

  return out;
}

/**
 * Rank accounts by how many posts from indexed accounts interact with them.
 * `indexed` are the handles already in the library; `exclude` are handles a
 * bulk import already exists for (any state). Only posts authored by an
 * indexed account count, and a post reposted by an indexed account counts
 * for that reposter as one interaction with the original author only.
 */
export function rankInteractions(posts, { indexed, exclude, minInteractions }) {
  const indexedSet = new Set([...indexed].map((h) => h.toLowerCase()));
  const excludeSet = new Set([...exclude].map((h) => h.toLowerCase()));
  const counts = new Map();

  for (const post of posts) {
    const author = normalizeHandle(post?.author?.screen_name);

    const reposters = (Array.isArray(post?.reposted_by) ? post.reposted_by : [])
      .map((r) => normalizeHandle(r?.screen_name))
      .filter((h) => h && indexedSet.has(h));

    const authored = Boolean(author && indexedSet.has(author));
    const sources = authored ? [author] : reposters;

    if (!sources.length) continue;

    // A reposter only interacted with the original author; the post's own
    // replies and mentions are the author's, not the reposter's.
    const targets = authored ? interactionsOf(post) : new Set(author ? [author] : []);

    for (const from of sources) {
      for (const target of targets) {
        if (target === from || indexedSet.has(target) || excludeSet.has(target)) continue;
        const entry = counts.get(target) ?? { handle: target, interactions: 0, from: new Map() };
        entry.interactions += 1;
        entry.from.set(from, (entry.from.get(from) ?? 0) + 1);
        counts.set(target, entry);
      }
    }
  }

  return [...counts.values()]
    .filter((entry) => entry.interactions >= minInteractions)
    .sort((a, b) => b.interactions - a.interactions || a.handle.localeCompare(b.handle))
    .map((entry) => ({
      handle: entry.handle,
      interactions: entry.interactions,
      discoveredFrom: [...entry.from.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([handle, interactions]) => ({ handle, interactions })),
    }));
}

/** The x.md posts inside one retained capture file, whatever shape it has. */
export function postsInCapture(capture) {
  const out = [];

  for (const record of Array.isArray(capture?.records) ? capture.records : []) {
    const payload = record?.payload;

    if (Array.isArray(payload?.posts)) out.push(...payload.posts);
    else if (payload?.post instanceof Object) out.push(payload.post);
  }

  return out;
}
