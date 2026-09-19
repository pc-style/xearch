use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use search_model::SearchResponse;
use serde_json::{Value, json};
use tower::ServiceExt;

#[allow(clippy::unwrap_used, clippy::arithmetic_side_effects)]
fn create_engine() -> (
    std::sync::Arc<dyn search_backend::SearchBackend>,
    tempfile::TempDir,
) {
    let dir = tempfile::tempdir().unwrap();
    let engine = search_tantivy::open(dir.path(), true).unwrap();
    for index in 0..5_u64 {
        let post = serde_json::json!({
            "id": (1_000 + index).to_string(),
            "author": {"screen_name": "bulk", "id": "9"},
            "text": "shared words here",
            "created_timestamp": 1_700_000_000,
        });
        let dump = tempfile::NamedTempFile::new().unwrap();
        serde_json::to_writer_pretty(&dump, &json!({"posts": [post]})).unwrap();
        let writer = engine.writer().unwrap();
        search_ingest::import(dump.path(), &dir.path().join("raw"), writer).unwrap();
    }
    (std::sync::Arc::new(engine), dir)
}

#[allow(clippy::unwrap_used)]
fn router() -> (axum::Router, tempfile::TempDir) {
    let (engine, dir) = create_engine();
    (
        search_api::router(engine, vec![0x11_u8; 64], vec![b'b'; 64]).unwrap(),
        dir,
    )
}

#[allow(clippy::unwrap_used)]
async fn post_json(
    router: &axum::Router,
    path: &str,
    body: String,
    bearer: Option<&str>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method("POST").uri(path);
    if let Some(token) = bearer {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    let response = router
        .clone()
        .oneshot(
            builder
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, value)
}

#[tokio::test]
async fn cursors_are_signed_and_forgery_is_rejected() {
    let (router, _dir) = router();
    let bearer = "b".repeat(64);
    let (status, first) = post_json(
        &router,
        "/search",
        serde_json::to_string(&json!({
            "version": 1, "query": "shared", "sort": "relevance", "limit": 2
        }))
        .unwrap(),
        Some(&bearer),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    let response: SearchResponse = serde_json::from_value(first).unwrap();
    let cursor = response.next_cursor.expect("a second page exists");
    assert!(cursor.starts_with('{'), "cursor must be a Signed envelope");

    // The signed cursor replays as page 2.
    let (status, second) = post_json(
        &router,
        "/search",
        serde_json::to_string(&json!({
            "version": 1, "query": "shared", "sort": "relevance",
            "limit": 2, "cursor": cursor
        }))
        .unwrap(),
        Some(&bearer),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let paged: SearchResponse = serde_json::from_value(second).unwrap();
    assert!(!paged.rows.is_empty());

    // Rewrap the payload with a forged deep offset, keeping the signature.
    let signed: search_api::Signed = serde_json::from_str(&cursor).unwrap();
    let mut forged_inner: Value = serde_json::from_str(&signed.payload).unwrap();
    forged_inner["offset"] = json!(9990);
    let forged = serde_json::to_string(&json!({
        "payload": forged_inner.to_string(),
        "signature": signed.signature
    }))
    .unwrap();
    let (status, error) = post_json(
        &router,
        "/search",
        serde_json::to_string(&json!({
            "version": 1, "query": "shared", "sort": "relevance",
            "limit": 2, "cursor": forged
        }))
        .unwrap(),
        Some(&bearer),
    )
    .await;
    assert_ne!(
        status,
        StatusCode::OK,
        "a forged cursor must be rejected outright, body said: {error}"
    );
}

#[tokio::test]
async fn missing_bearer_is_rejected() {
    let (router, _dir) = router();
    let (status, _body) = post_json(
        &router,
        "/search",
        serde_json::to_string(&json!({
            "version": 1, "query": "shared", "sort": "relevance", "limit": 2
        }))
        .unwrap(),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}
