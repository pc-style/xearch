//! A data root shaped like production's: thousands of capture batches in
//! the drop directory, every one already recorded in the registry, and an
//! index with posts in it. Shared by the work-budget tests and the indexer
//! benchmark (`benches/indexer.rs`).
#![allow(dead_code)]

use search_backend::IndexSink;
use search_indexer::{
    Config,
    users::{CaptureRecord, Registry, registry_path},
};
use std::{path::Path, time::Duration};

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

/// A capture batch's file name: 64 hex digits, as the receiver names them.
#[must_use]
pub fn capture_name(id: u64) -> String {
    format!("{id:064x}.json")
}

/// One capture batch holding `posts` posts, ids from `first`.
#[must_use]
pub fn capture(first: u64, posts: u64) -> String {
    let posts: Vec<_> = (first..first.saturating_add(posts))
        .map(|id| {
            serde_json::json!({
                "id": id.to_string(),
                "author": {"screen_name": "hero", "id": "42"},
                "text": format!("post {id} about rust and search"),
                "created_timestamp": 1_758_000_000_i64,
                "likes": id % 97,
            })
        })
        .collect();
    serde_json::json!({
        "version": 1,
        "runId": "run",
        "source": "x-md",
        "terminal": "complete",
        "request": {"origin": "https://mdfromx.com", "resource": "live", "input": "from:hero"},
        "records": [{"receivedAt": 1, "payload": {"posts": posts}}],
    })
    .to_string()
}

#[must_use]
pub fn config_in(dir: &Path) -> Config {
    Config {
        index: dir.join("index"),
        archive: dir.join("archive"),
        drop_dir: dir.join("drop"),
        state_dir: dir.join("state"),
        poll_interval: Duration::from_secs(1),
        publish: None,
        health: None,
    }
}

/// `captures` batches in the drop directory, all recorded as imported, and
/// an index holding one post: what a watcher pass finds between imports.
///
/// # Errors
/// Returns filesystem and index errors.
pub fn imported_root(dir: &Path, captures: u64) -> Result<Config> {
    let config = config_in(dir);
    std::fs::create_dir_all(&config.drop_dir)?;
    let mut registry = Registry::default();
    let body = capture(1, 1);
    for id in 0..captures {
        let name = capture_name(id);
        std::fs::write(config.drop_dir.join(&name), &body)?;
        registry.captures.insert(
            name.trim_end_matches(".json").to_owned(),
            CaptureRecord {
                handle: Some("hero".into()),
                accepted: 1,
                rejected: 0,
                updated_at_ms: 1_790_000_000_000,
            },
        );
    }
    registry.save(&registry_path(&config.state_dir))?;
    let engine = search_tantivy::open(&config.index, true)?;
    let mut writer = engine.writer()?;
    let post = search_ingest::normalize(&serde_json::json!({
        "id": "1",
        "author": {"screen_name": "hero", "id": "42"},
        "text": "hello",
        "created_timestamp": 1_758_000_000_i64,
    }))?;
    writer.upsert(&post)?;
    writer.commit()?;
    Ok(config)
}

/// An archive of `captures` batches of `posts` posts each and an empty
/// index: what a rebuild reads.
///
/// # Errors
/// Returns filesystem and index errors.
pub fn archived_root(dir: &Path, captures: u64, posts: u64) -> Result<Config> {
    let config = config_in(dir);
    std::fs::create_dir_all(&config.archive)?;
    for id in 0..captures {
        std::fs::write(
            config.archive.join(capture_name(id)),
            capture(id.saturating_mul(posts).saturating_add(1), posts),
        )?;
    }
    search_tantivy::open(&config.index, true)?;
    Ok(config)
}

/// Bytes this thread has read and written through system calls so far
/// (`rchar`, `wchar` in `/proc/thread-self/io`). Exact, unlike timings, and
/// blind to other tests running on other threads. Linux only.
///
/// # Errors
/// Returns an error where the kernel does not report them.
pub fn thread_io() -> Result<(u64, u64)> {
    let text = std::fs::read_to_string("/proc/thread-self/io")?;
    let field = |name: &str| -> Result<u64> {
        let value = text
            .lines()
            .find_map(|line| line.strip_prefix(name))
            .ok_or_else(|| format!("no {name} in /proc/thread-self/io"))?;
        Ok(value.trim().parse()?)
    };
    Ok((field("rchar:")?, field("wchar:")?))
}
