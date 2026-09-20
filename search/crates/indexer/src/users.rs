//! Per-user ingestion registry: one file marks every intake account as
//! complete, incomplete, or error, so postings can be built per user and
//! failures retried without guessing.
//!
//! Layout: the state directory holds `users.json`:
//! ```json
//! {
//!   "version": 1,
//!   "users": {
//!     "somehandle": {
//!       "status": "complete",
//!       "attempts": 2,
//!       "accepted": 150,
//!       "rejected": 0,
//!       "sha256": "ab12…",
//!       "lastError": null,
//!       "fileSig": "ab12…",
//!       "updatedAtMs": 1758000000000
//!     }
//!   }
//! }
//! ```
//!
//! Transition rules (applied by [`crate::run_once`]):
//! - New intake file: `incomplete`, zero attempts.
//! - Import accepting ≥1 post: `complete` with receipt details.
//! - Import accepting 0 posts or failing: `error` with reason, attempts + 1.
//! - `error` / `incomplete` users are retried every pass; `complete` users
//!   are skipped unless their file changes (or an operator marks them
//!   `incomplete`, which clears the file signature and forces reimport).
//!
//! A corrupted registry file is quarantined next to itself
//! (`users.json.bad-<unix>`) and replaced by an empty one, so a single bad
//! byte can never brick ingestion permanently.
//!
//! Besides per-user records, `captures` tracks content-addressed capture
//! files (`<sha256>.json`, as written by the raw-capture receiver) so each
//! batch is imported exactly once regardless of how many batches a handle
//! produces.

use search_ingest::Receipt;
use search_model::{Error, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Filename of the registry inside the state directory.
pub const REGISTRY_FILE: &str = "users.json";

/// Ingestion state of one intake account.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UserStatus {
    /// Last import accepted at least one post.
    Complete,
    /// Seen but never successfully imported; pending or retryable.
    Incomplete,
    /// Last attempt failed; see `last_error` on the record.
    Error,
}

impl std::str::FromStr for UserStatus {
    type Err = Error;

    fn from_str(text: &str) -> Result<Self> {
        match text {
            "complete" => Ok(Self::Complete),
            "incomplete" => Ok(Self::Incomplete),
            "error" => Ok(Self::Error),
            _ => Err(Error::Invalid(
                "Status must be complete, incomplete, or error.".into(),
            )),
        }
    }
}

/// Retry and receipt history for one intake account.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserRecord {
    pub status: UserStatus,
    /// Total import attempts so far.
    #[serde(default)]
    pub attempts: u32,
    /// Posts accepted by the last successful import.
    #[serde(default)]
    pub accepted: u64,
    /// Records quarantined by the last successful import.
    #[serde(default)]
    pub rejected: u64,
    /// Content hash of the last successfully imported file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    /// Reason for the last failure; `None` while complete.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// SHA-256 content hash of the last imported file; cleared to force
    /// reimport.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_sig: Option<String>,
    /// Drop filename backing the last import, so two files normalizing to
    /// the same handle cannot oscillate against one signature.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(default)]
    pub updated_at_ms: i64,
}

/// One imported content-addressed capture file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRecord {
    /// Handle the capture belonged to, when it could be derived.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
    pub accepted: u64,
    pub rejected: u64,
    #[serde(default)]
    pub updated_at_ms: i64,
}

impl UserRecord {
    const fn fresh(now: i64) -> Self {
        Self {
            status: UserStatus::Incomplete,
            attempts: 0,
            accepted: 0,
            rejected: 0,
            sha256: None,
            last_error: None,
            file_sig: None,
            file_name: None,
            updated_at_ms: now,
        }
    }
}

/// Durable per-account publication state sent to Convex's
/// `POST /publication/update` (`docs/publication-contract.md`).
///
/// Keyed by the same normalized handle as `users`/`captures`.
/// `#[serde(default)]` on every field (and the map itself, on [`Registry`])
/// so a `users.json` written before this feature existed — no
/// `publications` key at all — loads unchanged instead of being
/// quarantined.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationRecord {
    /// Generation of the last update actually delivered: an HTTP response,
    /// of any status, was received for it. Zero means nothing has ever been
    /// sent for this account. The publication contract requires this to
    /// increase by exactly one per delivered send and never be reused, so
    /// it is bumped only when [`Registry::record_publish_delivered`] runs —
    /// never spent on a send whose request never got a response.
    #[serde(default)]
    pub generation: u64,
    /// `uniquePostCount` from the last successfully applied `searchable`
    /// send (HTTP 200). Left alone by later `failed` sends or non-200
    /// responses, mirroring `accountPublications.searchablePostCount`'s own
    /// non-regression rule on the Convex side.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_unique_post_count: Option<u64>,
    /// `observedAt` (epoch ms) of that same last applied `searchable` send.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_published_at_ms: Option<i64>,
    /// The most recent publish-side problem: a transport failure (no
    /// response ever received — DNS/connect/TLS/timeout) or a permanent
    /// rejection (401/422/400) from the last delivered send. Cleared the
    /// next time a send is delivered with a 200 response.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_publish_error: Option<String>,
    /// Set when the most recent send attempt never received an HTTP
    /// response, so this account is owed a resend on a later pass. Cleared
    /// by any delivered response (success or permanent rejection alike).
    /// Never set for a permanent rejection — those are logged and left
    /// alone rather than retried, per `AGENTS.md`'s "no self-imposed retry
    /// spinning".
    #[serde(default)]
    pub transport_retry_pending: bool,
}

/// The registry file: versioned map of handle to record.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Registry {
    #[serde(default = "default_version")]
    pub version: u8,
    #[serde(default)]
    pub users: HashMap<String, UserRecord>,
    /// Imported capture files keyed by their content hash (filename stem).
    #[serde(default)]
    pub captures: HashMap<String, CaptureRecord>,
    /// Publication state per account handle. Absent from any `users.json`
    /// written before this feature existed; `#[serde(default)]` loads that
    /// as an empty map rather than quarantining the file.
    #[serde(default)]
    pub publications: HashMap<String, PublicationRecord>,
}

const fn default_version() -> u8 {
    1
}

impl Default for Registry {
    fn default() -> Self {
        Self {
            version: 1,
            users: HashMap::new(),
            captures: HashMap::new(),
            publications: HashMap::new(),
        }
    }
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

fn storage(error: impl std::fmt::Display) -> Error {
    Error::Storage(error.to_string())
}

impl Registry {
    /// Load the registry; a missing file is an empty registry, not an error.
    /// A malformed or unreadable file is quarantined as
    /// `users.json.bad-<unix-ms>` and replaced by an empty registry so
    /// ingestion can continue; the raw evidence is retained for inspection.
    ///
    /// # Errors
    /// Returns storage errors only when the quarantine copy cannot be
    /// written (for example a read-only state directory).
    pub fn load(path: &Path) -> Result<Self> {
        let bytes = match std::fs::read(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self::default());
            }
            Err(error) => {
                // A directory or an unreadable file can never parse; move it
                // aside instead of failing every pass forever.
                Self::quarantine(path, &format!("unreadable: {error}"))?;
                return Ok(Self::default());
            }
            Ok(bytes) => bytes,
        };
        match serde_json::from_slice::<Self>(&bytes) {
            Ok(registry) if registry.version == 1 => Ok(registry),
            Ok(registry) => {
                let note = format!("unsupported version {}", registry.version);
                Self::quarantine(path, &note)?;
                Ok(Self::default())
            }
            Err(error) => {
                Self::quarantine(path, &error.to_string())?;
                Ok(Self::default())
            }
        }
    }

    /// Move a corrupt registry aside, keeping the evidence. Millisecond
    /// stamps plus a counter make repeated quarantines collision-free.
    fn quarantine(path: &Path, reason: &str) -> Result<()> {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis());
        let mut bad = path.with_extension(format!("json.bad-{stamp}"));
        let mut suffix = 0_u32;
        while bad.exists() {
            suffix = suffix.saturating_add(1);
            bad = path.with_extension(format!("json.bad-{stamp}-{suffix}"));
        }
        std::fs::rename(path, &bad).map_err(storage)?;
        eprintln!(
            "indexer quarantined registry {} as {} ({reason})",
            path.display(),
            bad.display()
        );
        Ok(())
    }

    /// Record one imported capture file.
    pub fn mark_capture(&mut self, sha: &str, handle: Option<&str>, receipt: &Receipt) {
        self.captures.insert(
            sha.to_owned(),
            CaptureRecord {
                handle: handle.map(str::to_owned),
                accepted: receipt.accepted,
                rejected: receipt.rejected,
                updated_at_ms: now_ms(),
            },
        );
    }

    /// Persist atomically (temp file + rename) so a crash never leaves a
    /// half-written registry behind.
    ///
    /// # Errors
    /// Returns storage errors when the state directory cannot be written.
    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(storage)?;
        }
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        let mut tmp = tempfile::NamedTempFile::new_in(parent).map_err(storage)?;
        serde_json::to_writer_pretty(&mut tmp, self).map_err(storage)?;
        tmp.flush().map_err(storage)?;
        tmp.as_file().sync_all().map_err(storage)?;
        tmp.persist(path).map_err(storage)?;
        Ok(())
    }

    /// Fetch the record for a handle, inserting a fresh `incomplete` one.
    pub fn record(&mut self, handle: &str) -> &mut UserRecord {
        self.users
            .entry(handle.to_owned())
            .or_insert_with(|| UserRecord::fresh(now_ms()))
    }

    /// Fetch the publication record for a handle, inserting a fresh
    /// (never-sent) one.
    pub fn publication(&mut self, handle: &str) -> &mut PublicationRecord {
        self.publications.entry(handle.to_owned()).or_default()
    }

    /// Record a delivered send (any HTTP response, whatever its status) at
    /// `generation`: advance the watermark and clear the retry flag.
    /// `applied_searchable` carries `(uniquePostCount, observedAt)` only
    /// when the delivered response was a successfully applied `searchable`
    /// update; passing `None` leaves the previous sticky snapshot alone,
    /// matching the non-regression rule this mirrors from the Convex side.
    pub fn record_publish_delivered(
        &mut self,
        handle: &str,
        generation: u64,
        applied_searchable: Option<(u64, i64)>,
        last_publish_error: Option<String>,
    ) {
        let record = self.publication(handle);
        record.generation = generation;
        record.transport_retry_pending = false;
        if let Some((count, observed_at)) = applied_searchable {
            record.last_unique_post_count = Some(count);
            record.last_published_at_ms = Some(observed_at);
        }
        record.last_publish_error = last_publish_error;
    }

    /// Record that a send never received an HTTP response. The generation
    /// watermark is left untouched so the same number is reused on the
    /// next attempt — nothing was ever delivered at it.
    pub fn record_publish_transport_failure(&mut self, handle: &str, error: &str) {
        let record = self.publication(handle);
        record.transport_retry_pending = true;
        record.last_publish_error = Some(error.to_owned());
    }

    /// Mark a successful import. Zero accepted posts is an error, not a
    /// completion, so empty dumps stay visible and retryable.
    pub fn mark_complete(
        &mut self,
        handle: &str,
        receipt: &Receipt,
        file_sig: &str,
        file_name: &str,
    ) {
        let now = now_ms();
        let record = self.record(handle);
        record.attempts = record.attempts.saturating_add(1);
        if receipt.accepted == 0 {
            record.status = UserStatus::Error;
            record.last_error = Some(format!(
                "No posts accepted; {} quarantined.",
                receipt.rejected
            ));
            record.accepted = 0;
            record.rejected = 0;
            record.sha256 = None;
        } else {
            record.status = UserStatus::Complete;
            record.accepted = receipt.accepted;
            record.rejected = receipt.rejected;
            record.sha256 = Some(receipt.sha256.clone());
            record.last_error = None;
        }
        record.file_sig = Some(file_sig.to_owned());
        record.file_name = Some(file_name.to_owned());
        record.updated_at_ms = now;
    }

    /// Mark a failed attempt with its reason; attempts accumulate for backoff
    /// and triage. The file signature is left alone so the next pass retries
    /// the same bytes.
    pub fn mark_error(&mut self, handle: &str, reason: &str, file_name: Option<&str>) {
        let now = now_ms();
        let record = self.record(handle);
        record.attempts = record.attempts.saturating_add(1);
        record.status = UserStatus::Error;
        record.last_error = Some(reason.to_owned());
        if let Some(name) = file_name {
            record.file_name = Some(name.to_owned());
        }
        record.updated_at_ms = now;
    }

    /// Operator override: set a status by hand. Marking `incomplete` clears
    /// the file signature so the next pass reimports even unchanged bytes;
    /// marking `complete` keeps history but requires a note explaining why.
    ///
    /// # Errors
    /// Returns [`Error::Invalid`] for a manual `complete` without a note.
    pub fn mark(&mut self, handle: &str, status: UserStatus, note: Option<&str>) -> Result<()> {
        if status == UserStatus::Complete && note.is_none_or(str::is_empty) {
            return Err(Error::Invalid(
                "Marking complete by hand requires --note (sha or reason).".into(),
            ));
        }
        let now = now_ms();
        let record = self.record(handle);
        record.status = status;
        match status {
            UserStatus::Incomplete => {
                // Clear the binding so a renamed or colliding file can take
                // over the handle on the next pass.
                record.file_sig = None;
                record.file_name = None;
                record.last_error = note.map(str::to_owned);
            }
            UserStatus::Error => {
                record.last_error = Some(note.unwrap_or("Marked error by operator.").to_owned());
            }
            UserStatus::Complete => {
                record.last_error = None;
            }
        }
        record.updated_at_ms = now;
        Ok(())
    }
}

/// Registry path for a state directory.
#[must_use]
pub fn registry_path(state_dir: &Path) -> PathBuf {
    state_dir.join(REGISTRY_FILE)
}
