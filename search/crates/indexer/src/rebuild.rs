//! Rebuild the index from `archive/`, in place.
//!
//! What the index holds for a post (its searched text, its prior, the
//! stored post) is fixed when it is imported, so a change to any of them
//! reaches older posts only through a rebuild. The index records the
//! [`INDEX_FORMAT`] it was built in; when that is behind the binary's,
//! the watcher rebuilds on its next pass, and `xearch-search rebuild`
//! asks for one by hand (see [`request`]).
//!
//! The rebuild runs in the watcher's own process with its single writer,
//! so it never waits on the index lock, and replays every archived input
//! into one commit: searches keep serving the old posts until the new
//! ones replace them all at once. Nothing is replaced when it fails.

use search_backend::IndexSink;
use search_model::{Error, Post, Result};
use search_tantivy::{Engine, INDEX_FORMAT};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime},
};

/// How long after a failed automatic rebuild the watcher waits before
/// trying again, so a rebuild that cannot succeed does not rerun on every
/// pass. A request made by hand always runs.
const RETRY_AFTER: Duration = Duration::from_secs(3600);

/// Below this share of the posts already indexed, a rebuild is refused:
/// the archive is the wrong directory or has lost files, and committing
/// would drop posts from search.
const KEEP_AT_LEAST: f64 = 0.99;

/// What a rebuild did.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rebuilt {
    pub format: u32,
    /// Archived inputs replayed.
    pub files: usize,
    /// Inputs skipped because they could not be read as a capture or dump
    /// (they failed when first imported too).
    pub skipped: usize,
    /// Distinct posts in the rebuilt index.
    pub posts: usize,
    pub elapsed_ms: u64,
}

/// The file `xearch-search rebuild` leaves for a running watcher.
#[must_use]
pub fn request_path(state_dir: &Path) -> PathBuf {
    state_dir.join("rebuild.request")
}

/// Written when an automatic rebuild fails: its error, and by its age when
/// to try again.
#[must_use]
pub fn failure_path(state_dir: &Path) -> PathBuf {
    state_dir.join("rebuild.failed")
}

/// Ask the running watcher to rebuild on its next pass.
///
/// # Errors
/// Returns storage errors when the state directory is not writable.
pub fn request(state_dir: &Path) -> Result<()> {
    std::fs::create_dir_all(state_dir).map_err(storage)?;
    std::fs::write(request_path(state_dir), b"").map_err(storage)
}

fn storage(error: impl std::fmt::Display) -> Error {
    Error::Storage(error.to_string())
}

/// Every archived input, oldest first. Each was written when first
/// imported, so replaying in this order leaves a post seen in several
/// captures with its latest numbers, as live imports did.
fn archived(archive: &Path) -> Result<Vec<PathBuf>> {
    let mut files: Vec<(SystemTime, PathBuf)> = std::fs::read_dir(archive)
        .map_err(storage)?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| {
            let json = path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("json"));
            let receipt = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .is_some_and(|stem| stem.ends_with(".receipt"));
            json && !receipt
        })
        .filter_map(|path| {
            let modified = std::fs::metadata(&path).and_then(|m| m.modified()).ok()?;
            Some((modified, path))
        })
        .collect();
    files.sort();
    Ok(files.into_iter().map(|(_, path)| path).collect())
}

/// The rebuild writer, counting the distinct posts it is given.
struct Counting<'a> {
    writer: &'a mut search_tantivy::Writer,
    ids: HashSet<u64>,
}

impl IndexSink for Counting<'_> {
    fn upsert(&mut self, post: &Post) -> Result<()> {
        self.ids.insert(post.tweet_id.0);
        self.writer.upsert(post)
    }
    fn commit(&mut self) -> Result<()> {
        self.writer.commit()
    }
}

/// Replace every post in the index with the archive replayed through this
/// binary's import, then merge it into one segment.
///
/// # Errors
/// Returns storage errors (nothing is replaced), or [`Error::Invalid`] when
/// the archive holds fewer than [`KEEP_AT_LEAST`] of the posts the index
/// already has.
pub fn rebuild(archive: &Path, engine: &Engine) -> Result<Rebuilt> {
    let started = Instant::now();
    let before = engine.num_docs()?;
    let files = archived(archive)?;
    let mut writer = engine.rebuild_writer()?;
    let mut counting = Counting {
        writer: &mut writer,
        ids: HashSet::new(),
    };
    let mut skipped: usize = 0;
    for file in &files {
        match search_ingest::replay(file, &mut counting) {
            Ok(_) => {}
            Err(Error::Invalid(message)) => {
                skipped = skipped.saturating_add(1);
                eprintln!("indexer rebuild skip {}: {message}", file.display());
            }
            // Storage: stop with the old index untouched (the writer is
            // dropped uncommitted).
            Err(error) => return Err(error),
        }
    }
    let posts = counting.ids.len();
    let kept = f64::from(u32::try_from(posts).unwrap_or(u32::MAX));
    let had = f64::from(u32::try_from(before).unwrap_or(u32::MAX));
    if kept < had * KEEP_AT_LEAST {
        return Err(Error::Invalid(format!(
            "The archive holds {posts} posts and the index {before}; not rebuilding from {}.",
            archive.display()
        )));
    }
    counting.commit()?;
    drop(writer);
    engine.compact()?;
    Ok(Rebuilt {
        format: INDEX_FORMAT,
        files: files.len(),
        skipped,
        posts,
        elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
    })
}

/// Rebuild when the index is behind [`INDEX_FORMAT`] or one was requested,
/// as the first step of a watcher pass.
///
/// An automatic rebuild that failed is retried after [`RETRY_AFTER`]; the
/// failure is returned each time it happens so the pass reports it.
///
/// # Errors
/// Returns the rebuild's own error.
pub fn when_due(archive: &Path, state_dir: &Path, engine: &Engine) -> Result<Option<Rebuilt>> {
    let requested = request_path(state_dir).exists();
    let format = engine.format()?;
    if !requested && format == INDEX_FORMAT {
        return Ok(None);
    }
    let failed_recently = std::fs::metadata(failure_path(state_dir))
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|failed| failed.elapsed().ok())
        .is_some_and(|age| age < RETRY_AFTER);
    if !requested && failed_recently {
        return Ok(None);
    }
    eprintln!(
        "indexer rebuilding from {} (index format {format}, current {INDEX_FORMAT}{}); searches serve the old index until it is done",
        archive.display(),
        if requested { ", requested" } else { "" }
    );
    match rebuild(archive, engine) {
        Ok(rebuilt) => {
            let _ = std::fs::remove_file(request_path(state_dir));
            let _ = std::fs::remove_file(failure_path(state_dir));
            eprintln!(
                "indexer rebuilt files={} skipped={} posts={} ms={}",
                rebuilt.files, rebuilt.skipped, rebuilt.posts, rebuilt.elapsed_ms
            );
            Ok(Some(rebuilt))
        }
        Err(error) => {
            let _ = std::fs::remove_file(request_path(state_dir));
            let _ = std::fs::write(failure_path(state_dir), error.to_string());
            eprintln!("indexer rebuild failed: {error}");
            Err(error)
        }
    }
}
