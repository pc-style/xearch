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
///
/// Accepting only one connection is deliberate in the tests that use it: a
/// second send in the same pass would come back as a transport failure and
/// be visible in the registry, so "nothing else was sent" is an assertion,
/// not an assumption.
fn spawn_responder(
    status_line: &'static str,
    response_body: &'static str,
) -> std::io::Result<(String, Receiver<CapturedRequest>)> {
    spawn_responder_for(1, status_line, response_body)
}

/// As [`spawn_responder`], but serving `connections` requests in turn — for
/// the cases where one pass legitimately sends more than one update (an
/// owed update resolved, then the follow-on carrying what stood down
/// behind it).
fn spawn_responder_for(
    connections: usize,
    status_line: &'static str,
    response_body: &'static str,
) -> std::io::Result<(String, Receiver<CapturedRequest>)> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let addr = listener.local_addr()?;
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        for _ in 0..connections {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
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

/// Build a sender config the only way there is: through the validated
/// constructor. Every test below therefore also proves that a plain-HTTP
/// loopback endpoint is still accepted — the check added for cleartext
/// credentials never made the local responder harder to point at.
fn publishing_to(url: String) -> search_model::Result<PublishConfig> {
    PublishConfig::new(url, "t")
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
    capture_batch_from_run(handle, id, provider_id, "job1")
}

fn capture_batch_from_run(
    handle: &str,
    id: &str,
    provider_id: &serde_json::Value,
    run_id: &str,
) -> serde_json::Value {
    serde_json::json!({
        "version": 1,
        "runId": run_id,
        "source": "x-md",
        "terminal": "complete",
        "request": {"origin": "https://mdfromx.com", "resource": "archive", "input": handle},
        "records": [{
            "receivedAt": 1_758_000_000_000_i64,
            "payload": {"posts": [post(id, handle, provider_id)]},
        }],
    })
}

/// Write one capture batch into a drop directory under its content hash.
fn write_capture_file(
    drop_dir: &std::path::Path,
    sha: &str,
    handle: &str,
    post_id: &str,
    provider_account_id: &str,
    run_id: &str,
) -> std::io::Result<()> {
    let batch = capture_batch_from_run(
        handle,
        post_id,
        &serde_json::json!(provider_account_id),
        run_id,
    );
    std::fs::write(
        drop_dir.join(format!("{sha}.json")),
        serde_json::to_vec(&batch).map_err(std::io::Error::other)?,
    )
}

/// The next request body the responder captured, decoded as JSON.
fn next_body(rx: &Receiver<CapturedRequest>) -> Option<serde_json::Value> {
    let request = rx.recv_timeout(std::time::Duration::from_secs(5)).ok()?;
    serde_json::from_slice(&request.body).ok()
}

/// Report one succeeded capture import for `handle`, through whatever
/// endpoint `url` names.
fn report_capture(
    url: String,
    engine: &search_tantivy::Engine,
    registry: &mut Registry,
    handle: &str,
    run_id: &str,
    capture_id: &str,
) -> search_model::Result<()> {
    report_after_import(
        Some(&publishing_to(url)?),
        engine,
        registry,
        &ImportReport {
            handle,
            outcome: ImportOutcome::Succeeded,
            provider_account_id: Some("42"),
            run_id: Some(run_id),
            capture_ids: vec![capture_id.to_owned()],
        },
    );
    Ok(())
}

/// Two capture batches and one per-handle dump, all for `@twin`. Sorted
/// candidate order is `aaa….json` < `bbb….json` < `twin.json`, so the
/// first batch is the one that reserves the generation. Returns the two
/// capture ids.
fn seed_twin_drop(drop_dir: &std::path::Path) -> std::io::Result<(String, String)> {
    let first = "a".repeat(64);
    let second = "b".repeat(64);
    write_capture_file(drop_dir, &first, "twin", "5001", "777", "run-first")?;
    write_capture_file(drop_dir, &second, "twin", "5002", "777", "run-second")?;
    let dump = serde_json::json!({"posts": [post("5003", "twin", &serde_json::json!("777"))]});
    std::fs::write(
        drop_dir.join("twin.json"),
        serde_json::to_vec(&dump).map_err(std::io::Error::other)?,
    )?;
    Ok((first, second))
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
    let config = PublishConfig::new(url, "secret-token").unwrap();
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
    let config = PublishConfig::new(url, "t").unwrap();
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
    let config = PublishConfig::new(url, "t").unwrap();
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
    let config = PublishConfig::new(url1, "t").unwrap();
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
    let config = PublishConfig::new(url2, "t").unwrap();
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
    let config = PublishConfig::new(url, "wrong").unwrap();
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
    let config = PublishConfig::new(format!("http://{addr}/publication/update"), "t").unwrap();
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
    let config = PublishConfig::new(format!("https://{addr}/publication/update"), "t").unwrap();
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
    let config = PublishConfig::new(url, "t").unwrap();
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
    let unreachable = config_in(
        dir.path(),
        Some(publishing_to(unreachable_url().unwrap()).unwrap()),
    )
    .unwrap();
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
    let live = config_in(dir.path(), Some(publishing_to(url).unwrap())).unwrap();
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

    let unreachable = config_in(
        dir.path(),
        Some(publishing_to(unreachable_url().unwrap()).unwrap()),
    )
    .unwrap();
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
    let live = config_in(dir.path(), Some(publishing_to(url).unwrap())).unwrap();
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

/// The reviewer's case: two capture batches and one per-handle dump all
/// belonging to `@twin`, an outage, then recovery.
///
/// The outage must leave exactly one owed update — the one that reserved
/// the generation — and recovery must resend *that* update: its own
/// `captureIds`, `runId`, `providerAccountId` and its own post count, not
/// whatever the next candidate file in the drop directory happens to say.
/// `captureIds` is what marks captures confirmed on the Convex side, so a
/// resend built from a different file confirms the wrong captures.
#[test]
fn an_outage_owes_one_update_and_recovery_resends_exactly_it() {
    let dir = tempfile::tempdir().unwrap();
    let config = config_in(dir.path(), None).unwrap();
    // Sorted candidate order is first.json < second.json < twin.json, so
    // the first batch is the one that reserves the generation.
    let (first, second) = seed_twin_drop(&config.drop_dir).unwrap();

    // The outage. Everything imports; nothing can be reported.
    let unreachable = config_in(
        dir.path(),
        Some(publishing_to(unreachable_url().unwrap()).unwrap()),
    )
    .unwrap();
    let registry = search_indexer::run_once(&unreachable).unwrap();
    assert_eq!(registry.captures.len(), 2);
    assert_eq!(
        registry.users.get("twin").unwrap().status,
        search_indexer::users::UserStatus::Complete
    );
    assert_eq!(
        registry.publications.len(),
        1,
        "three files, one account: one publication record"
    );
    let owed = registry.publications.get("twin").unwrap();
    assert_eq!(
        owed.generation, 0,
        "nothing was delivered, so no generation was spent"
    );
    assert!(owed.transport_retry_pending);
    let pending = owed
        .pending
        .as_ref()
        .expect("the owed update itself must be stored, not just the fact that something is owed");
    assert_eq!(
        pending.capture_ids,
        vec![first.clone()],
        "the stored update is the one that reserved the generation"
    );
    assert_eq!(pending.run_id.as_deref(), Some("run-first"));
    assert_eq!(pending.provider_account_id.as_deref(), Some("777"));
    assert_eq!(
        pending.unique_post_count,
        Some(1),
        "the count as it was when the reserved update was built"
    );
    let deferred = owed
        .deferred
        .as_ref()
        .expect("the two imports that stood down must have left their identity behind");
    assert_eq!(
        deferred.capture_ids,
        vec![second.clone()],
        "the second capture's id is held for a follow-on; the dump has no id to hold"
    );

    // Recovery. Two connections: the owed update, then the follow-on that
    // confirms what stood down behind it. A third send would come back as
    // a transport failure and leave a pending update behind — asserted
    // against below.
    let (url, rx) = spawn_responder_for(2, "HTTP/1.1 200 OK", r#"{"outcome":"applied"}"#).unwrap();
    let live = config_in(dir.path(), Some(publishing_to(url).unwrap())).unwrap();
    let registry = search_indexer::run_once(&live).unwrap();
    let body = next_body(&rx).unwrap();
    assert_eq!(body["handle"], "twin");
    assert_eq!(
        body["captureIds"],
        serde_json::json!([first]),
        "the resend must confirm the captures the original attempt claimed, not another file's"
    );
    assert_eq!(body["runId"], "run-first");
    assert_eq!(body["providerAccountId"], "777");
    assert_eq!(body["generation"], 1);
    assert_eq!(body["reportedState"], "searchable");
    assert_eq!(
        body["uniquePostCount"], 1,
        "the resend replays the original update, not a freshly recounted one (three posts are \
         indexed by now)"
    );

    // The follow-on: the second capture imported during the outage is
    // never imported again (its hash is recorded), so this update is the
    // only thing that can ever confirm it.
    let body = next_body(&rx).expect("the follow-on must go out, not be dropped");
    assert_eq!(body["handle"], "twin");
    assert_eq!(
        body["captureIds"],
        serde_json::json!([second]),
        "the follow-on confirms the capture that stood down, not an empty list"
    );
    assert_eq!(body["runId"], "run-second");
    assert_eq!(
        body["generation"], 2,
        "the follow-on is a new update at the next generation, not a replay"
    );
    assert_eq!(
        body["uniquePostCount"], 3,
        "a new update carries a freshly counted number: all three posts are indexed by now"
    );

    let record = registry.publications.get("twin").unwrap();
    assert_eq!(record.generation, 2);
    assert!(!record.transport_retry_pending);
    assert!(
        record.pending.is_none(),
        "both sends were answered, and nothing else was sent in that pass: {:?}",
        record.pending
    );
    assert!(
        record.deferred.is_none(),
        "what stood down has been confirmed and must not be sent a second time: {:?}",
        record.deferred
    );
}

/// A replay must reuse the generation the failed attempt reserved, never
/// allocate a fresh one — the receiver's idempotency is generation-based,
/// so a replay at a new number reads as a new update. And while that
/// generation is reserved, a *different* update must not borrow it:
/// `docs/publication-contract.md` calls a duplicate generation carrying
/// different content a sender-side bug outright.
#[test]
fn a_replay_reuses_the_reserved_generation_and_no_other_update_borrows_it() {
    let dir = tempfile::tempdir().unwrap();
    let engine = engine(dir.path()).unwrap();
    let mut registry = Registry::default();

    // One delivered update, so the account's watermark is a real number
    // rather than zero and an off-by-one would be visible.
    let (first_url, first_rx) =
        spawn_responder("HTTP/1.1 200 OK", r#"{"outcome":"applied"}"#).unwrap();
    report_capture(
        first_url,
        &engine,
        &mut registry,
        "zoe",
        "run-a",
        &"a".repeat(64),
    )
    .unwrap();
    first_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    assert_eq!(registry.publications.get("zoe").unwrap().generation, 1);

    // The outage: generation 2 is reserved for this update and never spent.
    report_capture(
        unreachable_url().unwrap(),
        &engine,
        &mut registry,
        "zoe",
        "run-b",
        &"b".repeat(64),
    )
    .unwrap();
    assert_eq!(
        registry.publications.get("zoe").unwrap().generation,
        1,
        "an undelivered send spends nothing"
    );

    // A different import for the same account while that generation is
    // reserved: it must not go out at all.
    let (blocked_url, blocked_rx) =
        spawn_responder("HTTP/1.1 200 OK", r#"{"outcome":"applied"}"#).unwrap();
    report_capture(
        blocked_url,
        &engine,
        &mut registry,
        "zoe",
        "run-c",
        &"c".repeat(64),
    )
    .unwrap();
    assert!(
        blocked_rx
            .recv_timeout(std::time::Duration::from_millis(500))
            .is_err(),
        "a different update must never be sent at a generation another update reserved"
    );
    assert_eq!(
        registry
            .publications
            .get("zoe")
            .unwrap()
            .pending
            .as_ref()
            .unwrap()
            .run_id
            .as_deref(),
        Some("run-b"),
        "the owed update is not replaced by a newer one"
    );
    assert_eq!(
        registry
            .publications
            .get("zoe")
            .unwrap()
            .deferred
            .as_ref()
            .expect("standing down must keep what the import would have confirmed")
            .capture_ids,
        vec!["c".repeat(64)],
        "standing down must not discard what the import would have confirmed"
    );

    // Recovery: the replay goes out at the reserved generation 2, and the
    // update that stood down behind it follows at generation 3.
    let (replay_url, replay_rx) =
        spawn_responder_for(2, "HTTP/1.1 200 OK", r#"{"outcome":"applied"}"#).unwrap();
    search_indexer::publish::replay_pending(
        Some(&publishing_to(replay_url).unwrap()),
        &engine,
        &mut registry,
        "zoe",
    );
    let body = next_body(&replay_rx).unwrap();
    assert_eq!(
        body["generation"], 2,
        "a replay reuses the generation the failed attempt reserved"
    );
    assert_eq!(body["runId"], "run-b");
    assert_eq!(body["captureIds"], serde_json::json!(["b".repeat(64)]));

    let body = next_body(&replay_rx).expect("what stood down must follow, not be dropped");
    assert_eq!(
        body["generation"], 3,
        "the update that stood down goes out at its own fresh generation, never the reserved one"
    );
    assert_eq!(body["runId"], "run-c");
    assert_eq!(body["captureIds"], serde_json::json!(["c".repeat(64)]));
    let record = registry.publications.get("zoe").unwrap();
    assert_eq!(record.generation, 3);
    assert!(record.pending.is_none());
    assert!(record.deferred.is_none());
}

/// A `users.json` written by the build that shipped before the owed update
/// was recorded — `publications` present, `transportRetryPending: true`,
/// no `pending` — must load unquarantined, and the flag it carries must
/// not be turned into an invented update.
#[test]
fn a_registry_from_before_pending_updates_loads_and_is_never_replayed_from_guesswork() {
    let dir = tempfile::tempdir().unwrap();
    let config = config_in(dir.path(), None).unwrap();
    let path = search_indexer::users::registry_path(&config.state_dir);
    std::fs::create_dir_all(&config.state_dir).unwrap();
    let legacy = serde_json::json!({
        "version": 1,
        "users": {
            "old": {
                "status": "complete",
                "attempts": 1,
                "accepted": 3,
                "rejected": 0,
                "sha256": "ab12",
                "fileSig": "ab12",
                "fileName": "old.json",
                "updatedAtMs": 1_758_000_000_000_i64,
            }
        },
        "captures": {},
        "publications": {
            "old": {
                "generation": 7,
                "lastUniquePostCount": 3,
                "lastPublishedAtMs": 1_758_000_000_000_i64,
                "lastPublishError": "connection refused",
                "transportRetryPending": true,
            }
        },
    });
    std::fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();

    let loaded = Registry::load(&path).unwrap();
    assert_eq!(loaded.publications.get("old").unwrap().generation, 7);
    assert!(
        loaded
            .publications
            .get("old")
            .unwrap()
            .transport_retry_pending,
        "the old flag still loads"
    );
    assert!(loaded.publications.get("old").unwrap().pending.is_none());

    // A pass with a live endpoint must not invent an update for that flag.
    let (url, rx) = spawn_responder("HTTP/1.1 200 OK", r#"{"outcome":"applied"}"#).unwrap();
    let live = config_in(dir.path(), Some(publishing_to(url).unwrap())).unwrap();
    let registry = search_indexer::run_once(&live).unwrap();
    assert!(
        rx.recv_timeout(std::time::Duration::from_millis(500))
            .is_err(),
        "nothing is known about what was owed, so nothing may be sent"
    );
    let record = registry.publications.get("old").unwrap();
    assert_eq!(record.generation, 7, "no generation is spent either");
    assert!(
        !record.transport_retry_pending,
        "the unreplayable flag is cleared rather than retried forever"
    );
    let no_bad_files = std::fs::read_dir(&config.state_dir)
        .unwrap()
        .flatten()
        .all(|entry| !entry.file_name().to_string_lossy().contains(".bad-"));
    assert!(
        no_bad_files,
        "an older-shaped registry must never be quarantined"
    );
}

/// An owed update survives the registry round-trip whole: a restart in the
/// middle of an outage must replay the same bytes, not a subset of them.
#[test]
fn an_owed_update_round_trips_through_the_registry_file() {
    let dir = tempfile::tempdir().unwrap();
    let engine = engine(dir.path()).unwrap();
    let state_dir = tempfile::tempdir().unwrap();
    let path = search_indexer::users::registry_path(state_dir.path());
    let mut registry = Registry::default();
    report_after_import(
        Some(&publishing_to(unreachable_url().unwrap()).unwrap()),
        &engine,
        &mut registry,
        &ImportReport {
            handle: "rory",
            outcome: ImportOutcome::Failed("archive checksum mismatch"),
            provider_account_id: Some("9"),
            run_id: Some("run-z"),
            capture_ids: vec!["d".repeat(64)],
        },
    );
    registry.save(&path).unwrap();
    let reloaded = Registry::load(&path).unwrap();
    assert_eq!(
        reloaded.publications.get("rory").unwrap().pending,
        registry.publications.get("rory").unwrap().pending,
        "every field of the owed update must survive the restart"
    );
    let pending = reloaded
        .publications
        .get("rory")
        .unwrap()
        .pending
        .clone()
        .unwrap();
    assert_eq!(
        pending.reported_state,
        Some(search_indexer::users::ReportedState::Failed)
    );
    assert_eq!(pending.error.as_deref(), Some("archive checksum mismatch"));
    assert!(
        pending.observed_at_ms > 0,
        "observedAt is replayed verbatim"
    );
    assert!(pending.unique_post_count.is_none());
}

/// The reviewer's case, exactly: capture A's publication never gets a
/// response, capture B imports while A is still owed, and A's replay only
/// succeeds on a later pass.
///
/// B's file is recorded the moment it imports, so the importer will never
/// look at it again — if B's capture id is dropped when B stands down,
/// nothing will ever tell Convex that B was processed. B is then in the
/// index and invisible in the product forever. The follow-on update is the
/// only thing that can close that, so it must go out and it must name B.
#[test]
fn a_capture_imported_while_an_update_was_owed_is_still_confirmed_later() {
    let dir = tempfile::tempdir().unwrap();
    let scratch = config_in(dir.path(), None).unwrap();
    let first = "a".repeat(64);
    let second = "b".repeat(64);
    write_capture_file(
        &scratch.drop_dir,
        &first,
        "quinn",
        "6001",
        "555",
        "run-first",
    )
    .unwrap();

    // Pass 1: capture A imports; the endpoint is down, so A's update is
    // owed and holds generation 1.
    let unreachable = config_in(
        dir.path(),
        Some(publishing_to(unreachable_url().unwrap()).unwrap()),
    )
    .unwrap();
    let registry = search_indexer::run_once(&unreachable).unwrap();
    assert!(
        registry
            .publications
            .get("quinn")
            .unwrap()
            .pending
            .is_some()
    );
    assert_eq!(registry.publications.get("quinn").unwrap().generation, 0);

    // Pass 2: still down. A's replay fails again, and capture B arrives
    // and imports behind it.
    write_capture_file(
        &scratch.drop_dir,
        &second,
        "quinn",
        "6002",
        "555",
        "run-second",
    )
    .unwrap();
    let registry = search_indexer::run_once(&unreachable).unwrap();
    assert!(
        registry.captures.contains_key(&second),
        "B imported, so the importer will skip its file on every later pass — this is why its \
         capture id cannot simply be dropped"
    );
    let record = registry.publications.get("quinn").unwrap();
    assert_eq!(
        record.pending.as_ref().unwrap().capture_ids,
        vec![first.clone()],
        "the owed update is still A's"
    );
    assert_eq!(
        record
            .deferred
            .as_ref()
            .expect("B's capture id must be held against the account, not discarded")
            .capture_ids,
        vec![second.clone()],
        "B's capture id must be held against the account, not discarded"
    );

    // Pass 3: the endpoint is back. A's replay goes out at its reserved
    // generation, then B is confirmed by a follow-on at the next one.
    let (url, rx) = spawn_responder_for(2, "HTTP/1.1 200 OK", r#"{"outcome":"applied"}"#).unwrap();
    let live = config_in(dir.path(), Some(publishing_to(url).unwrap())).unwrap();
    let registry = search_indexer::run_once(&live).unwrap();

    let replay = next_body(&rx).unwrap();
    assert_eq!(replay["captureIds"], serde_json::json!([first]));
    assert_eq!(replay["generation"], 1);

    let follow_on =
        next_body(&rx).expect("B must be confirmed by a follow-on update, not silently dropped");
    assert_eq!(
        follow_on["captureIds"],
        serde_json::json!([second]),
        "the follow-on must name the capture it confirms, not go out handle-only"
    );
    assert_eq!(follow_on["handle"], "quinn");
    assert_eq!(follow_on["runId"], "run-second");
    assert_eq!(follow_on["providerAccountId"], "555");
    assert_eq!(follow_on["reportedState"], "searchable");
    assert_eq!(follow_on["generation"], 2);
    assert_eq!(
        follow_on["uniquePostCount"], 2,
        "a new update reports a freshly counted number: both captures are indexed"
    );

    let record = registry.publications.get("quinn").unwrap();
    assert_eq!(record.generation, 2);
    assert!(record.pending.is_none());
    assert!(
        record.deferred.is_none(),
        "confirmed once, never sent again: {:?}",
        record.deferred
    );

    // And a further pass sends nothing at all: the follow-on is not a
    // retry loop.
    let (quiet_url, quiet_rx) =
        spawn_responder("HTTP/1.1 200 OK", r#"{"outcome":"applied"}"#).unwrap();
    let quiet = config_in(dir.path(), Some(publishing_to(quiet_url).unwrap())).unwrap();
    search_indexer::run_once(&quiet).unwrap();
    assert!(
        quiet_rx
            .recv_timeout(std::time::Duration::from_millis(500))
            .is_err(),
        "nothing is owed and nothing is deferred, so a later pass must send nothing"
    );
}

/// A per-handle dump that stands down carries no capture id, but the
/// account still has something to say — and a dump followed by a capture
/// must not lose the capture's id either. Several stood-down imports
/// coalesce into one truthful follow-on.
#[test]
fn several_stood_down_imports_coalesce_into_one_follow_on() {
    let dir = tempfile::tempdir().unwrap();
    let engine = engine(dir.path()).unwrap();
    let mut registry = Registry::default();

    // An owed update reserves generation 1.
    report_after_import(
        Some(&publishing_to(unreachable_url().unwrap()).unwrap()),
        &engine,
        &mut registry,
        &ImportReport {
            handle: "nina",
            outcome: ImportOutcome::Succeeded,
            provider_account_id: None,
            run_id: None,
            capture_ids: vec!["a".repeat(64)],
        },
    );

    // Two more imports stand down behind it.
    for (capture, run) in [("b", "run-b"), ("c", "run-c")] {
        report_after_import(
            Some(&publishing_to(unreachable_url().unwrap()).unwrap()),
            &engine,
            &mut registry,
            &ImportReport {
                handle: "nina",
                outcome: ImportOutcome::Succeeded,
                provider_account_id: Some("31"),
                run_id: Some(run),
                capture_ids: vec![capture.repeat(64)],
            },
        );
    }
    let deferred = registry
        .publications
        .get("nina")
        .unwrap()
        .deferred
        .as_ref()
        .expect("imports that stood down must leave their capture ids behind");
    assert_eq!(
        deferred.capture_ids,
        vec!["b".repeat(64), "c".repeat(64)],
        "both stood-down captures must survive, in order, not just the last one"
    );
    assert_eq!(deferred.run_id.as_deref(), Some("run-c"));

    let (url, rx) = spawn_responder_for(2, "HTTP/1.1 200 OK", r#"{"outcome":"applied"}"#).unwrap();
    let config = publishing_to(url).unwrap();
    search_indexer::publish::replay_pending(Some(&config), &engine, &mut registry, "nina");
    next_body(&rx).unwrap();
    let follow_on = next_body(&rx).expect("the coalesced follow-on must go out");
    assert_eq!(
        follow_on["captureIds"],
        serde_json::json!(["b".repeat(64), "c".repeat(64)]),
        "one follow-on confirms every capture that stood down"
    );
    assert_eq!(follow_on["providerAccountId"], "31");
    assert!(
        registry
            .publications
            .get("nina")
            .unwrap()
            .deferred
            .is_none()
    );
}

/// The safety net: if the follow-on could not go out on its own — the only
/// way that happens is a post count that failed, which keeps the deferred
/// ids rather than losing them — then the next update that *does* go out
/// for the account folds them in. A deferred capture id is confirmed by
/// the first update to follow it, whichever path produces that update.
#[test]
fn a_later_import_folds_in_what_stood_down_before_it() {
    let dir = tempfile::tempdir().unwrap();
    let engine = engine(dir.path()).unwrap();
    let mut registry = Registry::default();
    registry.defer_publication(
        "omar",
        search_indexer::users::DeferredPublication {
            capture_ids: vec!["b".repeat(64)],
            run_id: Some("run-b".to_owned()),
            provider_account_id: Some("7".to_owned()),
            reported_state: Some(search_indexer::users::ReportedState::Searchable),
            error: None,
            updated_at_ms: 1_758_000_000_000_i64,
        },
    );

    let (url, rx) = spawn_responder("HTTP/1.1 200 OK", r#"{"outcome":"applied"}"#).unwrap();
    report_after_import(
        Some(&publishing_to(url).unwrap()),
        &engine,
        &mut registry,
        &ImportReport {
            handle: "omar",
            outcome: ImportOutcome::Succeeded,
            provider_account_id: None,
            run_id: Some("run-c"),
            capture_ids: vec!["c".repeat(64)],
        },
    );
    let body = next_body(&rx).unwrap();
    assert_eq!(
        body["captureIds"],
        serde_json::json!(["c".repeat(64), "b".repeat(64)]),
        "this update confirms its own capture and the one that stood down earlier"
    );
    assert_eq!(body["runId"], "run-c", "this import's own identity wins");
    assert_eq!(
        body["providerAccountId"], "7",
        "identity this import did not have is taken from what stood down"
    );
    assert!(
        registry
            .publications
            .get("omar")
            .unwrap()
            .deferred
            .is_none()
    );
}

/// A `users.json` written by the build that shipped before deferred
/// capture ids existed — `publications` with an owed `pending` object but
/// no `deferred` key — must load unquarantined and keep working.
#[test]
fn a_registry_from_before_deferred_capture_ids_loads_and_still_replays() {
    let dir = tempfile::tempdir().unwrap();
    let config = config_in(dir.path(), None).unwrap();
    let path = search_indexer::users::registry_path(&config.state_dir);
    std::fs::create_dir_all(&config.state_dir).unwrap();
    let sha = "e".repeat(64);
    let previous_build = serde_json::json!({
        "version": 1,
        "users": {},
        "captures": {
            sha.clone(): {"handle": "pat", "accepted": 1, "rejected": 0, "updatedAtMs": 1_758_000_000_000_i64},
        },
        "publications": {
            "pat": {
                "generation": 4,
                "lastUniquePostCount": 1,
                "lastPublishedAtMs": 1_758_000_000_000_i64,
                "lastPublishError": "connection refused",
                "transportRetryPending": true,
                "pending": {
                    "reportedState": "searchable",
                    "captureIds": [sha.as_str()],
                    "runId": "run-old",
                    "providerAccountId": "99",
                    "uniquePostCount": 1,
                    "uniquePostCountAsOf": 1_758_000_000_000_i64,
                    "observedAtMs": 1_758_000_000_000_i64,
                },
            }
        },
    });
    std::fs::write(&path, serde_json::to_vec(&previous_build).unwrap()).unwrap();

    let loaded = Registry::load(&path).unwrap();
    let record = loaded.publications.get("pat").unwrap();
    assert_eq!(record.generation, 4);
    assert!(
        record.deferred.is_none(),
        "a missing deferred key loads as nothing deferred, not as a parse failure"
    );
    assert_eq!(
        record.pending.as_ref().unwrap().capture_ids,
        vec![sha.clone()]
    );

    // And the owed update still replays from it, unchanged.
    let (url, rx) = spawn_responder("HTTP/1.1 200 OK", r#"{"outcome":"applied"}"#).unwrap();
    let live = config_in(dir.path(), Some(publishing_to(url).unwrap())).unwrap();
    search_indexer::run_once(&live).unwrap();
    let body = next_body(&rx).unwrap();
    assert_eq!(body["captureIds"], serde_json::json!([sha]));
    assert_eq!(body["generation"], 5);
    let no_bad_files = std::fs::read_dir(&config.state_dir)
        .unwrap()
        .flatten()
        .all(|entry| !entry.file_name().to_string_lossy().contains(".bad-"));
    assert!(
        no_bad_files,
        "an older-shaped registry must never be quarantined"
    );
}

/// Deferred capture ids are durable: a restart in the middle of an outage
/// must still confirm them.
#[test]
fn deferred_capture_ids_survive_the_registry_file() {
    let dir = tempfile::tempdir().unwrap();
    let engine = engine(dir.path()).unwrap();
    let state_dir = tempfile::tempdir().unwrap();
    let path = search_indexer::users::registry_path(state_dir.path());
    let mut registry = Registry::default();
    for (capture, run) in [("a", "run-a"), ("b", "run-b")] {
        report_after_import(
            Some(&publishing_to(unreachable_url().unwrap()).unwrap()),
            &engine,
            &mut registry,
            &ImportReport {
                handle: "sam",
                outcome: ImportOutcome::Succeeded,
                provider_account_id: Some("3"),
                run_id: Some(run),
                capture_ids: vec![capture.repeat(64)],
            },
        );
    }
    registry.save(&path).unwrap();
    let reloaded = Registry::load(&path).unwrap();
    assert_eq!(
        reloaded.publications.get("sam").unwrap().deferred,
        registry.publications.get("sam").unwrap().deferred,
        "every field of what was deferred must survive the restart"
    );
    assert_eq!(
        reloaded
            .publications
            .get("sam")
            .unwrap()
            .deferred
            .as_ref()
            .expect("deferred capture ids must survive the registry file")
            .capture_ids,
        vec!["b".repeat(64)]
    );
}

/// The bearer token travels in an `Authorization` header, so an endpoint
/// that is not encrypted is refused where the configuration is built —
/// before any request exists at all.
#[test]
fn a_non_loopback_http_endpoint_is_refused_before_any_request_is_built() {
    // 192.0.2.0/24 is RFC 5737 TEST-NET-1: it is guaranteed not to be
    // routed anywhere. A sender that actually tried this would block until
    // its 20-second global timeout, so returning instantly is itself
    // evidence that no connection was ever attempted.
    let started = std::time::Instant::now();
    let refused = PublishConfig::new("http://192.0.2.1/publication/update", "super-secret");
    let error = refused.expect_err("plain HTTP to a routable host must be refused, not sent to");
    assert!(
        started.elapsed() < std::time::Duration::from_secs(2),
        "the refusal must happen before any request: this took {:?}",
        started.elapsed()
    );
    let message = error.to_string();
    assert!(
        message.contains("PUBLICATION_UPDATE_URL"),
        "the operator must be told which variable is wrong: {message}"
    );
    assert!(
        message.contains("cleartext"),
        "and why it is wrong: {message}"
    );
    assert!(
        !message.contains("super-secret"),
        "the error must never echo the token: {message}"
    );

    for url in [
        "http://example.com/publication/update",
        "HTTP://EXAMPLE.COM/publication/update",
        "http://user:pw@example.com:8080/publication/update",
        "http://[2001:db8::1]:8080/publication/update",
        "http://127.0.0.1.example.com/publication/update",
        "ftp://example.com/publication/update",
        "/publication/update",
    ] {
        assert!(
            PublishConfig::new(url, "t").is_err(),
            "must be refused: {url}"
        );
    }
}

/// The check must not cost the loopback test endpoints anything, and must
/// not get in the way of the real `https://` deployment either.
#[test]
fn loopback_http_and_https_endpoints_are_accepted() {
    for url in [
        "http://127.0.0.1:4319/publication/update",
        "http://127.0.0.53:4319/publication/update",
        "http://localhost:4319/publication/update",
        "http://[::1]:4319/publication/update",
        "https://utmost-kudu-321.convex.site/publication/update",
        "HTTPS://utmost-kudu-321.convex.site/publication/update",
    ] {
        assert!(
            PublishConfig::new(url, "t").is_ok(),
            "must be accepted: {url}"
        );
    }
}

/// And end to end: a loopback `http://` endpoint still delivers a real
/// update through the validated constructor, exactly as before.
#[test]
fn a_loopback_http_endpoint_still_delivers() {
    let dir = tempfile::tempdir().unwrap();
    let engine = engine(dir.path()).unwrap();
    let mut registry = Registry::default();
    let (url, rx) = spawn_responder("HTTP/1.1 200 OK", r#"{"outcome":"applied"}"#).unwrap();
    assert!(url.starts_with("http://127.0.0.1:"), "{url}");
    let config = PublishConfig::new(url, "t").unwrap();
    report_after_import(
        Some(&config),
        &engine,
        &mut registry,
        &succeeded_report("tess"),
    );
    let request = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
    assert_eq!(
        request.headers.get("authorization").map(String::as_str),
        Some("Bearer t")
    );
    assert_eq!(registry.publications.get("tess").unwrap().generation, 1);
}
