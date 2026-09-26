use search_model::{Post, SearchRequest, Sort, TweetId};

pub fn post(id: u32, text: &str) -> Post {
    Post {
        tweet_id: TweetId(u64::from(id)),
        author: "alice".into(),
        text: text.into(),
        url: format!("https://x.com/alice/status/{id}"),
        created_at: Some(i64::from(id).saturating_mul(1000)),
        likes: Some(id),
        reposts: None,
        replies: None,
        quotes: None,
        links: Vec::new(),
        display_name: None,
        avatar: None,
        views: None,
        bookmarks: None,
        reply_to: None,
        media: Vec::new(),
        card: None,
        quote: None,
    }
}

pub fn request(query: &str) -> SearchRequest {
    SearchRequest {
        version: 1,
        query: query.into(),
        author: None,
        sort: Sort::Relevance,
        limit: 20,
        cursor: None,
        include_stats: false,
    }
}
