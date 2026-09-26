//! Ranking signals, independent of retrieval.
//!
//! A result's score is built in log space from three parts:
//!
//! - **Text match**: Tantivy's BM25. Every searched word is required, so
//!   among tweets it mostly measures how short a tweet is and how often it
//!   repeats the word. On its own it puts one-line replies first.
//! - **Prior**: how much people engaged with the post, known when it is
//!   indexed (see [`prior`]).
//! - **Freshness**: a small lift for the last few weeks.
//!
//! Combining them multiplicatively (adding logs) keeps each one a
//! proportional nudge on the others, whatever the query's BM25 scale, which
//! is what additive blends of raw scores get wrong.
use search_model::Post;

/// How much less a reply to someone else is worth: its engagement counts as
/// if it had a third as much. Continuing one's own thread is not penalised.
const REPLY_PENALTY: f64 = 1.098_612_288_668_109_8; // ln(3)

/// How much less a post with almost nothing in it is worth ("lol", "💀", a
/// bare link): as if it had a tenth as much engagement. BM25 favours short
/// posts, and these are the shortest; anything gentler still lets "rust lol"
/// outrank "rust compile times are fine now" under "Relevant". A viral one
/// still ranks, as it should.
const THIN_PENALTY: f64 = core::f64::consts::LN_10;

/// Fewer words than this, with nothing attached, is a thin post.
const THIN_WORDS: usize = 3;

/// Whether a post says too little to be worth finding on its own: under
/// [`THIN_WORDS`] words (links and @handles don't count) and no photo,
/// video, link preview or quoted post.
#[must_use]
pub fn is_thin(post: &Post) -> bool {
    let words = post
        .body()
        .split_whitespace()
        .filter(|word| {
            !word.starts_with('@')
                && !word.starts_with("http")
                && word.chars().any(char::is_alphanumeric)
        })
        .take(THIN_WORDS)
        .count();
    words < THIN_WORDS && post.media.is_empty() && post.card.is_none() && post.quote.is_none()
}

/// The post's quality as far as the index can know it: log-weighted
/// engagement, less penalties for replying to someone else and for saying
/// almost nothing. Stored in the
/// `engagement` fast field.
///
/// Weights follow how much each action costs the person taking it: a like
/// is a tap; a bookmark or reply means they wanted it later or had something
/// to say; a repost or quote puts it in front of their own followers.
#[must_use]
pub fn prior(post: &Post) -> f64 {
    let count = |value: Option<u32>| f64::from(value.unwrap_or(0));
    let weighted = count(post.quotes).mul_add(
        4.0,
        count(post.reposts).mul_add(
            3.0,
            count(post.replies).mul_add(2.0, count(post.bookmarks).mul_add(2.0, count(post.likes))),
        ),
    );
    let reply = if post.replies_to_other() {
        REPLY_PENALTY
    } else {
        0.0
    };
    let thin = if is_thin(post) { THIN_PENALTY } else { 0.0 };
    weighted.ln_1p() - reply - thin
}

/// How the text match, prior and freshness are weighed against each other.
/// Only the ratio of `text` to `prior` shapes the order; tuned by hand on the
/// production corpus (see `docs/search-ranking.md`).
#[derive(Debug, Clone, Copy)]
pub struct Weights {
    /// Exponent on the BM25 score. Below one because among tweets a higher
    /// BM25 mostly means a shorter tweet, not a better match.
    pub text: f64,
    /// Exponent on (1 + weighted engagement): 0.1 makes a post with 1,000
    /// engagements score twice one with none.
    pub prior: f64,
    /// Largest freshness lift, for a post made just now.
    pub fresh: f64,
    /// Weight on the author's [`authority`], a log scale where an average
    /// author is 0 and the most cited are about 5: 0.03 makes a post by the
    /// most cited author score about 1.16 times one by an average author.
    /// A tiebreaker: the archive's captured accounts cite each other, so
    /// more lets their one-word posts outrank others' launches.
    pub authority: f64,
}

/// "Relevant": how well the words match comes first; engagement separates
/// posts that match about equally well, which among tweets is most of them.
pub const RELEVANT: Weights = Weights {
    text: 0.6,
    prior: 0.15,
    fresh: 0.15,
    authority: 0.03,
};

/// "Relevant + engagement": engagement counts for twice as much or more.
///
/// The text match still keeps a viral post that barely matches from
/// outranking ones that are about the searched words.
pub const POPULAR: Weights = Weights {
    text: 0.8,
    prior: 0.35,
    fresh: 0.1,
    authority: 0.03,
};

/// How long freshness takes to fall to about a third.
const FRESH_DAYS: f64 = 30.0;

/// Score one matching post. Larger is better; only the order matters.
///
/// `text` is BM25 (zero when the query only filters, as `@theo` alone does,
/// so every post ties on text and the prior decides). `prior` is the stored
/// [`prior`], `authority` the author's (0 when unknown); `created_at` and
/// `now` are epoch milliseconds.
#[must_use]
pub fn score(
    weights: Weights,
    text: f32,
    prior: f64,
    authority: f64,
    created_at: Option<i64>,
    now: i64,
) -> f64 {
    let text = f64::from(text).max(1e-3).ln();
    let fresh = created_at.map_or(0.0, |created| {
        let days =
            f64::from(u32::try_from(now.saturating_sub(created).max(0) / 1000).unwrap_or(u32::MAX))
                / 86_400.0;
        weights.fresh * (-days / FRESH_DAYS).exp()
    });
    let authority = weights
        .authority
        .mul_add(authority.clamp(AUTHORITY_MIN, AUTHORITY_MAX), fresh.ln_1p());
    weights
        .text
        .mul_add(text, weights.prior.mul_add(prior, authority))
}

/// Bounds on [`authority`] as scored, so no one account's standing can
/// outweigh what a post says.
const AUTHORITY_MIN: f64 = -2.0;
const AUTHORITY_MAX: f64 = 5.0;

/// How much replying to, quoting or mentioning someone says about them.
/// A quote puts them in front of your followers; a reply is a conversation;
/// a mention in passing is the weakest. Only the strongest counts per post.
const QUOTE_EDGE: f32 = 2.0;
const REPLY_EDGE: f32 = 1.0;
const MENTION_EDGE: f32 = 0.5;

/// The accounts a post points at, and how strongly: who it replies to,
/// quotes and mentions in its own words. Lowercase handles; never the author.
#[must_use]
pub fn interactions(post: &Post) -> Vec<(String, f32)> {
    let mut out: Vec<(String, f32)> = Vec::new();
    let mut add = |handle: &str, weight: f32| {
        let handle = handle.to_ascii_lowercase();
        if handle.is_empty() || handle.eq_ignore_ascii_case(&post.author) {
            return;
        }
        match out.iter_mut().find(|(seen, _)| *seen == handle) {
            Some((_, strongest)) => *strongest = strongest.max(weight),
            None => out.push((handle, weight)),
        }
    };
    if let Some(quote) = &post.quote {
        add(&quote.author, QUOTE_EDGE);
    }
    if let Some(reply_to) = &post.reply_to {
        add(reply_to, REPLY_EDGE);
    }
    let mut rest = post.body();
    while let Some(at) = rest.find('@') {
        let after = rest.get(at.saturating_add(1)..).unwrap_or_default();
        let end = after
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .unwrap_or(after.len());
        // An address ("a@b.com") is not a mention.
        let joined = rest
            .get(..at)
            .and_then(|before| before.chars().next_back())
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
        if !joined && (1..=15).contains(&end) {
            add(after.get(..end).unwrap_or_default(), MENTION_EDGE);
        }
        rest = after.get(end..).unwrap_or_default();
    }
    out
}

/// How often `PageRank`'s random surfer follows a link rather than jumping
/// to any account at random. The value from the `PageRank` paper.
const DAMPING: f64 = 0.85;

/// Each account's standing: `PageRank` over who cites whom, on a log scale.
///
/// As X's `TweepCred` does over its interaction graph. 0 is an average
/// account, each +1 is e times more cited. `edges` are (from, to, weight) between `nodes` accounts; repeat
/// pairs should already be summed. Each pair's weight is dampened to
/// `ln(1 + weight)`, so replying to someone a hundred times is not a
/// hundred votes.
#[must_use]
pub fn authority(nodes: usize, edges: &[(u32, u32, f32)]) -> Vec<f64> {
    if nodes == 0 {
        return Vec::new();
    }
    let index = |node: u32| usize::try_from(node).unwrap_or(usize::MAX);
    let mut out_weight = vec![0.0_f64; nodes];
    let edges: Vec<(usize, usize, f64)> = edges
        .iter()
        .filter(|(from, to, weight)| {
            from != to && *weight > 0.0 && index(*from) < nodes && index(*to) < nodes
        })
        .map(|&(from, to, weight)| (index(from), index(to), f64::from(weight).ln_1p()))
        .collect();
    for &(from, _, weight) in &edges {
        if let Some(total) = out_weight.get_mut(from) {
            *total += weight;
        }
    }
    let count = f64::from(u32::try_from(nodes).unwrap_or(u32::MAX));
    let mut rank = vec![1.0 / count; nodes];
    for _ in 0..100 {
        // Accounts that point nowhere hand their rank to everyone.
        let dangling: f64 = rank
            .iter()
            .zip(&out_weight)
            .filter(|(_, total)| **total == 0.0)
            .map(|(rank, _)| rank)
            .sum();
        let base = DAMPING.mul_add(dangling, 1.0 - DAMPING) / count;
        let mut next = vec![base; nodes];
        for &(from, to, weight) in &edges {
            let share = rank.get(from).copied().unwrap_or(0.0) * weight
                / out_weight.get(from).copied().unwrap_or(1.0);
            if let Some(slot) = next.get_mut(to) {
                *slot = DAMPING.mul_add(share, *slot);
            }
        }
        let change: f64 = next.iter().zip(&rank).map(|(a, b)| (a - b).abs()).sum();
        rank = next;
        if change < 1e-9 {
            break;
        }
    }
    rank.into_iter().map(|rank| (rank * count).ln()).collect()
}

/// How much less a result is worth for each better-ranked result by the
/// same author: Google shows about two results per site, X multiplies each
/// further post by one author by a decaying factor (0.5, down to 0.25).
/// Much gentler here (0.86, down to 0.64), as an archive often holds one
/// person's posts on a subject; stronger settings let quiet posts by other
/// authors in (see `docs/search-ranking.md`).
const REPEAT_AUTHOR: f64 = -0.15;
const REPEAT_AUTHOR_FLOOR: f64 = -0.45;
/// How much less a post is worth when a better-ranked one says the same.
const DUPLICATE: f64 = -1.386_294_361_119_890_6; // ln(0.25)

/// The change to a result's score for repeating an author or a wording.
///
/// `earlier` is how many better-ranked results share its author; `duplicate`
/// whether a better-ranked one says the same word for word. Applied in order, so the best post of each author and text keeps its
/// place; a query for one author keeps its order, since every later post
/// loses at least as much as the one above it. The caller keeps
/// [`is_quiet`] posts from rising.
#[must_use]
pub fn diversity(earlier: usize, duplicate: bool) -> f64 {
    let earlier = f64::from(u32::try_from(earlier).unwrap_or(u32::MAX));
    let repeat = (REPEAT_AUTHOR * earlier).max(REPEAT_AUTHOR_FLOOR);
    repeat + if duplicate { DUPLICATE } else { 0.0 }
}

/// Below this [`prior`] (about three likes' worth), a post is quiet: making
/// room for other authors never lifts it past anything ranked above it.
const QUIET_PRIOR: f64 = 1.386_294_361_119_890_6; // ln(1 + 3)

/// Whether a post's [`prior`] is too low for diversity to promote it.
#[must_use]
pub fn is_quiet(prior: f64) -> bool {
    prior < QUIET_PRIOR
}

/// A fingerprint of what a post says, for spotting word-for-word repeats.
///
/// Its words, lowercased, without links or @handles. `None` when there are
/// no words (a photo alone), since those are not repeats of each other.
#[must_use]
pub fn wording(post: &Post) -> Option<u64> {
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    let mut any = false;
    for word in post
        .body()
        .split_whitespace()
        .filter(|token| !token.starts_with('@') && !token.starts_with("http"))
        .flat_map(|token| token.split(|c: char| !c.is_alphanumeric()))
        .filter(|word| !word.is_empty())
    {
        any = true;
        word.to_lowercase().hash(&mut hash);
    }
    any.then(|| hash.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use search_model::TweetId;

    fn post(likes: u32, reply_to: Option<&str>) -> Post {
        Post {
            tweet_id: TweetId(1),
            author: "theo".into(),
            text: "fast ssd speeds".into(),
            url: "https://x.com/theo/status/1".into(),
            created_at: None,
            likes: Some(likes),
            reposts: None,
            replies: None,
            quotes: None,
            links: Vec::new(),
            display_name: None,
            avatar: None,
            views: None,
            bookmarks: None,
            reply_to: reply_to.map(str::to_owned),
            media: Vec::new(),
            card: None,
            quote: None,
            quoted_by: Vec::new(),
        }
    }

    #[test]
    fn replying_to_others_costs_but_threads_do_not() {
        let alone = prior(&post(100, None));
        assert!((prior(&post(100, Some("theo"))) - alone).abs() < 1e-9);
        assert!(prior(&post(100, Some("someone"))) < alone);
    }

    #[test]
    fn thin_posts_say_under_three_words_with_nothing_attached() {
        let with = |text: &str| Post {
            text: text.into(),
            reply_to: Some("someone".into()),
            ..post(0, None)
        };
        assert!(is_thin(&with("@someone lol 💀 https://t.co/x")));
        assert!(!is_thin(&with("@someone that is fair")));
        let captioned = Post {
            media: vec![search_model::Media {
                kind: search_model::MediaKind::Photo,
                image: "https://pbs.twimg.com/media/a.jpg".into(),
                video: None,
                width: None,
                height: None,
                alt: None,
            }],
            ..with("lol")
        };
        assert!(!is_thin(&captioned));
    }

    #[test]
    fn a_popular_post_outranks_a_slightly_better_text_match() {
        let viral = prior(&post(6000, None));
        let quiet = prior(&post(2, Some("someone")));
        assert!(
            score(RELEVANT, 4.0, viral, 0.0, None, 0) > score(RELEVANT, 6.0, quiet, 0.0, None, 0)
        );
        // ...but not a far better one.
        assert!(
            score(RELEVANT, 0.5, viral, 0.0, None, 0) < score(RELEVANT, 10.0, quiet, 0.0, None, 0)
        );
    }

    #[test]
    fn popular_weighs_engagement_more_than_relevant() {
        let viral = prior(&post(6000, None));
        let modest = prior(&post(50, None));
        let (loose, exact) = (2.0, 10.0);
        assert!(
            score(RELEVANT, loose, viral, 0.0, None, 0)
                < score(RELEVANT, exact, modest, 0.0, None, 0)
        );
        assert!(
            score(POPULAR, loose, viral, 0.0, None, 0)
                > score(POPULAR, exact, modest, 0.0, None, 0)
        );
    }

    #[test]
    fn cited_accounts_gain_authority_and_repeats_are_dampened() {
        // 0 and 1 both point at 2; 3 points at 4 a hundred times over.
        let ranks = authority(5, &[(0, 2, 1.0), (1, 2, 1.0), (3, 4, 100.0), (2, 2, 9.0)]);
        let [a, b, cited, spammer, target] = ranks.as_slice() else {
            panic!("one rank per account");
        };
        assert!(cited > target, "two voices beat one loud one");
        assert!(target > spammer && (a - b).abs() < 1e-9);
        // An average account is 0 on this scale.
        let mean: f64 = ranks.iter().map(|rank| rank.exp()).sum::<f64>() / 5.0;
        assert!((mean - 1.0).abs() < 1e-6);
        assert!(authority(0, &[]).is_empty());
    }

    #[test]
    fn interactions_are_quotes_replies_and_mentions_not_self_or_emails() {
        let mut post = post(0, Some("Bob"));
        post.author = "alice".into();
        post.text = "@bob @carol thanks @Dave and @alice, mail me at a@b.com @bob".into();
        post.quote = Some(search_model::Quote {
            url: "https://x.com/bob/status/2".into(),
            author: "bob".into(),
            display_name: None,
            text: String::new(),
            created_at: None,
            image: None,
        });
        // "@bob @carol" is the reply chain, not the author's words.
        assert_eq!(
            interactions(&post),
            [
                ("bob".to_owned(), QUOTE_EDGE),
                ("dave".to_owned(), MENTION_EDGE)
            ]
        );
    }

    #[test]
    fn diversity_keeps_the_best_per_author_and_one_authors_order() {
        assert!(diversity(0, false).abs() < f64::EPSILON);
        assert!(diversity(1, false) < 0.0 && diversity(2, false) < diversity(1, false));
        assert!((diversity(50, false) - diversity(4, false)).abs() < f64::EPSILON);
        assert!(diversity(0, true) < diversity(3, false));
        // One author's results, best first, stay in order.
        let scores = [5.0, 4.9, 4.8, 4.7, 4.7];
        let adjusted: Vec<f64> = scores
            .iter()
            .enumerate()
            .map(|(earlier, score)| score + diversity(earlier, false))
            .collect();
        assert!(adjusted.windows(2).all(|pair| pair[0] >= pair[1]));
    }

    #[test]
    fn wording_ignores_case_links_and_handles_but_needs_words() {
        let with = |text: &str| Post {
            text: text.into(),
            ..post(0, None)
        };
        assert_eq!(
            wording(&with("LOL! https://t.co/a")),
            wording(&with("lol @bob https://t.co/b"))
        );
        assert_ne!(wording(&with("lol")), wording(&with("lmao")));
        assert_eq!(wording(&with("https://t.co/a @bob")), None);
    }

    #[test]
    fn freshness_is_a_nudge() {
        let day = 86_400_000;
        let now = 400 * day;
        let fresh = score(RELEVANT, 5.0, 3.0, 0.0, Some(now - day), now);
        let old = score(RELEVANT, 5.0, 3.0, 0.0, Some(0), now);
        assert!(fresh > old);
        assert!(fresh - old < 0.15);
    }
}
