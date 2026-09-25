# How results are ranked

"Relevant" and "Relevant + engagement" both score a matching post from three
signals, multiplied together (added in log space). The code is
`search/crates/ranking/src/lib.rs`; the weights were tuned by hand on a copy of
the production index (September 25, 2026).

| Signal    | What it is                                                                                   | Relevant   | Relevant + engagement |
| --------- | -------------------------------------------------------------------------------------------- | ---------- | --------------------- |
| Text      | Tantivy BM25, plus a phrase bonus when the searched words sit side by side                   | BM25^0.6   | BM25^0.8              |
| Prior     | 1 + likes + 2·replies + 2·bookmarks + 3·reposts + 4·quotes; a reply to someone else counts ⅓ | prior^0.15 | prior^0.35            |
| Freshness | Up to +15% (+10%) for a post made now, falling to a third after 30 days                      | ×1.15 max  | ×1.10 max             |

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

The prior is stored per post when it is indexed, and so are media, link cards,
quoted posts and reply targets. Posts indexed before this change keep their
old prior (engagement without bookmarks or the reply penalty) and have no
embeds until the index is rebuilt from `archive/`. The index schema is
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
- [Earlybird: real-time search at Twitter](https://abkedia.medium.com/earlybird-real-time-search-at-twitter-a-summary-part-1-5aa68221ef85), which combines text score with static engagement signals and penalises replies
