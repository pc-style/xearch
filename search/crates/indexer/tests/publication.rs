//! Integration tests for the publication sender
//! (`search_indexer::publish`): the envelope it builds, generation
//! bookkeeping and durability in `users.json`, and the delivered/
//! transport-failed split, exercised against a real loopback TCP
//! responder — not a mock of the transport layer.

use search_indexer::publish::{ImportOutcome, ImportReport, PublishConfig, report_after_import};
use search_indexer::users::Registry;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{Receiver, channel};

struct CapturedRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn read_request(stream: &mut TcpStream) -> Option<CapturedRequest> {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 4096];
    let header_end = loop {
        let read = stream.read(&mut chunk).ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(chunk.get(..read)?);
        if let Some(pos) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break pos;
        }
        if buffer.len() > 1_000_000 {
            return None;
        }
    };
    let head = String::from_utf8_lossy(buffer.get(..header_end)?).into_owned();
    let mut lines = head.split("\r\n");
    let request_line = lines.next()?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?.to_owned();
    let path = parts.next()?.to_owned();
    let mut headers = HashMap::new();
    let mut content_length = 0_usize;
    for line in lines {
        let (key, value) = line.split_once(':')?;
        let key = key.trim().to_ascii_lowercase();
        let value = value.trim().to_owned();
        if key == "content-length" {
            content_length = value.parse().unwrap_or(0);
        }
        headers.insert(key, value);
    }
    let body_start = header_end.saturating_add(4);
    let already = buffer.len().saturating_sub(body_start);
    let mut body = buffer.get(body_start..)?.to_vec();
    let mut remaining = content_length.saturating_sub(already);
    while remaining > 0 {
        let read = stream.read(&mut chunk).ok()?;
        if read == 0 {
            break;
        }
        let take = read.min(remaining);
        body.extend_from_slice(chunk.get(..take)?);
        remaining = remaining.saturating_sub(take);
    }
    Some(CapturedRequest {
        method,
        path,
        headers,
        body,
    })
}

/// Accept exactly one connection, capture the request, and reply with a
/// fixed status/body. Returns the URL to hit and a channel yielding the
/// captured request once the client has connected.
fn spawn_responder(
    status_line: &'static str,
    response_body: &'static str,
) -> std::io::Result<(String, Receiver<CapturedRequest>)> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let addr = listener.local_addr()?;
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            if let Some(request) = read_request(&mut stream) {
                let _ = tx.send(request);
            }
            let body = response_body.as_bytes();
            let response = format!(
                "{status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.write_all(body);
        }
    });
    Ok((format!("http://{addr}/publication/update"), rx))
}

/// Reply with a real status line and a `Content-Length` larger than the
/// bytes actually written, then close: a proxy truncating the response.
fn spawn_truncating_responder(
    status_line: &'static str,
    partial_body: &'static str,
    declared_length: usize,
) -> std::io::Result<(String, Receiver<CapturedRequest>)> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let addr = listener.local_addr()?;
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            if let Some(request) = read_request(&mut stream) {
                let _ = tx.send(request);
            }
            let response = format!(
                "{status_line}\r\nContent-Type: application/json\r\nContent-Length: {declared_length}\r\nConnection: close\r\n\r\n",
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.write_all(partial_body.as_bytes());
            let _ = stream.flush();
        }
    });
    Ok((format!("http://{addr}/publication/update"), rx))
}

fn engine(dir: &std::path::Path) -> search_model::Result<search_tantivy::Engine> {
    search_tantivy::open(dir, true)
}

/// A URL on a port nothing listens on, so a send fails to connect fast and
/// deterministically instead of waiting for a timeout.
fn unreachable_url() -> std::io::Result<String> {
    let probe = TcpListener::bind("127.0.0.1:0")?;
    let addr = probe.local_addr()?;
    drop(probe);
    Ok(format!("http://{addr}/publication/update"))
}

fn config_in(
    dir: &std::path::Path,
    publish: Option<PublishConfig>,
) -> std::io::Result<search_indexer::Config> {
    let config = search_indexer::Config {
        index: dir.join("index"),
        archive: dir.join("archive"),
        drop_dir: dir.join("drop"),
        state_dir: dir.join("state"),
        poll_interval: std::time::Duration::from_secs(1),
        publish,
    };
    std::fs::create_dir_all(&config.drop_dir)?;
    Ok(config)
}

fn publishing_to(url: String) -> PublishConfig {
    PublishConfig {
        url,
        token: "t".to_owned(),
    }
}

fn post(id: &str, handle: &str, provider_id: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "author": {"screen_name": handle, "id": provider_id},
        "text": "hello world",
        "created_timestamp": 1_758_000_000_i64,
    })
}

fn capture_batch(handle: &str, id: &str, provider_id: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "version": 1,
        "runId": "job1",
        "source": "x-md",
        "terminal": "complete",
        "request": {"origin": "https://mdfromx.com", "resource": "archive", "input": handle},
        "records": [{
            "receivedAt": 1_758_000_000_000_i64,
            "payload": {"posts": [post(id, handle, provider_id)]},
        }],
    })
}

const fn succeeded_report(handle: &str) -> ImportReport<'_> {
    ImportReport {
        handle,
        outcome: ImportOutcome::Succeeded,
        provider_account_id: None,
        run_id: None,
        capture_ids: Vec::new(),
    }
}

#[test]
fn disabled_sender_is_a_true_no_op() {
    let dir = tempfile::tempdir().unwrap();
    let engine = engine(dir.path()).unwrap();
    let mut registry = Registry::default();
    report_after_import(None, &engine, &mut registry, &succeeded_report("alice"));
    assert!(
        registry.publications.is_empty(),
        "no config must mean nothing is recorded, not just nothing sent"
    );
}

#[test]
fn envelope_matches_the_receiver_contract_shape_on_success() {
    let dir = tempfile::tempdir().unwrap();
    let engine = engine(dir.path()).unwrap();
    let mut registry = Registry::default();
    let (url, rx) = spawn_responder(
        "HTTP/1.1 200 OK",
        r#"{"outcome":"applied","committedGeneration":1}"#,
    )
    .unwrap();
    let config = PublishConfig {
        url,
        token: "secret-token".to_owned(),
    };
    let report = ImportReport {
        handle: "alice",
        outcome: ImportOutcome::Succeeded,
        provider_account_id: Some("12345"),
        run_id: Some("job1"),
        capture_ids: vec!["a".repeat(64)],
    };
    report_after_import(Some(&config), &engine, &mut registry, &report);

    let request = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/publication/update");
    assert_eq!(
        request.headers.get("authorization").map(String::as_str),
        Some("Bearer secret-token")
    );
    assert!(
        request.headers.contains_key("idempotency-key"),
        "must carry an Idempotency-Key header"
    );

    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
    let keys: std::collections::BTreeSet<&str> = body
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    // Exactly the fields a "searchable" report with a full identity needs —
    // convex/publication.ts's parseEnvelope 400s on any unlisted key, so an
    // extra key here would be a real regression, not a style nit.
    let expected: std::collections::BTreeSet<&str> = [
        "version",
        "providerAccountId",
        "handle",
        "runId",
        "captureIds",
        "generation",
        "reportedState",
        "uniquePostCount",
        "uniquePostCountAsOf",
        "observedAt",
    ]
    .into_iter()
    .collect();
    assert_eq!(keys, expected);
    assert_eq!(body["version"], 1);
    assert_eq!(body["handle"], "alice");
    assert_eq!(body["providerAccountId"], "12345");
    assert_eq!(body["runId"], "job1");
    assert_eq!(body["reportedState"], "searchable");
    assert_eq!(body["generation"], 1);
    assert_eq!(
        body["uniquePostCount"], 0,
        "no posts were ever imported for alice in this test"
    );

    let record = registry.publications.get("alice").unwrap();
    assert_eq!(record.generation, 1);
    assert_eq!(record.last_unique_post_count, Some(0));
    assert!(record.last_publish_error.is_none());
    assert!(!record.transport_retry_pending);
}

#[test]
fn a_per_handle_dump_sends_handle_only_with_empty_capture_ids() {
    let dir = tempfile::tempdir().unwrap();
    let engine = engine(dir.path()).unwrap();
    let mut registry = Registry::default();
    let (url, rx) = spawn_responder("HTTP/1.1 200 OK", r#"{"outcome":"applied"}"#).unwrap();
    let config = PublishConfig {
        url,
        token: "t".to_owned(),
    };
    report_after_import(
        Some(&config),
        &engine,
        &mut registry,
        &succeeded_report("bob"),
    );

    let request = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
    assert_eq!(body["handle"], "bob");
    assert_eq!(body["captureIds"], serde_json::json!([]));
    assert!(
        body.get("providerAccountId").is_none(),
        "per-handle dumps have no profile id"
    );
    assert!(
        body.get("runId").is_none(),
        "per-handle dumps have no runId"
    );
}

#[test]
fn failed_import_reports_failed_with_the_verbatim_error_and_never_a_count() {
    let dir = tempfile::tempdir().unwrap();
    let engine = engine(dir.path()).unwrap();
    let mut registry = Registry::default();
    let (url, rx) = spawn_responder("HTTP/1.1 200 OK", r#"{"outcome":"applied"}"#).unwrap();
    let config = PublishConfig {
        url,
        token: "t".to_owned(),
    };
    let report = ImportReport {
        handle: "carol",
        outcome: ImportOutcome::Failed("archive checksum mismatch"),
        provider_account_id: None,
        run_id: None,
        capture_ids: Vec::new(),
    };
    report_after_import(Some(&config), &engine, &mut registry, &report);

    let request = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
    let keys: std::collections::BTreeSet<&str> = body
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    let expected: std::collections::BTreeSet<&str> = [
        "version",
        "handle",
        "captureIds",
        "generation",
        "reportedState",
        "error",
        "observedAt",
    ]
    .into_iter()
    .collect();
    assert_eq!(
        keys, expected,
        "a failed report must never carry uniquePostCount/uniquePostCountAsOf"
    );
    assert_eq!(body["reportedState"], "failed");
    assert_eq!(body["error"]["message"], "archive checksum mismatch");
    assert!(body.get("uniquePostCount").is_none());
}

#[test]
fn generation_increments_once_per_delivered_send_and_survives_a_reload() {
    let dir = tempfile::tempdir().unwrap();
    let state_dir = tempfile::tempdir().unwrap();
    let engine = engine(dir.path()).unwrap();
    let path = search_indexer::users::registry_path(state_dir.path());
    let mut registry = Registry::default();

    let (url1, rx1) = spawn_responder("HTTP/1.1 200 OK", r#"{"outcome":"applied"}"#).unwrap();
    let config = PublishConfig {
        url: url1,
        token: "t".to_owned(),
    };
    report_after_import(
        Some(&config),
        &engine,
        &mut registry,
        &succeeded_report("dana"),
    );
    rx1.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
    assert_eq!(registry.publications.get("dana").unwrap().generation, 1);
    registry.save(&path).unwrap();

    // Simulate a restart: reload from disk before sending the next update.
    let mut registry = Registry::load(&path).unwrap();
    assert_eq!(
        registry.publications.get("dana").unwrap().generation,
        1,
        "generation must survive a restart"
    );

    let (url2, rx2) = spawn_responder("HTTP/1.1 200 OK", r#"{"outcome":"applied"}"#).unwrap();
    let config = PublishConfig {
        url: url2,
        token: "t".to_owned(),
    };
    report_after_import(
        Some(&config),
        &engine,
        &mut registry,
        &succeeded_report("dana"),
    );
    let second_request = rx2.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
    let body: serde_json::Value = serde_json::from_slice(&second_request.body).unwrap();
    assert_eq!(
        body["generation"], 2,
        "generation must increase by exactly one per delivered send"
    );
    assert_eq!(registry.publications.get("dana").unwrap().generation, 2);
}

#[test]
fn a_permanent_rejection_still_consumes_the_generation_and_does_not_spin() {
    let dir = tempfile::tempdir().unwrap();
    let engine = engine(dir.path()).unwrap();
    let mut registry = Registry::default();
    let (url, rx) = spawn_responder(
        "HTTP/1.1 401 Unauthorized",
        r#"{"outcome":"rejected_unauthorized"}"#,
    )
    .unwrap();
    let config = PublishConfig {
        url,
        token: "wrong".to_owned(),
    };
    report_after_import(
        Some(&config),
        &engine,
        &mut registry,
        &succeeded_report("erin"),
    );
    rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();

    let record = registry.publications.get("erin").unwrap();
    assert_eq!(
        record.generation, 1,
        "a delivered rejection still spends the generation it used"
    );
    assert!(
        record
            .last_publish_error
            .as_deref()
            .unwrap_or_default()
            .contains("401")
    );
    assert!(
        !record.transport_retry_pending,
        "a permanent rejection must not be flagged for automatic retry — that would spin on identical content"
    );
}

#[test]
fn a_transport_failure_never_consumes_a_generation_and_is_flagged_for_retry() {
    let dir = tempfile::tempdir().unwrap();
    let engine = engine(dir.path()).unwrap();
    let mut registry = Registry::default();
    // Bind and immediately drop a listener to get a port nothing is
    // listening on, so the connect fails fast and deterministically
    // instead of relying on a timeout.
    let probe = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = probe.local_addr().unwrap();
    drop(probe);
    let config = PublishConfig {
        url: format!("http://{addr}/publication/update"),
        token: "t".to_owned(),
    };
    report_after_import(
        Some(&config),
        &engine,
        &mut registry,
        &succeeded_report("frank"),
    );

    let record = registry.publications.get("frank").unwrap();
    assert_eq!(
        record.generation, 0,
        "nothing was ever delivered, so no generation was spent"
    );
    assert!(
        record.transport_retry_pending,
        "a later pass must retry this account"
    );
    assert!(record.last_publish_error.is_some());
}

#[test]
fn an_https_url_is_wired_through_report_after_import_as_an_ordinary_transport_failure() {
    // report_after_import/Registry treat an https:// transport failure
    // exactly like an http:// one: no crash, no generation spent, flagged
    // for retry. The dedicated proof that https:// genuinely attempts TLS
    // (rather than silently downgrading to plaintext) lives in
    // `publish::transport`'s own fast unit tests, against a real peer; this
    // test only needs an unreachable port, so it stays fast here too.
    let dir = tempfile::tempdir().unwrap();
    let engine = engine(dir.path()).unwrap();
    let mut registry = Registry::default();
    let probe = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = probe.local_addr().unwrap();
    drop(probe);
    let config = PublishConfig {
        url: format!("https://{addr}/publication/update"),
        token: "t".to_owned(),
    };
    report_after_import(
        Some(&config),
        &engine,
        &mut registry,
        &succeeded_report("grace"),
    );

    let record = registry.publications.get("grace").unwrap();
    assert_eq!(
        record.generation, 0,
        "a failed connection is not a delivered response"
    );
    assert!(record.transport_retry_pending);
    assert!(
        record
            .last_publish_error
            .as_deref()
            .is_some_and(|error| !error.is_empty()),
        "the error must say why, not fail silently: {:?}",
        record.last_publish_error
    );
}

#[test]
fn an_old_registry_with_no_publication_field_loads_without_quarantine() {
    let state_dir = tempfile::tempdir().unwrap();
    let path = search_indexer::users::registry_path(state_dir.path());
    // Shaped exactly like users.rs's own module doc example, scaled up to
    // 239 entries and — critically — with no "publications" key anywhere,
    // as a real pre-existing users.json from before this feature existed
    // would be.
    let mut users = serde_json::Map::new();
    for n in 0..239 {
        let handle = format!("user{n}");
        users.insert(
            handle,
            serde_json::json!({
                "status": "complete",
                "attempts": 2,
                "accepted": 150,
                "rejected": 0,
                "sha256": "ab12",
                "fileSig": "ab12",
                "updatedAtMs": 1_758_000_000_000_i64,
            }),
        );
    }
    let legacy = serde_json::json!({
        "version": 1,
        "users": users,
        "captures": {},
    });
    std::fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();

    let registry = Registry::load(&path).unwrap();
    assert_eq!(registry.users.len(), 239);
    assert!(registry.publications.is_empty());
    let no_bad_files = std::fs::read_dir(state_dir.path())
        .unwrap()
        .flatten()
        .all(|entry| !entry.file_name().to_string_lossy().contains(".bad-"));
    assert!(
        no_bad_files,
        "a users.json merely missing the new field must never be quarantined"
    );

    // And the registry must still be fully usable and re-savable afterward.
    registry.save(&path).unwrap();
    let reloaded = Registry::load(&path).unwrap();
    assert_eq!(reloaded.users.len(), 239);
}

#[test]
fn a_truncated_response_body_is_a_delivered_response_not_a_transport_failure() {
    // The status line arrived, so the request was delivered and the
    // generation it used is spent. Treating the failed body read as "no
    // response" would leave this account flagged for retry on every later
    // pass while the receiver has already applied the update.
    let dir = tempfile::tempdir().unwrap();
    let engine = engine(dir.path()).unwrap();
    let mut registry = Registry::default();
    let partial = r#"{"outcome":"app"#;
    let (url, rx) =
        spawn_truncating_responder("HTTP/1.1 200 OK", partial, partial.len() + 64).unwrap();
    let config = PublishConfig {
        url,
        token: "t".to_owned(),
    };
    report_after_import(
        Some(&config),
        &engine,
        &mut registry,
        &succeeded_report("heidi"),
    );
    rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();

    let record = registry.publications.get("heidi").unwrap();
    assert_eq!(
        record.generation, 1,
        "a response whose body was cut short was still delivered at this generation"
    );
    assert!(
        !record.transport_retry_pending,
        "a delivered 200 must never be retried just because its body was truncated"
    );
    assert!(
        record.last_publish_error.is_none(),
        "HTTP 200 is success regardless of how much of the body arrived: {:?}",
        record.last_publish_error
    );
}

#[test]
fn a_pending_retry_republishes_a_capture_without_reimporting_it() {
    let dir = tempfile::tempdir().unwrap();
    let sha = "c".repeat(64);
    let config = config_in(dir.path(), None).unwrap();
    let batch = capture_batch("hero", "9001", &serde_json::json!("12345"));
    std::fs::write(
        config.drop_dir.join(format!("{sha}.json")),
        serde_json::to_vec(&batch).unwrap(),
    )
    .unwrap();

    // Pass 1: the endpoint is unreachable. The import happens; the
    // publication is left owed.
    let unreachable =
        config_in(dir.path(), Some(publishing_to(unreachable_url().unwrap()))).unwrap();
    let registry = search_indexer::run_once(&unreachable).unwrap();
    assert_eq!(registry.captures.get(&sha).unwrap().accepted, 1);
    assert!(
        registry
            .publications
            .get("hero")
            .unwrap()
            .transport_retry_pending
    );

    // Plant a sentinel the import path would overwrite: a reimport calls
    // Registry::mark_capture, which rewrites accepted from the receipt.
    let path = search_indexer::users::registry_path(&config.state_dir);
    let mut planted = Registry::load(&path).unwrap();
    planted.captures.get_mut(&sha).unwrap().accepted = 999;
    planted.save(&path).unwrap();

    // Pass 2: the endpoint is back.
    let (url, rx) = spawn_responder("HTTP/1.1 200 OK", r#"{"outcome":"applied"}"#).unwrap();
    let live = config_in(dir.path(), Some(publishing_to(url))).unwrap();
    let registry = search_indexer::run_once(&live).unwrap();
    let request = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
    assert_eq!(body["handle"], "hero");
    assert_eq!(body["reportedState"], "searchable");
    assert_eq!(
        body["captureIds"],
        serde_json::json!([sha]),
        "the resend must still identify the capture it confirms"
    );
    assert_eq!(body["providerAccountId"], "12345");
    assert_eq!(body["runId"], "job1");
    assert_eq!(body["generation"], 1);

    assert_eq!(
        registry.captures.get(&sha).unwrap().accepted,
        999,
        "a publication retry must not re-run import/archive/index work for unchanged content"
    );
    let record = registry.publications.get("hero").unwrap();
    assert_eq!(record.generation, 1);
    assert!(!record.transport_retry_pending);
}

#[test]
fn a_pending_retry_republishes_a_user_dump_without_reimporting_it() {
    let dir = tempfile::tempdir().unwrap();
    let config = config_in(dir.path(), None).unwrap();
    let dump = serde_json::json!({"posts": [post("7001", "ivy", &serde_json::json!("42"))]});
    std::fs::write(
        config.drop_dir.join("ivy.json"),
        serde_json::to_vec(&dump).unwrap(),
    )
    .unwrap();

    let unreachable =
        config_in(dir.path(), Some(publishing_to(unreachable_url().unwrap()))).unwrap();
    let registry = search_indexer::run_once(&unreachable).unwrap();
    assert_eq!(registry.users.get("ivy").unwrap().attempts, 1);
    assert!(
        registry
            .publications
            .get("ivy")
            .unwrap()
            .transport_retry_pending
    );

    let (url, rx) = spawn_responder("HTTP/1.1 200 OK", r#"{"outcome":"applied"}"#).unwrap();
    let live = config_in(dir.path(), Some(publishing_to(url))).unwrap();
    let registry = search_indexer::run_once(&live).unwrap();
    let request = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
    assert_eq!(body["handle"], "ivy");
    assert_eq!(body["reportedState"], "searchable");
    assert_eq!(body["uniquePostCount"], 1);

    let record = registry.users.get("ivy").unwrap();
    assert_eq!(
        record.attempts, 1,
        "the dump's bytes never changed: a publication retry must not import it again"
    );
    assert_eq!(record.status, search_indexer::users::UserStatus::Complete);
    let publication = registry.publications.get("ivy").unwrap();
    assert_eq!(publication.generation, 1);
    assert!(!publication.transport_retry_pending);
}
