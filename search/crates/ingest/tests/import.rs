use search_backend::SearchBackend;
use search_model::{SearchRequest, Sort};
use std::io::Write;

#[test]
fn retained_import_replays_and_quarantines_invalid_records() {
    let root = tempfile::tempdir().unwrap();
    let mut input = tempfile::NamedTempFile::new().unwrap();
    let good = serde_json::json!({"id":"123", "text":"to be", "author":{"id":"7", "screen_name":"Alice"}, "likes":0, "created_timestamp":1_700_000_000});
    write!(
        input,
        "{}",
        serde_json::json!({"posts":[good, {"id":"bad"}]})
    )
    .unwrap();
    let engine = search_tantivy::open(&root.path().join("index"), true).unwrap();
    let archive = root.path().join("raw");
    for _ in 0..2 {
        let writer = engine.writer().unwrap();
        let receipt = search_ingest::import(input.path(), &archive, writer).unwrap();
        assert_eq!((receipt.accepted, receipt.rejected), (1, 1));
        assert_eq!(
            std::fs::read(archive.join(format!("{}.json", receipt.sha256))).unwrap(),
            std::fs::read(input.path()).unwrap()
        );
    }
    let request = SearchRequest {
        version: 1,
        query: "be".into(),
        author: None,
        sort: Sort::Relevance,
        limit: 20,
        cursor: None,
        include_stats: false,
    };
    let result = engine
        .search(
            &search_query::parse("be", None).unwrap(),
            &request,
            1_700_000_000_000,
        )
        .unwrap();
    assert_eq!(result.rows.len(), 1);
    assert_eq!(result.rows[0].created_at, Some(1_700_000_000_000));
    assert_eq!(result.rows[0].replies, None);
}

#[test]
fn malformed_envelope_does_not_publish_partial_index() {
    let root = tempfile::tempdir().unwrap();
    let mut input = tempfile::NamedTempFile::new().unwrap();
    write!(input, "{{\"posts\":[{{\"id\":\"1\",\"text\":\"hello\",\"author\":{{\"id\":\"2\",\"screen_name\":\"alice\"}}}}],BROKEN").unwrap();
    let engine = search_tantivy::open(&root.path().join("index"), true).unwrap();
    {
        let writer = engine.writer().unwrap();
        assert!(search_ingest::import(input.path(), &root.path().join("raw"), writer).is_err());
    }
    let request = SearchRequest {
        version: 1,
        query: "hello".into(),
        author: None,
        sort: Sort::Relevance,
        limit: 20,
        cursor: None,
        include_stats: false,
    };
    assert_eq!(
        engine
            .search(&search_query::parse("hello", None).unwrap(), &request, 0)
            .unwrap()
            .rows
            .len(),
        0
    );
}

struct FailingSink;
impl search_backend::IndexSink for FailingSink {
    fn upsert(&mut self, _: &search_model::Post) -> search_model::Result<()> {
        Err(search_model::Error::Storage("disk full".into()))
    }
    fn commit(&mut self) -> search_model::Result<()> {
        Ok(())
    }
}

#[test]
fn sink_failure_is_reported_as_storage_not_invalid_input() {
    let root = tempfile::tempdir().unwrap();
    let mut input = tempfile::NamedTempFile::new().unwrap();
    let good = serde_json::json!({"id":"123", "text":"to be", "author":{"id":"7", "screen_name":"Alice"}, "likes":0, "created_timestamp":1_700_000_000});
    write!(input, "{}", serde_json::json!({"posts":[good]})).unwrap();
    let error =
        search_ingest::import(input.path(), &root.path().join("raw"), FailingSink).unwrap_err();
    assert!(
        matches!(error, search_model::Error::Storage(_)),
        "sink error was flattened: {error}"
    );
    assert_eq!(error.to_string(), "Search storage failed: disk full");
}

#[test]
fn malformed_capture_record_quarantines_but_embeddings_style_posts_abort_nothing() {
    let root = tempfile::tempdir().unwrap();
    let mut input = tempfile::NamedTempFile::new().unwrap();
    let valid = serde_json::json!({"id":"55", "text":"survivor", "author":{"id":"7", "screen_name":"alice"}, "created_timestamp":1_700_000_000});
    // posts present but not an array must quarantine the record, not abort.
    write!(
        input,
        "{}",
        serde_json::json!({"records":[
            {"payload": {"posts": "oops"}},
            {"payload": {"post": valid}}
        ]})
    )
    .unwrap();
    let engine = search_tantivy::open(&root.path().join("index"), true).unwrap();
    let writer = engine.writer().unwrap();
    let receipt = search_ingest::import(input.path(), &root.path().join("raw"), writer).unwrap();
    assert_eq!((receipt.accepted, receipt.rejected), (1, 1));
}

#[test]
fn reposts_fallback_ignores_malformed_retweets() {
    let root = tempfile::tempdir().unwrap();
    let mut input = tempfile::NamedTempFile::new().unwrap();
    write!(input, "{}", serde_json::json!({"posts":[{"id":"66", "text":"hi", "author":{"id":"7","screen_name":"alice"}, "reposts":5, "retweets":"not-a-number", "created_timestamp":1_700_000_000}]})).unwrap();
    let engine = search_tantivy::open(&root.path().join("index"), true).unwrap();
    let writer = engine.writer().unwrap();
    let receipt = search_ingest::import(input.path(), &root.path().join("raw"), writer).unwrap();
    assert_eq!(receipt.accepted, 1);
}

#[test]
fn null_expanded_url_does_not_shadow_valid_url() {
    let root = tempfile::tempdir().unwrap();
    let mut input = tempfile::NamedTempFile::new().unwrap();
    write!(input, "{}", serde_json::json!({"posts":[{"id":"77", "text":"link post", "author":{"id":"7","screen_name":"alice"}, "created_timestamp":1_700_000_000, "raw_text": {"facets": [{"expanded_url": null, "url": "https://example.com/x"}]}}]})).unwrap();
    let engine = search_tantivy::open(&root.path().join("index"), true).unwrap();
    let writer = engine.writer().unwrap();
    let receipt = search_ingest::import(input.path(), &root.path().join("raw"), writer).unwrap();
    assert_eq!(receipt.accepted, 1);
}

#[test]
fn embeds_and_replies_are_kept() {
    let post = search_ingest::normalize(&serde_json::json!({
        "id": "10",
        "text": "@bob look at this",
        "author": {"id": "7", "screen_name": "Alice"},
        "replying_to": {"screen_name": "Bob", "status": "9"},
        "views": 5_000_000_000_u64,
        "bookmarks": 4,
        "media": {"all": [
            {"type": "photo", "url": "https://pbs.twimg.com/media/a.jpg", "width": 1200, "height": 675, "altText": "A chart"},
            {"type": "video", "url": "https://video.twimg.com/v.mp4", "thumbnail_url": "https://pbs.twimg.com/t.jpg"},
            {"type": "photo", "url": "http://insecure.example/a.jpg"},
            {"type": "sticker", "url": "https://pbs.twimg.com/s.png"}
        ]},
        "card": {"url": "https://example.com/post", "title": "A post", "domain": "example.com", "image": {"url": "https://pbs.twimg.com/card.jpg"}},
        "quote": {"url": "https://x.com/carol/status/8", "text": "quoted", "author": {"screen_name": "Carol", "name": "Carol C"}, "media": {"all": [{"type": "photo", "url": "https://pbs.twimg.com/q.jpg"}]}}
    }))
    .unwrap();
    assert_eq!(post.reply_to.as_deref(), Some("bob"));
    assert!(post.replies_to_other());
    assert_eq!(post.views, Some(5_000_000_000));
    assert_eq!(post.bookmarks, Some(4));
    assert_eq!(
        post.media.len(),
        2,
        "insecure and unknown media are dropped"
    );
    assert_eq!(post.media[0].alt.as_deref(), Some("A chart"));
    assert_eq!(post.media[1].image, "https://pbs.twimg.com/t.jpg");
    assert_eq!(
        post.media[1].video.as_deref(),
        Some("https://video.twimg.com/v.mp4")
    );
    let card = post.card.unwrap();
    assert_eq!(
        card.image.as_deref(),
        Some("https://pbs.twimg.com/card.jpg")
    );
    let quote = post.quote.unwrap();
    assert_eq!(
        (quote.author.as_str(), quote.image.as_deref()),
        ("carol", Some("https://pbs.twimg.com/q.jpg"))
    );

    // Older captures name only the replied-to status: the handle comes from
    // the text, and a reply without a leading mention continues a thread.
    let older = |text: &str| {
        search_ingest::normalize(&serde_json::json!({
            "id": "11", "text": text, "author": {"id": "7", "screen_name": "alice"},
            "replying_to_status": ["9"]
        }))
        .unwrap()
    };
    assert_eq!(older("@Dave yes").reply_to.as_deref(), Some("dave"));
    assert_eq!(
        older("and another thing").reply_to.as_deref(),
        Some("alice")
    );
    assert!(!older("and another thing").replies_to_other());
}

#[derive(Default)]
struct Observations(Vec<(Option<i64>, u64, search_model::Post)>);
impl search_ingest::ReplayObserver for Observations {
    fn post(
        &mut self,
        time: Option<i64>,
        ordinal: u64,
        post: &search_model::Post,
    ) -> search_model::Result<()> {
        self.0.push((time, ordinal, post.clone()));
        Ok(())
    }
}

#[test]
fn observed_replay_parity_times_profiles_and_rejects() {
    let good = serde_json::json!({"id":"123", "text":"@bob hello https://a.b", "replying_to":{"screen_name":"bob"}, "author":{"id":"7","screen_name":"Alice"}, "card":{"url":"https://a.b","title":"Title"}});
    let mut input = tempfile::NamedTempFile::new().unwrap();
    write!(
        input,
        "{}",
        serde_json::json!({"records":[
            {"receivedAt":1234,"payload":{"posts":[good, {"id":"bad"}]}},
            {"receivedAt":2222,"payload":{"type":"profile"}},
            {"payload":{"post":good}}
        ]})
    )
    .unwrap();
    let mut observed = Observations::default();
    let receipt = search_ingest::replay_observed(input.path(), &mut observed).unwrap();
    assert_eq!((receipt.accepted, receipt.rejected), (2, 1));
    let first = observed
        .0
        .first()
        .ok_or("Missing first observation")
        .unwrap();
    assert_eq!((first.0, first.1), (Some(1234), 0));
    assert_eq!(first.2, search_ingest::normalize(&good).unwrap());
    assert_eq!(first.2.searchable(), "hello  \nTitle");
    let last = observed.0.last().ok_or("Missing last observation").unwrap();
    assert_eq!((last.0, last.1), (None, 2));
}

#[test]
fn observed_invalid_timestamp_and_partial_eof_fail() {
    let good = serde_json::json!({"id":"1","text":"x","author":{"id":"2","screen_name":"a"}});
    for timestamp in [
        serde_json::json!(-1),
        serde_json::json!("today"),
        serde_json::json!(true),
        serde_json::json!(1.5),
    ] {
        let mut input = tempfile::NamedTempFile::new().unwrap();
        write!(
            input,
            "{}",
            serde_json::json!({"records":[{"receivedAt":timestamp,"payload":{"post":good}}]})
        )
        .unwrap();
        assert!(
            search_ingest::replay_observed(input.path(), &mut Observations::default()).is_err()
        );
    }
    let mut input = tempfile::NamedTempFile::new().unwrap();
    write!(input, "{{\"posts\":[{good}]").unwrap();
    let mut observed = Observations::default();
    assert!(search_ingest::replay_observed(input.path(), &mut observed).is_err());
    assert_eq!(observed.0.len(), 1);
}

#[test]
fn observed_output_failure_propagates() {
    struct Broken;
    impl search_ingest::ReplayObserver for Broken {
        fn post(
            &mut self,
            _: Option<i64>,
            _: u64,
            _: &search_model::Post,
        ) -> search_model::Result<()> {
            Err(search_model::Error::Storage("broken pipe".into()))
        }
    }
    let mut input = tempfile::NamedTempFile::new().unwrap();
    write!(
        input,
        "{}",
        serde_json::json!({"posts":[{"id":"1","text":"x","author":{"id":"2","screen_name":"a"}}]})
    )
    .unwrap();
    assert!(matches!(
        search_ingest::replay_observed(input.path(), &mut Broken),
        Err(search_model::Error::Storage(_))
    ));
}
