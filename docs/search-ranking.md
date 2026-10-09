# How results are ranked

"Relevant" and "Relevant + engagement" both score a matching post from four
signals, multiplied together (added in log space). The code is
`search/crates/ranking/src/lib.rs`; the weights were tuned on a copy of the
production index against the constraints below (October 9, 2026).

| Signal       | What it is                                                                                                  | Relevant   | Relevant + engagement |
| ------------ | ----------------------------------------------------------------------------------------------------------- | ---------- | --------------------- |
| Text         | Tantivy BM25                                                                                                | BM25^0.6   | BM25^0.4              |
| Side by side | The searched words appear together as typed (`local first`, `local-first`)                                  | ×2.0       | ×2.3                  |
| Prior        | 1 + likes + 2·replies + 2·bookmarks + 3·reposts + 4·quotes; a reply to someone else counts ⅓, a thin post ⅒ | prior^0.15 | prior^0.4             |
| Freshness    | Up to +15% (+10%) for a post made now, falling to a third after 30 days                                     | ×1.15 max  | ×1.10 max             |

Two more signals come from the whole index rather than one post (see
"Borrowed from Google and X" below): the author's authority, weighted 0.03
on a log scale, and a diversity pass over the best 100 results.

Queries that only filter (`@theo` on its own) have no text score, so the prior
and freshness decide.

## Constraints

What each mode promises, between two matching posts alike in everything
else. `search/crates/ranking` tests each one exactly (`mod constraints`), and
`search/crates/tantivy/tests/behavior.rs` checks them through a real index.

- **Engagement breaks ties.** More engagement ranks higher in both modes.
- **Relevant reads the words first.** The searched words side by side beat
  them scattered unless the scattered post has about a hundred times the
  engagement (at least thirty is promised). Twice the BM25 beats five times
  the engagement.
- **Relevant + engagement reads the room first.** Words side by side beat a
  scattered post with up to about eight times the engagement (at least
  three, at most ten). Five times the engagement beats twice the BM25.
- **A search matches what a post says**: its words, each @handle as one
  word (`convex` finds "@convex"), and the title of the page it links to.
  Not a link's path (`na` does not find `onepl.us/na_event6`) and not part
  of a handle (`ai` does not find "@perplexity_ai").
- **Quiet and thin posts wait their turn.** One under three engagements, or
  under three words with nothing attached, does not rank in the top 10 while
  a better-engaged match that is as close a match waits below it.

On the real corpus these hold most of the time, not always: BM25 still
varies between posts, and some random word pairs are not phrases anyone
types. `scripts/ranking-check.mjs` measures how often each is broken, on 20
common queries and 120 random words and 120 random two-word phrases sampled
from the archive (a fixed seed, so runs compare):

```sh
node scripts/ranking-check.mjs --index="$BASE/index" --archive="$BASE/archive" [--verbose]
```

It only reads. `--verbose` prints every result that breaks a constraint.
Before and after this change, on rebuilt copies of the production archive
(top-10 results breaking each constraint, Relevant / Relevant + engagement):

| Constraint (top 10s)                          | Common queries (20) | Random words (120) | Random phrases (120) |
| --------------------------------------------- | ------------------- | ------------------ | -------------------- |
| Scattered above side by side (before → after) | 3/4 → 0/5           | —                  | 161/149 → 87/74      |
| Matched only through a link or handle piece   | 5/6 → 0/0           | 30/26 → 0/0        | 9/12 → 0/0           |
| Avoidable quiet posts                         | 1/0 → 1/0           | 11/4 → 11/4        | 10/1 → 9/1           |
| Avoidable thin posts                          | 0/0 → 0/0           | 2/0 → 3/0          | 0/0 → 0/0            |
| Overlap of the two modes' top 10s             | 0.65 → 0.48         | 0.72 → 0.56        | 0.71 → 0.53          |
| Median engagement, Relevant + engagement      | 6,988 → 8,148       | 5,337 → 7,972      | 4,464 → 7,568        |

"Before" is the previous ranking on an index rebuilt with the previous
code; "after" is this ranking on one rebuilt with this code.
What still breaks the phrase constraint is a scattered match whose BM25 is
higher, or a word pair nobody would type as a phrase ("days now").

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
  that says "local" in one sentence and "first" in another). A fixed bonus,
  not more BM25: BM25 for a phrase mostly rewards the shortest posts that
  have it, which lifted one-line replies.
- Links are not searched, and a handle is searched whole (`@perplexity_ai`
  as "perplexityai"). A link card's title is searched with the post.
- The first page of a search reports how many posts match in all, shown as
  "20 of 43 posts".

## What needs a reindex

The prior and the searched text are fixed per post when it is indexed, and so
are media, link cards, quoted posts and reply targets. A post indexed before
a change to any of them keeps the old version until the index is rebuilt
from `archive/`; ranking weights and the side-by-side bonus apply at once.

The production index has not been rebuilt since the prior gained bookmarks
and the reply and thin penalties: the reindexes logged after that change
failed on the indexer's lock. Posts indexed before then still carry the
old prior, are found by their reply handles and have no embeds; with this
change they also keep links and handle pieces in their searched text. On
the rebuilt copy, `@theo convex` no longer puts the one-word reply
"@ccccjjjjeeee Convex" second.

The index schema is unchanged, so the new binary serves the old index in
the meantime. Rebuild into a new directory and swap it in:

```sh
systemctl --user stop xearch-search-indexer
for f in "$BASE"/archive/*.json; do
  case "$f" in *.receipt.json) continue ;; esac
  xearch-search --index "$BASE/index.new" import --input "$f" --archive "$BASE/archive"
done
# stop xearch-search, move index.new over index, start both again
```

Importing one capture per process, the production archive (9,746
captures, 239,000 posts, October 2026) took about a quarter of an hour on a
laptop. Then run `xearch-search --index "$BASE/index.new" compact`.

## Sources

- [BM25 ranking with multiplicative boosts in Elasticsearch](https://www.elastic.co/search-labs/blog/bm25-ranking-multiplicative-boosting-elasticsearch)
- [Elasticsearch function score: boosting by popularity](https://www.elastic.co/search-labs/blog/function-score-query-boosting-profit-popularity-elasticsearch)
- [Elasticsearch: The Definitive Guide, "Boosting by Popularity"](https://feliperohdee.gitbooks.io/elastic-search-definitive-guide/content/170_Relevance/45_Popularity.html)
- [Google: a guide to Search ranking systems](https://developers.google.com/search/docs/appearance/ranking-systems-guide) (PageRank, deduplication, site diversity, freshness)
- [X's TweepCred README](https://github.com/twitter/the-algorithm/blob/main/src/scala/com/twitter/graph/batch/job/tweepcred/README) (`PageRank` over the interaction graph, log-scaled)
- [X (Twitter) algorithm explained](https://adlibrary.com/guides/x-twitter-algorithm-explained) (author diversity: 0.5 per repeat, floor 0.25)
- [Earlybird: real-time search at Twitter](https://abkedia.medium.com/earlybird-real-time-search-at-twitter-a-summary-part-1-5aa68221ef85), which combines text score with static engagement signals and penalises replies
