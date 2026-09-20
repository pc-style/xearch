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
    };
    assert!(
        engine
            .search(&search_query::parse("hello", None).unwrap(), &request, 0)
            .unwrap()
            .rows
            .is_empty()
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
