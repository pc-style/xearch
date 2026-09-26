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
}

/// "Relevant": how well the words match comes first; engagement separates
/// posts that match about equally well, which among tweets is most of them.
pub const RELEVANT: Weights = Weights {
    text: 0.6,
    prior: 0.15,
    fresh: 0.15,
};

/// "Relevant + engagement": engagement counts for twice as much or more.
///
/// The text match still keeps a viral post that barely matches from
/// outranking ones that are about the searched words.
pub const POPULAR: Weights = Weights {
    text: 0.8,
    prior: 0.35,
    fresh: 0.1,
};

/// How long freshness takes to fall to about a third.
const FRESH_DAYS: f64 = 30.0;

/// Score one matching post. Larger is better; only the order matters.
///
/// `text` is BM25 (zero when the query only filters, as `@theo` alone does,
/// so every post ties on text and the prior decides). `prior` is the stored
/// [`prior`]; `created_at` and `now` are epoch milliseconds.
#[must_use]
pub fn score(weights: Weights, text: f32, prior: f64, created_at: Option<i64>, now: i64) -> f64 {
    let text = f64::from(text).max(1e-3).ln();
    let fresh = created_at.map_or(0.0, |created| {
        let days =
            f64::from(u32::try_from(now.saturating_sub(created).max(0) / 1000).unwrap_or(u32::MAX))
                / 86_400.0;
        weights.fresh * (-days / FRESH_DAYS).exp()
    });
    weights
        .text
        .mul_add(text, weights.prior.mul_add(prior, fresh.ln_1p()))
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
        assert!(score(RELEVANT, 4.0, viral, None, 0) > score(RELEVANT, 6.0, quiet, None, 0));
        // ...but not a far better one.
        assert!(score(RELEVANT, 0.5, viral, None, 0) < score(RELEVANT, 10.0, quiet, None, 0));
    }

    #[test]
    fn popular_weighs_engagement_more_than_relevant() {
        let viral = prior(&post(6000, None));
        let modest = prior(&post(50, None));
        let (loose, exact) = (2.0, 10.0);
        assert!(score(RELEVANT, loose, viral, None, 0) < score(RELEVANT, exact, modest, None, 0));
        assert!(score(POPULAR, loose, viral, None, 0) > score(POPULAR, exact, modest, None, 0));
    }

    #[test]
    fn freshness_is_a_nudge() {
        let day = 86_400_000;
        let now = 400 * day;
        let fresh = score(RELEVANT, 5.0, 3.0, Some(now - day), now);
        let old = score(RELEVANT, 5.0, 3.0, Some(0), now);
        assert!(fresh > old);
        assert!(fresh - old < 0.15);
    }
}
