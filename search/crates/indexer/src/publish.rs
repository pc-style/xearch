//! Sender for Convex's publication-update contract.
//!
//! See `docs/publication-contract.md` and `POST /publication/update` in
//! `convex/publication.ts`. This module owns exactly the outbound side of
//! that boundary: building the envelope, delivering it, and recording the
//! outcome in [`crate::users::Registry`]. It never decides *whether* an
//! import succeeded — that is [`crate::run_capture`]/[`crate::run_user`]'s
//! job, reported in here via [`ImportOutcome`].
//!
//! ## Transport
//!
//! Delivery (see [`transport`]) goes over `ureq` with its `rustls` TLS
//! backend (`search/Cargo.toml`'s `ureq = { features = ["rustls"] }`), so
//! both `http://` (used in this crate's own tests) and `https://` (what a
//! real Convex deployment uses, `*.convex.site`) work.
//!
//! This has been confirmed end to end, through this exact sender code,
//! against the production deployment's HTTP-actions host
//! (`https://utmost-kudu-321.convex.site` — `.convex.site`, not
//! `.convex.cloud`), with zero state mutated: a deliberately nonexistent
//! handle got back HTTP 422 `{"outcome":"rejected_invalid",
//! "rejectionReason":"No known account matches this update's
//! providerAccountId/handle."}`, and a deliberately wrong bearer token got
//! back HTTP 401 `{"outcome":"rejected_unauthorized"}` — proving TLS, auth,
//! envelope shape, routing, and the receiver's own contract logic all work
//! over the real network path. See this task's final report for the exact
//! commands; no token or other secret is written anywhere in this
//! repository or logged by this sender.

mod transport;

use crate::users::{Registry, now_ms};
use serde::{Deserialize, Serialize};

/// Convex `/publication/update` sender configuration.
///
/// Both inputs are optional; either being absent disables the sender
/// entirely, and [`crate::run_once`] then behaves exactly as it did before
/// this module existed — nothing here changes an existing deployment's
/// behavior unless both environment variables are set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishConfig {
    pub url: String,
    pub token: String,
}

impl PublishConfig {
    /// Read `PUBLICATION_UPDATE_URL` and `PUBLICATION_SERVICE_TOKEN`
    /// (falling back to `DATA_SERVICE_TOKEN`), the same fallback convention
    /// as `convex/publication.ts`'s `publicationServiceToken()`. `None`
    /// when either resolves to nothing or an empty string.
    #[must_use]
    pub fn from_env() -> Option<Self> {
        let url = non_empty_env("PUBLICATION_UPDATE_URL")?;
        let token = non_empty_env("PUBLICATION_SERVICE_TOKEN")
            .or_else(|| non_empty_env("DATA_SERVICE_TOKEN"))?;
        Some(Self { url, token })
    }
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

/// What an import attempt reported, in the caller's own words.
///
/// This module never invents either half of this: a count comes only from
/// [`search_tantivy::Engine::count_author`], an error only from the
/// import's own error message.
#[derive(Debug, Clone)]
pub enum ImportOutcome<'a> {
    /// Posts are in the index; report `reportedState: "searchable"` with a
    /// freshly counted `uniquePostCount`.
    Succeeded,
    /// The import itself failed; report `reportedState: "failed"` with
    /// this verbatim message. Never paired with a count.
    Failed(&'a str),
}

/// Everything [`report_after_import`] needs about one import besides the
/// outcome, bundled into a struct so the function stays under clippy's
/// argument-count lint.
#[derive(Debug, Clone)]
pub struct ImportReport<'a> {
    pub handle: &'a str,
    pub outcome: ImportOutcome<'a>,
    /// The provider (x.md) numeric account id, when the capture envelope
    /// let it be derived. Never guessed.
    pub provider_account_id: Option<&'a str>,
    /// The Convex `jobs._id` this update traces to, when the capture
    /// envelope carried one.
    pub run_id: Option<&'a str>,
    /// Content-addressed capture ids this update confirms were processed.
    /// Empty for a per-handle dump, which has no capture id.
    pub capture_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorField<'a> {
    message: &'a str,
}

/// The wire shape, field for field matching `publicationUpdateFields`
/// (`convex/schema.ts`) plus `version` (`convex/lib/contracts.ts`
/// `publicationUpdateEnvelope`). `#[serde(skip_serializing_if)]` on every
/// optional field so an update that omits something really omits the key —
/// `convex/publication.ts`'s `parseEnvelope` rejects any unlisted key, so
/// adding a field here that the receiver doesn't know about would 400
/// every single update.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Envelope<'a> {
    version: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_account_id: Option<&'a str>,
    handle: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<&'a str>,
    capture_ids: &'a [String],
    generation: u64,
    reported_state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    unique_post_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    unique_post_count_as_of: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorField<'a>>,
    observed_at: i64,
}

/// Best-effort parse of `{ outcome, committedGeneration?, rejectionReason? }`
/// (`convex/publication.ts`'s response body). A response that doesn't
/// decode as this shape (for example a proxy's plain-text error page) is
/// tolerated: the delivered/undelivered decision below is made from the
/// HTTP status alone, never from this body.
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ReceiverResponse {
    #[serde(default)]
    outcome: Option<String>,
    #[serde(default)]
    committed_generation: Option<u64>,
    #[serde(default)]
    rejection_reason: Option<String>,
}

/// The result of one delivery attempt.
#[derive(Debug, Clone)]
pub enum SendOutcome {
    /// An HTTP response was received. Per
    /// `docs/publication-contract.md` "Response", status 200 covers
    /// `applied`/`stale_ignored`/`duplicate_ignored` (all terminal,
    /// non-retryable); 422/401/400 are permanent rejections. Either way the
    /// request was delivered, so the generation it used is spent.
    Delivered {
        status: u16,
        outcome: Option<String>,
        committed_generation: Option<u64>,
        rejection_reason: Option<String>,
    },
    /// No response was ever received for this attempt (DNS/connect/TLS/
    /// timeout/protocol failure, or a malformed configured URL). Not
    /// delivered: the caller must retry the same generation on a later
    /// pass, never in a tight loop.
    TransportFailed(String),
}

fn idempotency_key(body: &[u8]) -> String {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(body);
    format!("{:x}", hasher.finalize())
}

/// Deliver one already-built envelope body, with the same bounded,
/// same-bytes retry pattern as `convex/lib/handoff.ts`'s `deliverCapture`
/// (two attempts, one `Idempotency-Key` computed once up front so a lost
/// response and a retried send can never double-apply).
fn send(url: &str, token: &str, body: &[u8]) -> SendOutcome {
    let key = idempotency_key(body);
    let mut last_error = String::new();
    for _ in 0_u8..2 {
        match transport::send_once(url, token, &key, body) {
            Ok((status, response_body)) => {
                let parsed =
                    serde_json::from_slice::<ReceiverResponse>(&response_body).unwrap_or_default();
                return SendOutcome::Delivered {
                    status,
                    outcome: parsed.outcome,
                    committed_generation: parsed.committed_generation,
                    rejection_reason: parsed.rejection_reason,
                };
            }
            Err(error) => last_error = error,
        }
    }
    SendOutcome::TransportFailed(last_error)
}

/// Build and (if enabled) deliver a publication update reflecting the
/// result of one import, then persist the outcome in `registry`.
///
/// A total no-op when `config` is `None` — the disabled state this task
/// requires so an existing deployment without the new environment
/// variables is unaffected.
///
/// A publish problem — of any kind, transport or rejection — is only ever
/// logged and recorded; it never returns an error, because a publish
/// failure must never fail or roll back the import that already happened
/// (the posts are in the index; publication is reporting).
pub fn report_after_import(
    config: Option<&PublishConfig>,
    engine: &search_tantivy::Engine,
    registry: &mut Registry,
    report: &ImportReport<'_>,
) {
    let Some(config) = config else { return };
    let observed_at = now_ms();
    let (reported_state, unique_post_count, unique_post_count_as_of, error_message) = match &report
        .outcome
    {
        ImportOutcome::Succeeded => match engine.count_author(report.handle) {
            Ok(count) => ("searchable", Some(count), Some(observed_at), None),
            Err(error) => {
                eprintln!(
                    "indexer publish: could not count posts for handle={} (no update sent): {error}",
                    report.handle
                );
                return;
            }
        },
        ImportOutcome::Failed(message) => ("failed", None, None, Some((*message).to_owned())),
    };
    let next_generation = registry
        .publication(report.handle)
        .generation
        .saturating_add(1);
    let envelope = Envelope {
        version: 1,
        provider_account_id: report.provider_account_id,
        handle: report.handle,
        run_id: report.run_id,
        capture_ids: &report.capture_ids,
        generation: next_generation,
        reported_state,
        unique_post_count,
        unique_post_count_as_of,
        error: error_message
            .as_deref()
            .map(|message| ErrorField { message }),
        observed_at,
    };
    let body = match serde_json::to_vec(&envelope) {
        Ok(body) => body,
        Err(error) => {
            eprintln!(
                "indexer publish: could not encode envelope for handle={} (no update sent): {error}",
                report.handle
            );
            return;
        }
    };
    match send(&config.url, &config.token, &body) {
        SendOutcome::Delivered {
            status,
            outcome,
            rejection_reason,
            ..
        } => {
            eprintln!(
                "indexer publish delivered handle={} generation={next_generation} status={status} outcome={} reportedState={reported_state}{}",
                report.handle,
                outcome.as_deref().unwrap_or("?"),
                rejection_reason
                    .map(|reason| format!(" rejectionReason={reason}"))
                    .unwrap_or_default(),
            );
            let applied_searchable = if status == 200 && reported_state == "searchable" {
                unique_post_count.map(|count| (count, observed_at))
            } else {
                None
            };
            let last_publish_error = if status == 200 {
                None
            } else {
                Some(format!("publication update rejected (HTTP {status})"))
            };
            registry.record_publish_delivered(
                report.handle,
                next_generation,
                applied_searchable,
                last_publish_error,
            );
        }
        SendOutcome::TransportFailed(message) => {
            eprintln!(
                "indexer publish transport failure handle={} generation={next_generation}: {message}",
                report.handle
            );
            registry.record_publish_transport_failure(report.handle, &message);
        }
    }
}
