//! Background indexer: poll a drop directory and import intake dumps.
//!
//! Two file kinds are accepted from the drop directory:
//!
//! - **Per-user dumps** named `<handle>.json` (case-insensitive extension).
//!   Each feeds one entry in `state_dir/users.json` (see [`users`]), marked
//!   complete, incomplete, or error.
//! - **Capture batches** named `<sha256>.json`, exactly as written by the
//!   raw-capture receiver (see `scripts/capture-server.mjs`). Each is
//!   imported exactly once, tracked by content hash; the handle is derived
//!   from the payload for reporting only.
//!
//! Imports stay idempotent: [`search_ingest::import`] retains exact input
//! bytes under a content-addressed archive name and converges on reimport,
//! so a crash between passes is safe to replay. One writer lock is held per
//! file, so a one-shot `import` can interleave between files of the same
//! pass.
//!
//! A single-instance lock (`state_dir/indexer.lock`) keeps one watcher per
//! data root; `users mark` takes the same lock so manual overrides cannot
//! be silently overwritten.
//!
//! All directories come from the caller (CLI flags or `SEARCH_*`
//! environment); nothing here assumes which machine it runs on.

pub mod users;

use search_model::{Error, Result};
use sha2::Digest;
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use users::{Registry, registry_path};

/// Upper bound on a single input file, mirroring the ingest cap.
pub const MAX_INPUT_BYTES: u64 = search_ingest::MAX_INPUT;

/// Stale temp files older than this are swept at watcher startup.
const TEMP_MAX_AGE: Duration = Duration::from_secs(3600);

/// What to watch and where postings live. Every path is caller-supplied so
/// the same binary runs on any machine via environment.
#[derive(Debug, Clone)]
pub struct Config {
    /// Tantivy index directory (created on first pass).
    pub index: PathBuf,
    /// Content-addressed archive directory.
    pub archive: PathBuf,
    /// Polled drop directory holding `<handle>.json` dumps and
    /// `<sha256>.json` capture batches.
    pub drop_dir: PathBuf,
    /// Directory holding `users.json` and `indexer.lock`.
    pub state_dir: PathBuf,
    /// Delay between passes.
    pub poll_interval: Duration,
}

impl Config {
    /// Validate bounds before watching.
    ///
    /// # Errors
    /// Returns [`Error::Invalid`] for an empty path or a zero poll interval.
    pub fn validate(&self) -> Result<()> {
        if self.index.as_os_str().is_empty()
            || self.archive.as_os_str().is_empty()
            || self.drop_dir.as_os_str().is_empty()
            || self.state_dir.as_os_str().is_empty()
        {
            return Err(Error::Invalid(
                "Index, archive, drop and state paths are required.".into(),
            ));
        }
        if self.poll_interval.is_zero() {
            return Err(Error::Invalid(
                "Poll interval must be greater than zero.".into(),
            ));
        }
        Ok(())
    }
}

/// Path of the single-instance lock (`<pid> <kind>`, kind is watch|mark).
#[must_use]
pub fn lock_path(state_dir: &Path) -> PathBuf {
    state_dir.join("indexer.lock")
}

/// A held lock; removes itself on drop (clean exits and Ctrl-C/SIGTERM).
#[derive(Debug)]
pub struct LockGuard {
    path: PathBuf,
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn lock_holder(text: &str) -> Option<(u32, String)> {
    let mut parts = text.split_whitespace();
    let pid = parts.next()?.parse().ok()?;
    let kind = parts.next().unwrap_or("watch").to_owned();
    Some((pid, kind))
}

/// True when the pid is this process or another `xearch-search`. A recycled
/// or unrelated pid is not a holder, so its stale lock can be reclaimed.
fn holds_our_lock(pid: u32) -> bool {
    if pid == std::process::id() {
        return true;
    }
    std::fs::read(Path::new("/proc").join(pid.to_string()).join("cmdline"))
        .is_ok_and(|line| line.windows(13).any(|w| w == b"xearch-search"))
}

/// PID of a live `xearch-search` holder, if any.
#[must_use]
pub fn watcher_pid(state_dir: &Path) -> Option<u32> {
    let text = std::fs::read_to_string(lock_path(state_dir)).ok()?;
    let (pid, _kind) = lock_holder(&text)?;
    holds_our_lock(pid).then_some(pid)
}

/// Take the single-instance lock for `kind`.
///
/// Creation is exclusive (`O_EXCL`), so only one process can hold it; stale
/// locks (dead or unrelated pid) are reclaimed. A brief `mark` section makes
/// a starting watcher wait instead of failing.
///
/// # Errors
/// Returns [`Error::Invalid`] when a live xearch-search holds the lock.
pub fn acquire_exclusive(state_dir: &Path, kind: &str) -> Result<LockGuard> {
    std::fs::create_dir_all(state_dir).map_err(storage)?;
    let path = lock_path(state_dir);
    for attempt in 0..40_u32 {
        let mut pending = tempfile::NamedTempFile::new_in(state_dir).map_err(storage)?;
        writeln!(pending, "{} {kind}", std::process::id()).map_err(storage)?;
        pending.as_file().sync_all().map_err(storage)?;
        match std::fs::hard_link(pending.path(), &path) {
            Ok(()) => {
                return Ok(LockGuard { path });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let text = match std::fs::read_to_string(&path) {
                    Ok(text) => text,
                    Err(_) if attempt < 30 => {
                        std::thread::sleep(Duration::from_millis(100));
                        continue;
                    }
                    Err(error) => return Err(storage(error)),
                };
                match lock_holder(&text) {
                    Some((pid, holder_kind)) if holds_our_lock(pid) => {
                        if holder_kind == "mark" && kind == "watch" && attempt < 30 {
                            std::thread::sleep(Duration::from_millis(100));
                            continue;
                        }
                        return Err(Error::Invalid(format!(
                            "Another indexer is running (pid {pid}). Stop it before starting a second one."
                        )));
                    }
                    Some(_) => {
                        // Dead or unrelated holder: reclaim.
                        let _ = std::fs::remove_file(&path);
                    }
                    None if attempt < 30 => {
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    None => {
                        return Err(Error::Invalid(
                            "The indexer lock is unreadable; remove indexer.lock if no indexer runs."
                                .into(),
                        ));
                    }
                }
            }
            Err(error) => return Err(storage(error)),
        }
    }
    Err(Error::Invalid(
        "Could not acquire the indexer lock; remove indexer.lock if no indexer runs.".into(),
    ))
}

/// Remove stale `NamedTempFile` leftovers (`.tmpXXXXXX`) from a directory.
/// SIGKILL skips destructors, so without this they accumulate forever.
fn sweep_temp_files(directory: &Path) {
    let Some(cutoff) = std::time::SystemTime::now().checked_sub(TEMP_MAX_AGE) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with(".tmp") {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|m| m.modified()) else {
            continue;
        };
        if modified < cutoff {
            let path = entry.path();
            if std::fs::remove_file(&path).is_ok() {
                eprintln!("indexer swept stale temp {}", path.display());
            }
        }
    }
}

fn storage(error: impl std::fmt::Display) -> Error {
    Error::Storage(error.to_string())
}

/// Content-hash signature, streamed so a large file is never resident in
/// memory. Unlike size:mtime, a same-size edit with a restored or coarse
/// mtime can never pass as unchanged.
fn signature(file: &Path) -> Option<String> {
    let mut file = std::fs::File::open(file).ok()?;
    let mut hasher = sha2::Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024].into_boxed_slice();
    loop {
        let read = file.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }
        hasher.update(buffer.get(..read)?);
    }
    Some(format!("{:x}", hasher.finalize()))
}

fn candidates(drop_dir: &Path) -> Vec<PathBuf> {
    let entries = std::fs::read_dir(drop_dir).map_or_else(|_| Vec::new(), Iterator::collect);
    let mut files: Vec<PathBuf> = entries
        .into_iter()
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| {
            path.extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
        })
        .filter(|path| std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file()))
        .collect();
    files.sort();
    files
}

fn file_name_of(file: &Path) -> Option<String> {
    file.file_name().and_then(|n| n.to_str()).map(str::to_owned)
}

fn stem_of(file: &Path) -> Option<&str> {
    file.file_stem().and_then(|s| s.to_str())
}

/// Handle for a per-user intake file: the filename stem, normalized like
/// query authors (`@` stripped, lowercased).
fn handle_for(file: &Path) -> Option<String> {
    search_query::normalize_author(stem_of(file)?).ok()
}

/// Capture batches are named by their lowercase SHA-256 content hash.
fn is_capture_name(stem: &str) -> bool {
    stem.len() == 64
        && stem
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn author_handle(value: &serde_json::Value) -> Option<String> {
    let name = value.get("author")?.get("screen_name")?.as_str()?;
    search_query::normalize_author(name).ok()
}

/// Derive the reporting handle for a capture batch from its payload: the
/// first post's author, else the request input when it is a handle.
fn capture_handle(file: &Path) -> Option<String> {
    let bytes = std::fs::read(file).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    if let Some(records) = value.get("records").and_then(serde_json::Value::as_array) {
        for record in records {
            let Some(payload) = record.get("payload") else {
                continue;
            };
            if let Some(handle) = payload
                .get("posts")
                .and_then(serde_json::Value::as_array)
                .and_then(|posts| posts.first())
                .and_then(author_handle)
            {
                return Some(handle);
            }
            if let Some(handle) = payload.get("post").and_then(author_handle) {
                return Some(handle);
            }
            if let Some(handle) = author_handle(payload) {
                return Some(handle);
            }
        }
    }
    let input = value.get("request")?.get("input")?.as_str()?;
    search_query::normalize_author(input).ok()
}

fn too_large(file: &Path) -> bool {
    std::fs::metadata(file).is_ok_and(|metadata| metadata.len() > MAX_INPUT_BYTES)
}

/// Import every due dump once, updating the registry.
///
/// A user is due when its status is not `complete`, when the bytes of its
/// recorded file changed, when its recorded file is gone (rename recovery),
/// or when the index is empty but the registry is not (index reset). A
/// capture batch is due until its content hash is recorded.
///
/// # Errors
/// Returns [`Error::Storage`] if the index cannot be opened or the registry
/// cannot be saved.
pub fn run_once(config: &Config) -> Result<Registry> {
    let path = registry_path(&config.state_dir);
    let mut registry = Registry::load(&path)?;
    let engine = search_tantivy::open(&config.index, true)?;
    let index_empty = engine.num_docs()? == 0;
    if index_empty && (!registry.users.is_empty() || !registry.captures.is_empty()) {
        eprintln!(
            "indexer warning: index is empty while {} users and {} captures are recorded; reimporting from drop",
            registry.users.len(),
            registry.captures.len()
        );
    }
    for file in candidates(&config.drop_dir) {
        let Some(stem) = stem_of(&file).map(str::to_owned) else {
            continue;
        };
        let Some(file_name) = file_name_of(&file) else {
            continue;
        };
        if too_large(&file) {
            eprintln!(
                "indexer skip file={file_name} exceeds the {} MiB limit; split it first",
                MAX_INPUT_BYTES / (1024 * 1024)
            );
            continue;
        }
        if is_capture_name(&stem) {
            run_capture(config, &engine, &mut registry, &file, &stem, index_empty);
        } else {
            run_user(
                config,
                &engine,
                &mut registry,
                &file,
                &file_name,
                index_empty,
            );
        }
        registry.save(&path)?;
    }
    registry.save(&path)?;
    Ok(registry)
}

fn run_capture(
    config: &Config,
    engine: &search_tantivy::Engine,
    registry: &mut Registry,
    file: &Path,
    sha: &str,
    index_empty: bool,
) {
    // Skip only when the batch is recorded AND the index still has content.
    // After an index reset the recorded hash must be reimported from drop.
    if !index_empty && registry.captures.contains_key(sha) {
        return;
    }
    let handle = capture_handle(file);
    let writer = match engine.writer() {
        Ok(writer) => writer,
        Err(error) => {
            eprintln!("indexer err capture={sha} {error}");
            return;
        }
    };
    match search_ingest::import(file, &config.archive, writer) {
        Ok(receipt) => {
            registry.mark_capture(sha, handle.as_deref(), &receipt);
            eprintln!(
                "indexer ok capture={sha} user={} accepted={} rejected={}",
                handle.as_deref().unwrap_or("unknown"),
                receipt.accepted,
                receipt.rejected
            );
        }
        Err(error) => eprintln!("indexer err capture={sha} {error}"),
    }
}

fn run_user(
    config: &Config,
    engine: &search_tantivy::Engine,
    registry: &mut Registry,
    file: &Path,
    file_name: &str,
    index_empty: bool,
) {
    let Some(handle) = handle_for(file) else {
        eprintln!("indexer skip file={file_name} unusable handle");
        return;
    };
    // A different file may only take over the handle when the recorded file
    // is gone; otherwise two files would fight over one registry entry.
    let (conflicted, rebound) = {
        let record = registry.record(&handle);
        match record.file_name.as_deref() {
            Some(existing) if existing != file_name => {
                let exists = config.drop_dir.join(existing).is_file();
                (exists, !exists)
            }
            _ => (false, false),
        }
    };
    if conflicted {
        eprintln!(
            "indexer skip user={handle}: {file_name} collides with {}",
            registry.record(&handle).file_name.as_deref().unwrap_or("?")
        );
        return;
    }
    let Some(sig) = signature(file) else {
        eprintln!("indexer skip file={file_name} unreadable");
        return;
    };
    let due = {
        let record = registry.record(&handle);
        index_empty
            || rebound
            || record.status != users::UserStatus::Complete
            || record.file_sig.as_deref() != Some(&sig)
    };
    if !due {
        return;
    }
    let writer = match engine.writer() {
        Ok(writer) => writer,
        Err(error) => {
            registry.mark_error(&handle, &error.to_string(), Some(file_name));
            eprintln!("indexer err user={handle} {error}");
            return;
        }
    };
    match search_ingest::import(file, &config.archive, writer) {
        Ok(receipt) => {
            registry.mark_complete(&handle, &receipt, &sig, file_name);
            eprintln!(
                "indexer ok user={handle} accepted={} rejected={}",
                receipt.accepted, receipt.rejected
            );
        }
        Err(error) => {
            registry.mark_error(&handle, &error.to_string(), Some(file_name));
            eprintln!("indexer err user={handle} {error}");
        }
    }
}

/// Poll forever until Ctrl-C. The lock, stale-temp sweep, and immediate
/// first pass make restarts safe and instant. Never calls a provider; only
/// local files are read.
///
/// # Errors
/// Returns validation errors or a lock conflict before the first pass.
pub async fn watch(config: Config) -> Result<()> {
    config.validate()?;
    let _guard = acquire_exclusive(&config.state_dir, "watch")?;
    sweep_temp_files(&config.archive);
    sweep_temp_files(&config.state_dir);
    watch_loop(&config).await
}

/// Resolves on SIGTERM so `systemctl --user stop` releases the lock.
async fn terminated() {
    #[cfg(unix)]
    match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
        Ok(mut signal) => {
            signal.recv().await;
            return;
        }
        Err(error) => eprintln!("indexer warning: SIGTERM handler unavailable: {error}"),
    }
    std::future::pending::<()>().await;
}

async fn watch_loop(config: &Config) -> Result<()> {
    // Immediate first pass so restarts pick up waiting dumps at once.
    if let Err(error) = run_once(config) {
        eprintln!(
            "indexer pass failed (index open errors repeating usually mean a corrupt \
             index directory: rebuild it from the archive; see docs/search-indexer.md): {error}"
        );
    }
    let mut termination = std::pin::pin!(terminated());
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                eprintln!("indexer stopping");
                return Ok(());
            }
            () = &mut termination => {
                eprintln!("indexer stopping (terminated)");
                return Ok(());
            }
            () = tokio::time::sleep(config.poll_interval) => {
                if let Err(error) = run_once(config) {
                    eprintln!("indexer pass failed: {error}");
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use users::UserStatus;

    fn config_in(dir: &Path) -> Config {
        let config = Config {
            index: dir.join("index"),
            archive: dir.join("archive"),
            drop_dir: dir.join("drop"),
            state_dir: dir.join("state"),
            poll_interval: Duration::from_secs(1),
        };
        std::fs::create_dir_all(&config.drop_dir).expect("drop dir");
        config
    }

    fn post(id: &str, handle: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "author": {"screen_name": handle, "id": "42"},
            "text": "hello world",
            "created_timestamp": 1_758_000_000_i64,
        })
    }

    fn user_dump(id: &str, handle: &str) -> String {
        serde_json::to_string(&serde_json::json!({"posts": [post(id, handle)]})).expect("json")
    }

    #[test]
    fn rejects_zero_interval() {
        let config = Config {
            index: PathBuf::from("i"),
            archive: PathBuf::from("a"),
            drop_dir: PathBuf::from("d"),
            state_dir: PathBuf::from("s"),
            poll_interval: Duration::ZERO,
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn empty_drop_dir_writes_empty_registry() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = config_in(dir.path());
        let registry = run_once(&config).expect("run once");
        assert!(registry.users.is_empty());
        assert!(registry_path(&config.state_dir).exists());
    }

    #[test]
    fn per_user_file_marks_complete_and_skips_second_pass() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = config_in(dir.path());
        std::fs::write(
            config.drop_dir.join("TestUser.json"),
            user_dump("1001", "TestUser"),
        )
        .expect("write dump");
        let registry = run_once(&config).expect("first pass");
        let record = registry.users.get("testuser").expect("record");
        assert_eq!(record.status, UserStatus::Complete);
        assert_eq!(record.attempts, 1);
        assert_eq!(record.accepted, 1);

        let registry = run_once(&config).expect("second pass");
        let record = registry.users.get("testuser").expect("record");
        assert_eq!(record.attempts, 1, "unchanged file must not reimport");
    }

    #[test]
    fn malformed_dump_marks_error_and_retries() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = config_in(dir.path());
        std::fs::write(config.drop_dir.join("baduser.json"), "{not json").expect("write dump");
        let registry = run_once(&config).expect("first pass");
        let record = registry.users.get("baduser").expect("record");
        assert_eq!(record.status, UserStatus::Error);
        assert!(record.last_error.is_some());

        let registry = run_once(&config).expect("second pass");
        let record = registry.users.get("baduser").expect("record");
        assert_eq!(record.attempts, 2, "error users retry every pass");
    }

    #[test]
    fn manual_mark_incomplete_forces_reimport() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = config_in(dir.path());
        std::fs::write(config.drop_dir.join("u.json"), user_dump("2001", "u")).expect("write dump");
        run_once(&config).expect("first pass");
        let path = registry_path(&config.state_dir);
        let mut registry = Registry::load(&path).expect("load");
        registry
            .mark("u", UserStatus::Incomplete, Some("recheck"))
            .expect("mark");
        registry.save(&path).expect("save");
        let registry = run_once(&config).expect("second pass");
        assert_eq!(
            registry.users.get("u").expect("record").attempts,
            2,
            "cleared signature must reimport"
        );
    }

    #[test]
    fn same_size_edit_reimports_via_content_hash() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = config_in(dir.path());
        let path = config.drop_dir.join("edituser.json");
        let first = r#"{"posts":[{"id":"3001","author":{"screen_name":"edituser","id":"7"},"text":"alpha","created_timestamp":1758000000}]}"#;
        std::fs::write(&path, first).expect("write v1");
        run_once(&config).expect("first pass");
        let second = first.replace("alpha", "omega");
        assert_eq!(first.len(), second.len(), "same-size precondition");
        std::fs::write(&path, second).expect("write v2");
        let registry = run_once(&config).expect("second pass");
        let record = registry.users.get("edituser").expect("record");
        assert_eq!(
            record.status,
            UserStatus::Complete,
            "changed bytes must reimport even at same size"
        );
        assert_eq!(record.accepted, 1);
        assert_eq!(record.attempts, 2);
    }

    #[test]
    fn colliding_handles_skip_until_the_winner_is_removed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = config_in(dir.path());
        std::fs::write(
            config.drop_dir.join("@alice.json"),
            user_dump("4001", "Alice"),
        )
        .expect("write dump");
        std::fs::write(
            config.drop_dir.join("alice.json"),
            user_dump("4002", "Alice"),
        )
        .expect("write dump");
        for pass in 1..=3 {
            let registry = run_once(&config).expect("pass");
            let record = registry.users.get("alice").expect("record");
            assert_eq!(
                record.attempts, 1,
                "collision must not reimport on pass {pass}"
            );
        }
        // Removing the recorded file lets the surviving file take over.
        let registry = Registry::load(&registry_path(&config.state_dir)).expect("registry");
        let winner = registry
            .users
            .get("alice")
            .and_then(|record| record.file_name.as_deref())
            .expect("winner");
        let survivor = if winner == "@alice.json" {
            "alice.json"
        } else {
            "@alice.json"
        };
        std::fs::remove_file(config.drop_dir.join(winner)).expect("remove winner");
        let registry = run_once(&config).expect("rebind pass");
        let record = registry.users.get("alice").expect("record");
        assert_eq!(record.file_name.as_deref(), Some(survivor));
        assert_eq!(record.attempts, 2, "renamed file must be picked up");
    }

    #[test]
    fn capture_batches_import_once_by_content_hash() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = config_in(dir.path());
        let sha = "a".repeat(64);
        std::fs::write(
            config.drop_dir.join(format!("{sha}.json")),
            serde_json::to_string(&serde_json::json!({
                "version": 1,
                "runId": "job1",
                "source": "x-md",
                "terminal": "complete",
                "request": {"origin": "https://mdfromx.com", "resource": "archive", "input": "hero"},
                "records": [{"receivedAt": 1_758_000_000_000_i64, "payload": {"posts": [post("5001", "hero")]}}]
            }))
            .expect("json"),
        )
        .expect("write capture");
        let registry = run_once(&config).expect("first pass");
        let capture = registry.captures.get(&sha).expect("capture record");
        assert_eq!(capture.accepted, 1);
        assert_eq!(capture.handle.as_deref(), Some("hero"));
        assert!(
            !registry.users.contains_key("hero"),
            "captures are not user files"
        );

        let registry = run_once(&config).expect("second pass");
        assert_eq!(
            registry.captures.get(&sha).expect("capture").accepted,
            1,
            "capture must not reimport"
        );
    }

    #[test]
    fn corrupt_registry_is_quarantined_and_ingestion_continues() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = config_in(dir.path());
        std::fs::create_dir_all(&config.state_dir).expect("state dir");
        std::fs::write(registry_path(&config.state_dir), "{not json").expect("bad registry");
        std::fs::write(config.drop_dir.join("u.json"), user_dump("6001", "u")).expect("dump");
        let registry = run_once(&config).expect("run once");
        assert_eq!(registry.users.get("u").expect("record").accepted, 1);
        let bad = std::fs::read_dir(&config.state_dir)
            .expect("state dir")
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains(".bad-"));
        assert!(bad, "corrupt registry must be quarantined");
    }

    #[test]
    fn captures_reimport_when_index_is_reset() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = config_in(dir.path());
        let sha = "b".repeat(64);
        std::fs::write(
            config.drop_dir.join(format!("{sha}.json")),
            serde_json::to_string(&serde_json::json!({
                "version": 1, "runId": "r", "source": "x-md", "terminal": "complete",
                "request": {"origin": "https://mdfromx.com", "resource": "archive", "input": "hero"},
                "records": [{"receivedAt": 1_i64, "payload": {"posts": [post("8001", "hero")]}}]
            }))
            .expect("json"),
        )
        .expect("write capture");
        run_once(&config).expect("first pass");
        assert_eq!(
            search_tantivy::open(&config.index, false)
                .expect("open")
                .num_docs()
                .expect("docs"),
            1
        );
        std::fs::remove_dir_all(&config.index).expect("reset index");
        let registry = run_once(&config).expect("rebuild pass");
        assert_eq!(registry.captures.len(), 1, "hash stays recorded");
        assert_eq!(
            search_tantivy::open(&config.index, false)
                .expect("reopen")
                .num_docs()
                .expect("docs"),
            1,
            "capture must be reimported after an index reset"
        );
    }

    #[test]
    fn lock_is_exclusive_and_reclaims_stale_holders() {
        let dir = tempfile::tempdir().expect("tempdir");
        let guard = acquire_exclusive(dir.path(), "watch").expect("first lock");
        assert!(
            acquire_exclusive(dir.path(), "watch").is_err(),
            "second lock must fail"
        );
        drop(guard);
        let _ = acquire_exclusive(dir.path(), "watch").expect("lock after release");
        // A lock from a dead/unrelated pid is reclaimed.
        std::fs::write(lock_path(dir.path()), "99999999 watch").expect("stale lock");
        let _ = acquire_exclusive(dir.path(), "watch").expect("stale lock reclaimed");
    }

    #[test]
    fn unreadable_registry_is_quarantined_not_fatal() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = config_in(dir.path());
        std::fs::create_dir_all(config.state_dir.join("users.json")).expect("dir registry");
        std::fs::write(config.drop_dir.join("u.json"), user_dump("9001", "u")).expect("dump");
        let registry = run_once(&config).expect("run once");
        assert_eq!(registry.users.get("u").expect("record").accepted, 1);
    }

    #[test]
    fn jsonl_files_are_not_advertised_or_imported() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = config_in(dir.path());
        std::fs::write(config.drop_dir.join("u.jsonl"), user_dump("9101", "u")).expect("dump");
        let registry = run_once(&config).expect("run once");
        assert!(registry.users.is_empty(), ".jsonl is not an intake format");
    }

    #[test]
    fn empty_index_forces_reimport_even_when_registry_says_complete() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = config_in(dir.path());
        std::fs::write(config.drop_dir.join("u.json"), user_dump("7001", "u")).expect("dump");
        run_once(&config).expect("first pass");
        // Reset the index as an operator or disk restore would.
        std::fs::remove_dir_all(&config.index).expect("drop index");
        let registry = run_once(&config).expect("rebuild pass");
        let record = registry.users.get("u").expect("record");
        assert_eq!(record.status, UserStatus::Complete);
        assert_eq!(record.attempts, 2, "empty index must force reimport");
    }
}
