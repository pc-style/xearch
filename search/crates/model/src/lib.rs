//! Backend-neutral wire types. No search-engine types cross this boundary.
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;

/// Compact Rust representation of an X Snowflake ID. It remains a decimal
/// string on the wire so JavaScript clients never lose integer precision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TweetId(pub u64);

impl fmt::Display for TweetId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl Serialize for TweetId {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for TweetId {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        let parsed = value
            .parse::<u64>()
            .map_err(|_| serde::de::Error::custom("Tweet ID must be an unsigned integer."))?;
        if parsed == 0 || parsed.to_string() != value {
            return Err(serde::de::Error::custom("Tweet ID must be canonical."));
        }
        Ok(Self(parsed))
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Invalid(String),
    #[error("Search storage failed: {0}")]
    Storage(String),
    #[error("The index changed. Start a new search.")]
    StaleCursor,
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Post {
    /// Stored as u64 in Rust but serialized as a decimal string for clients.
    pub tweet_id: TweetId,
    pub author: String,
    pub text: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub likes: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reposts: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replies: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quotes: Option<u32>,
    pub links: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    /// Views and bookmarks feed the ranking prior; the app does not show them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub views: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bookmarks: Option<u32>,
    /// The handle this post answers, when it is a reply. A reply to the
    /// author's own post (a thread) still names the author.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    /// Attached photos, videos and GIFs, in the order the post shows them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub media: Vec<Media>,
    /// The link preview X shows under the post.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card: Option<Card>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote: Option<Quote>,
    /// The best posts in the index that quote this one, filled in when it
    /// is returned as a result; never stored.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub quoted_by: Vec<QuotedBy>,
}

impl Post {
    /// A reply to someone else. Continuing one's own thread is not.
    #[must_use]
    pub fn replies_to_other(&self) -> bool {
        self.reply_to
            .as_deref()
            .is_some_and(|handle| !handle.eq_ignore_ascii_case(&self.author))
    }

    /// What the author wrote: a reply's text without the @handles it starts
    /// with. Those are the reply chain, which X shows as "Replying to", not
    /// words the author chose, so they are neither searched nor shown.
    #[must_use]
    pub fn body(&self) -> &str {
        if self.reply_to.is_none() {
            return &self.text;
        }
        let mut rest = self.text.trim_start();
        while let Some(handle) = rest.strip_prefix('@') {
            let end = handle
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                .unwrap_or(handle.len());
            if end == 0 {
                break;
            }
            rest = handle.get(end..).unwrap_or_default().trim_start();
        }
        rest
    }
}

/// A post quoting a search result, as shown under it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QuotedBy {
    pub url: String,
    pub author: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    /// What the quoting author wrote, cut to [`QuotedBy::TEXT_CHARS`].
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub likes: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
}

impl QuotedBy {
    /// Characters of the quoting post's own words kept.
    pub const TEXT_CHARS: usize = 280;

    /// How `post` appears under the post it quotes.
    #[must_use]
    pub fn of(post: &Post) -> Self {
        let body = post.body();
        let text = match body.char_indices().nth(Self::TEXT_CHARS) {
            Some((end, _)) => format!("{}…", body.get(..end).unwrap_or(body).trim_end()),
            None => body.to_owned(),
        };
        Self {
            url: post.url.clone(),
            author: post.author.clone(),
            display_name: post.display_name.clone(),
            avatar: post.avatar.clone(),
            text,
            likes: post.likes,
            created_at: post.created_at,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Photo,
    Video,
    Gif,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Media {
    pub kind: MediaKind,
    /// The photo itself, or the still shown before a video plays.
    pub image: String,
    /// The playable MP4 for a video or GIF.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alt: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub url: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
}

/// The quoted post, reduced to what its embed shows.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    pub url: String,
    pub author: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    /// The first attached image, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Sort {
    #[default]
    Relevance,
    Engagement,
    Likes,
    Newest,
    Oldest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SearchRequest {
    pub version: u8,
    pub query: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub sort: Sort,
    pub limit: usize,
    #[serde(default)]
    pub cursor: Option<String>,
    /// Diagnostics are opt-in so ordinary searches keep the small response.
    #[serde(default, rename = "includeStats")]
    pub include_stats: bool,
}

impl SearchRequest {
    /// Validate the transport bounds before parsing or searching.
    ///
    /// # Errors
    /// Returns an error for unsupported versions or excessive work.
    pub fn validate(&self) -> Result<()> {
        if self.version != 1 || !(1..=20).contains(&self.limit) {
            return Err(Error::Invalid("Use version 1 and limit 1–20.".into()));
        }
        if self.query.chars().count() > 300 || self.cursor.as_ref().is_some_and(|s| s.len() > 4000)
        {
            return Err(Error::Invalid("Query or cursor is too long.".into()));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub rows: Vec<Post>,
    /// Every post the query matches, on the first page only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stats: Option<SearchStats>,
}

/// Timings and counters are emitted only when `includeStats` is true.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchStats {
    pub backend: BackendStats,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api: Option<ApiStats>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct BackendStats {
    pub total_us: u64,
    pub reload_us: u64,
    pub fingerprint_us: u64,
    pub cursor_us: u64,
    pub compile_us: u64,
    pub retrieve_us: u64,
    pub ranking_calls: u64,
    pub materialize_us: u64,
    pub candidate_hits: u64,
    pub returned_rows: u64,
    pub index_docs: u64,
    pub segments: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApiStats {
    pub total_us: u64,
    pub auth_us: u64,
    pub validate_us: u64,
    pub cursor_verify_us: u64,
    pub parse_us: u64,
    pub permit_us: u64,
    pub queue_us: u64,
    pub engine_us: u64,
    pub postprocess_us: u64,
    pub cursor_sign_us: u64,
}

#[cfg(test)]
mod tests {
    use super::{Post, TweetId};

    #[test]
    fn body_drops_only_a_replys_leading_handles() {
        let mut post: Post = serde_json::from_value(serde_json::json!({
            "tweetId": "1", "author": "a", "url": "https://x.com/a/status/1",
            "text": "@b @c_d thanks @e", "links": []
        }))
        .unwrap();
        assert_eq!(post.body(), "@b @c_d thanks @e");
        post.reply_to = Some("b".into());
        assert_eq!(post.body(), "thanks @e");
        post.text = "@b".into();
        assert_eq!(post.body(), "");
        post.text = "@ hi".into();
        assert_eq!(post.body(), "@ hi");
    }

    #[test]
    fn tweet_id_is_compact_in_rust_and_decimal_on_wire() {
        assert_eq!(std::mem::size_of::<TweetId>(), std::mem::size_of::<u64>());
        let encoded = serde_json::to_string(&TweetId(1_234_567_890_123_456_789)).ok();
        assert_eq!(encoded.as_deref(), Some("\"1234567890123456789\""));
        let decoded = encoded
            .as_deref()
            .and_then(|value| serde_json::from_str::<TweetId>(value).ok());
        assert_eq!(decoded, Some(TweetId(1_234_567_890_123_456_789)));
        let old_post = r#"{"tweetId":"1","author":"a","authorId":"42","text":"x","url":"https://x.com/a/status/1","links":[]}"#;
        assert!(serde_json::from_str::<Post>(old_post).is_ok());
    }
}
