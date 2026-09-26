# How results are ranked

"Relevant" and "Relevant + engagement" both score a matching post from three
signals, multiplied together (added in log space). The code is
`search/crates/ranking/src/lib.rs`; the weights were tuned by hand on a copy of
the production index (September 25, 2026).

| Signal    | What it is                                                                                                  | Relevant   | Relevant + engagement |
| --------- | ----------------------------------------------------------------------------------------------------------- | ---------- | --------------------- |
| Text      | Tantivy BM25, plus a phrase bonus when the searched words sit side by side                                  | BM25^0.6   | BM25^0.8              |
| Prior     | 1 + likes + 2·replies + 2·bookmarks + 3·reposts + 4·quotes; a reply to someone else counts ⅓, a thin post ⅒ | prior^0.15 | prior^0.35            |
| Freshness | Up to +15% (+10%) for a post made now, falling to a third after 30 days                                     | ×1.15 max  | ×1.10 max             |

Two more signals come from the whole index rather than one post (see
"Borrowed from Google and X" below): the author's authority, weighted 0.03
on a log scale, and a diversity pass over the best 100 results.

Queries that only filter (`@theo` on its own) have no text score, so the prior
and freshness decide.

## Why not plain BM25

Every searched word is required, so among posts that match, BM25 mostly
measures how short a post is and how often it repeats the word. Before this
change "SSD @theo" ranked "@imPatrickT External SSD recording too pls" (2
likes) second and the 6,000-like post about M5 Pro SSD speeds ninth. Research
on short-text retrieval makes the same point: length normalisation helps
little when every document is about the same length, as tweets are.

## Why multiply, not add

The previous "Relevant + engagement" added `relevance/(1+relevance)` and
`engagement/(1+engagement)`. Both saturate: a post with 100 engagements and
one with 10,000 differed by 0.016, so engagement barely moved the order, and
the 2-day freshness decay only ever helped the last 48 hours. Multiplying keeps
each signal a proportional nudge on the others whatever the query's BM25
scale. This is Elasticsearch's recommended way to fold popularity into BM25
(`function_score` with `field_value_factor`, `log1p` modifier and
`boost_mode: multiply`).

## Keeping quiet posts from crowding out good ones

Two rules keep posts nobody engaged with out of the top unless nothing better
matches:

- **A reply's leading @handles are not searched.** They are the reply chain,
  which X (and xearch) show as "Replying to", not words the author wrote.
  Searching "beyang" used to return a wall of "@beyang omg." and
  "@beyang BORB" replies; now it finds posts that say "beyang". Handles later
  in the text still match.
- **A thin post counts a tenth.** Under three words once links and @handles
  are left out, with no photo, video, link preview or quote: "lol", "💀", a
  bare link. BM25 rates these highest because they are shortest. A viral one
  still ranks.

On 150 random words from the corpus, the number of top-10 results with under
3 engagements (likes, replies, reposts and quotes together), and how many of
those a better-engaged match further down could have replaced:

| Ranking                  | Relevant: low / avoidable | Relevant + engagement: low / avoidable |
| ------------------------ | ------------------------- | -------------------------------------- |
| Before (additive blend)  | 309 / 193                 | 113 / 7                                |
| Multiplicative score     | 112 / 19                  | 102 / 10                               |
| Plus the two rules above | 62 / 15                   | 53 / 6                                 |

What remains is mostly words with fewer than 20 matches, where the top 10
has to include quiet posts. About 2% of posts, mostly from before 2017, start
with @handles but carry no reply metadata; they are treated as ordinary posts,
because some of them name the handle as the subject ("@PakHei_Yeung will be
presenting…").

## Borrowed from Google and X

Google publishes the systems its ranking uses; X open-sourced its
recommendation code. Four of them fit an archive of posts:

- **PageRank / link analysis** (Google) and **TweepCred** (X, `PageRank` over
  who interacts with whom): each account's authority is `PageRank` over
  replies (weight 1), quotes (2) and mentions in the author's own words
  (0.5), each pair's total dampened to `ln(1 + weight)` so replying to one
  account a hundred times is not a hundred votes. On the archive's 40,708
  accounts it ranks @bunjavascript, @theo, @convex, @planetscale and
  @huggingface highest. It is only a tiebreaker (weight 0.03, so the most
  cited author's post scores about 1.16 times an average author's): the
  archive holds a few dozen captured accounts that cite each other, and at
  0.08 their one-word posts outranked others' launch posts.
- **Site diversity** (Google shows about two results per site; X multiplies
  each further post by one author by 0.5, down to 0.25): among the best 100
  results, each further post by the same author loses 0.15 in log score,
  down to 0.45 (a factor of 0.86, down to 0.64). A quiet post (under about
  three likes' worth of engagement) never rises past one ranked above it:
  diversity makes room for other voices, not for posts nobody engaged with.
  A search for one author keeps its order.
- **Deduplication** (Google): a post saying word for word what a
  better-ranked one says (ignoring case, links and @handles) loses a factor
  of four.
- **Anchor text** (links describe what they point to): results show the two
  best posts in the index quoting them, under "Quoted by".

The reordered window is fixed at 100, so every page of a search is cut from
the same order and pages never repeat or skip a post.

These signals are computed by a Tantivy warmer whenever the reader loads new
segments, before searches see them; the server reloads in the background, so
no search waits. Each stored post is read once per process (0.7 seconds for
193,000 posts); a merge re-reads and hashes posts but reuses what it parsed.

On 146 random words from the corpus and 20 common queries, against the
previous ranking on the same index:

| Top 10s                                   | Before |    After |
| ----------------------------------------- | -----: | -------: |
| Low-engagement posts, Relevant (random)   |     62 |       60 |
| Avoidable low-engagement posts, Relevant  |     15 |       13 |
| Distinct authors (common queries)         |   6.65 |     8.45 |
| Most posts by one author (common queries) |   3.45 |     1.90 |
| Word-for-word duplicates (all queries)    |      5 |        0 |
| Random-word searches with a quoted result |      — | 83 / 146 |

Not borrowed: NavBoost (Google's click signals; xearch records no clicks)
and query-deserves-freshness (a boost for queries with a burst of recent
posts), which a later change could add.

## Matching

- A word also matches its plural or singular (`ssd` finds "SSDs",
  `batteries` finds "battery"), with the exact spelling scoring higher. There
  is no stemming, so `run` does not match `running`. Quoted words stay exact.
  This is done when the query is built, so it needs no reindex.
- Words typed side by side score higher when they appear side by side, without
  changing which posts match (`local first` puts "local-first" posts above one
  that says "local" in one sentence and "first" in another).
- The first page of a search reports how many posts match in all, shown as
  "20 of 43 posts".

## What needs a reindex

The prior and the searched text are fixed per post when it is indexed, and so
are media, link cards, quoted posts and reply targets. Posts indexed before
this change keep their old prior (engagement without bookmarks or the reply
and thin penalties), stay searchable by their reply handles and have no embeds
until the index is rebuilt from `archive/`. The index schema is
unchanged, so the new binary serves the old index in the meantime. Rebuild
into a new directory and swap it in:

```sh
systemctl --user stop xearch-search-indexer
for f in "$BASE"/archive/*.json; do
  case "$f" in *.receipt.json) continue ;; esac
  xearch-search --index "$BASE/index.new" import --input "$f" --archive "$BASE/archive"
done
# stop xearch-search, move index.new over index, start both again
```

A full rebuild of the production archive (3,239 captures) took under two
minutes locally.

## Sources

- [BM25 ranking with multiplicative boosts in Elasticsearch](https://www.elastic.co/search-labs/blog/bm25-ranking-multiplicative-boosting-elasticsearch)
- [Elasticsearch function score: boosting by popularity](https://www.elastic.co/search-labs/blog/function-score-query-boosting-profit-popularity-elasticsearch)
- [Elasticsearch: The Definitive Guide, "Boosting by Popularity"](https://feliperohdee.gitbooks.io/elastic-search-definitive-guide/content/170_Relevance/45_Popularity.html)
- [Google: a guide to Search ranking systems](https://developers.google.com/search/docs/appearance/ranking-systems-guide) (PageRank, deduplication, site diversity, freshness)
- [X's TweepCred README](https://github.com/twitter/the-algorithm/blob/main/src/scala/com/twitter/graph/batch/job/tweepcred/README) (`PageRank` over the interaction graph, log-scaled)
- [X (Twitter) algorithm explained](https://adlibrary.com/guides/x-twitter-algorithm-explained) (author diversity: 0.5 per repeat, floor 0.25)
- [Earlybird: real-time search at Twitter](https://abkedia.medium.com/earlybird-real-time-search-at-twitter-a-summary-part-1-5aa68221ef85), which combines text score with static engagement signals and penalises replies
