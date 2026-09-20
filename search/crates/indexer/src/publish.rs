//! Sender for Convex's publication-update contract.
//!
//! See `docs/publication-contract.md` and `POST /publication/update` in
//! `convex/publication.ts`. This module owns exactly the outbound side of
//! that boundary: building the envelope, delivering it, and recording the
//! outcome in [`crate::users::Registry`]. It never decides *whether* an
//! import succeeded — that is [`crate::run_capture`]/[`crate::run_user`]'s
//! job, reported in here via [`ImportOutcome`].
//!
//! ## Retries
//!
//! A send that never got a response does not spend the generation it used,
//! so that number stays reserved for that one update. The update itself is
//! stored on the account ([`crate::users::PendingPublication`]) and
//! [`replay_pending`] resends exactly it — same capture ids, same count,
//! same `observedAt` — until a response finally arrives. Nothing else may
//! be sent for that account meanwhile: per
//! `docs/publication-contract.md`, reusing a generation for different
//! content is a sender-side bug.
//!
//! ## Transport
//!
//! Delivery (see [`transport`]) goes over `ureq` with its `rustls` TLS
//! backend (`search/Cargo.toml`'s `ureq = { features = ["rustls"] }`), so
//! both `http://` (used in this crate's own tests) and `https://` (what a
//! real Convex deployment uses, `*.convex.site`) work.
//!
//! Every update carries the service token in an `Authorization: Bearer`
//! header, so a cleartext endpoint is refused rather than sent to:
//! [`PublishConfig::new`] rejects any `http://` URL whose host is not
//! loopback, before a config — let alone a request — exists. A deployment
//! misconfigured that way publishes nothing and says why on startup.
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

use crate::users::{DeferredPublication, PendingPublication, Registry, ReportedState, now_ms};
use search_model::{Error, Result};
use serde::{Deserialize, Serialize};

/// Convex `/publication/update` sender configuration.
///
/// Both inputs are optional; either being absent disables the sender
/// entirely, and [`crate::run_once`] then behaves exactly as it did before
/// this module existed — nothing here changes an existing deployment's
/// behavior unless both environment variables are set.
///
/// The fields are private on purpose: every update carries the token in an
/// `Authorization: Bearer` header, so the endpoint it may be sent to is a
/// security property of this type, not of its call sites. The only way to
/// build one is [`PublishConfig::new`], which refuses a cleartext endpoint
/// outright — there is no shape of this struct that puts the token on the
/// wire unencrypted to anything but loopback.
#[derive(Clone, PartialEq, Eq)]
pub struct PublishConfig {
    url: String,
    token: String,
}

/// Never print the token — not in a log line, not in a panic message, not
/// in a `{config:?}` someone adds later. The endpoint is useful to see;
/// the credential is not.
impl std::fmt::Debug for PublishConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PublishConfig")
            .field("url", &self.url)
            .field("token", &"<redacted>")
            .finish()
    }
}

impl PublishConfig {
    /// Build a sender configuration, refusing an endpoint that would send
    /// the bearer token in cleartext.
    ///
    /// # Errors
    /// [`Error::Invalid`] when `url` is not `https://` and its host is not
    /// a loopback address. Plain `http://` to `127.0.0.1`/`::1`/`localhost`
    /// stays allowed: that is a test responder on this machine, where the
    /// bytes never touch a network.
    pub fn new(url: impl Into<String>, token: impl Into<String>) -> Result<Self> {
        let url = url.into();
        check_endpoint_is_encrypted(&url)?;
        Ok(Self {
            url,
            token: token.into(),
        })
    }

    /// Read `PUBLICATION_UPDATE_URL` and `PUBLICATION_SERVICE_TOKEN`
    /// (falling back to `DATA_SERVICE_TOKEN`), the same fallback convention
    /// as `convex/publication.ts`'s `publicationServiceToken()`. `None`
    /// when either resolves to nothing or an empty string.
    ///
    /// A URL that would leak the token is refused here, before any request
    /// exists — and loudly: a misconfiguration that silently disabled
    /// publication would look exactly like a working deployment that has
    /// nothing to say.
    #[must_use]
    pub fn from_env() -> Option<Self> {
        let url = non_empty_env("PUBLICATION_UPDATE_URL")?;
        let token = non_empty_env("PUBLICATION_SERVICE_TOKEN")
            .or_else(|| non_empty_env("DATA_SERVICE_TOKEN"))?;
        match Self::new(url, token) {
            Ok(config) => Some(config),
            Err(error) => {
                eprintln!("indexer publish: disabled. {error}");
                None
            }
        }
    }
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

/// Refuse an endpoint that would put `PUBLICATION_SERVICE_TOKEN` on the
/// wire in cleartext.
///
/// `https://` is always fine. Plain `http://` is allowed only to a
/// loopback host, which is what this crate's own tests point at — those
/// bytes never leave the machine, so there is nothing to intercept. Any
/// other `http://` host, and anything that is not an absolute HTTP(S) URL
/// at all, is rejected here: the caller never gets a `PublishConfig`, so
/// no request is ever constructed.
fn check_endpoint_is_encrypted(url: &str) -> Result<()> {
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("https://") {
        return Ok(());
    }
    let Some(after_scheme) = lower.strip_prefix("http://") else {
        return Err(Error::Invalid(
            "PUBLICATION_UPDATE_URL must be an absolute https:// URL (plain http:// is accepted \
             only for a loopback test endpoint)."
                .into(),
        ));
    };
    let host = host_of(after_scheme);
    if is_loopback_host(host) {
        return Ok(());
    }
    Err(Error::Invalid(format!(
        "PUBLICATION_UPDATE_URL points at http:// host {host:?}, which would send \
         PUBLICATION_SERVICE_TOKEN over the network in cleartext. Use https://, or a loopback \
         host (127.0.0.1, ::1, localhost) for a local test endpoint."
    )))
}

/// The host of an `http://`-stripped, already-lowercased URL: everything
/// before the path/query/fragment, minus any `user:password@` prefix and
/// `:port` suffix, with an IPv6 literal unbracketed.
fn host_of(after_scheme: &str) -> &str {
    let authority = after_scheme.split(['/', '?', '#']).next().unwrap_or("");
    let host_port = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    host_port.strip_prefix('[').map_or_else(
        || {
            host_port
                .split_once(':')
                .map_or(host_port, |(host, _)| host)
        },
        |bracketed| {
            bracketed
                .split_once(']')
                .map_or(bracketed, |(host, _)| host)
        },
    )
}

/// Whether plain HTTP to this host stays on the machine: `localhost`, or
/// any literal loopback IP (`127.0.0.0/8`, `::1`). A name that merely
/// *resolves* to loopback is not accepted — what DNS answers is not a
/// property this sender can rely on.
fn is_loopback_host(host: &str) -> bool {
    host == "localhost"
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
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
    reported_state: &'a str,
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
    /// request was delivered, so the generation it used is spent — including
    /// when the body was cut short after the status line arrived, which
    /// leaves the optional fields below `None` but changes nothing about
    /// the delivery (see [`transport::send_once`]).
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
    // An account with an undelivered update has a generation reserved for
    // exactly that update, and the receiver may already have committed it.
    // Sending this import's different content at that same number is the
    // sender-side bug `docs/publication-contract.md` names outright, so it
    // waits: the owed update is replayed first (see [`replay_pending`],
    // dispatched once per pass by [`crate::run_once`]), and only once a
    // response frees the generation does a fresh update go out.
    let owed = registry
        .publications
        .get(report.handle)
        .and_then(|record| record.pending.as_ref())
        .map(|pending| {
            (
                pending.reported_state.map_or("?", ReportedState::as_str),
                pending.capture_ids.clone(),
            )
        });
    if let Some((owed_state, owed_capture_ids)) = owed {
        // The import still happened, and its capture ids are the only
        // thing that will ever tell Convex so: the importer skips an
        // already-recorded capture on every later pass, so if these are
        // dropped here that capture is indexed and invisible forever.
        // They are kept against the account and folded into the next
        // update that actually goes out.
        eprintln!(
            "indexer publish: handle={} still owes an undelivered {owed_state} update \
             (captureIds={owed_capture_ids:?}); this import's update waits for it rather than \
             reusing its generation, and its captureIds={:?} are held for the follow-on",
            report.handle, report.capture_ids,
        );
        registry.defer_publication(report.handle, deferral_from(report));
        return;
    }
    let observed_at = now_ms();
    let attempt = match &report.outcome {
        ImportOutcome::Succeeded => match engine.count_author(report.handle) {
            Ok(count) => PendingPublication {
                reported_state: Some(ReportedState::Searchable),
                capture_ids: report.capture_ids.clone(),
                run_id: report.run_id.map(str::to_owned),
                provider_account_id: report.provider_account_id.map(str::to_owned),
                unique_post_count: Some(count),
                unique_post_count_as_of: Some(observed_at),
                error: None,
                observed_at_ms: observed_at,
            },
            Err(error) => {
                eprintln!(
                    "indexer publish: could not count posts for handle={} (no update sent): {error}",
                    report.handle
                );
                return;
            }
        },
        ImportOutcome::Failed(message) => PendingPublication {
            reported_state: Some(ReportedState::Failed),
            capture_ids: report.capture_ids.clone(),
            run_id: report.run_id.map(str::to_owned),
            provider_account_id: report.provider_account_id.map(str::to_owned),
            unique_post_count: None,
            unique_post_count_as_of: None,
            error: Some((*message).to_owned()),
            observed_at_ms: observed_at,
        },
    };
    let attempt = fold_deferred(registry, report.handle, attempt);
    deliver(config, registry, report.handle, &attempt);
}

/// What this import would have reported, kept for a later update.
fn deferral_from(report: &ImportReport<'_>) -> DeferredPublication {
    let (reported_state, error) = match &report.outcome {
        ImportOutcome::Succeeded => (ReportedState::Searchable, None),
        ImportOutcome::Failed(message) => (ReportedState::Failed, Some((*message).to_owned())),
    };
    DeferredPublication {
        capture_ids: report.capture_ids.clone(),
        run_id: report.run_id.map(str::to_owned),
        provider_account_id: report.provider_account_id.map(str::to_owned),
        reported_state: Some(reported_state),
        error,
        updated_at_ms: now_ms(),
    }
}

/// Carry anything earlier imports could not report into the update about
/// to go out, and clear it.
///
/// Only identity is carried: capture ids (this update's own first, then
/// whatever is still owed confirmation, without duplicates) and the
/// `runId`/`providerAccountId` this import did not have. The *state* is
/// this import's own — it is the newer fact about the account, and it is
/// exactly what the deferred update would have been superseded by had
/// both gone out in order.
///
/// Clearing before the send is safe: if delivery fails, the whole merged
/// update — capture ids included — is what gets stored as owed and
/// replayed verbatim, so nothing is lost either way.
fn fold_deferred(
    registry: &mut Registry,
    handle: &str,
    mut attempt: PendingPublication,
) -> PendingPublication {
    let Some(deferred) = registry.publication(handle).deferred.take() else {
        return attempt;
    };
    for id in deferred.capture_ids {
        if !attempt.capture_ids.contains(&id) {
            attempt.capture_ids.push(id);
        }
    }
    if attempt.run_id.is_none() {
        attempt.run_id = deferred.run_id;
    }
    if attempt.provider_account_id.is_none() {
        attempt.provider_account_id = deferred.provider_account_id;
    }
    eprintln!(
        "indexer publish: handle={handle} folds previously deferred captureIds into this update; \
         it now confirms {:?}",
        attempt.capture_ids
    );
    attempt
}

/// Send what imports that stood down during an outage would have reported,
/// once nothing is owed for the account any more.
///
/// This is the case the replay path alone cannot cover: a capture imported
/// while an earlier update was owed is recorded in the registry, so the
/// importer never looks at its file again and no later import exists to
/// carry its id. Without this the capture sits in the index, unconfirmed,
/// forever.
///
/// The update is built fresh — `uniquePostCount` recounted now, a new
/// `observedAt` — because it is a new update at a new generation, not a
/// replay of anything. Only the identity comes from the registry, and it
/// is the whole point: the follow-on names the captures it confirms
/// rather than going out handle-only.
fn flush_deferred(
    config: &PublishConfig,
    engine: &search_tantivy::Engine,
    registry: &mut Registry,
    handle: &str,
) {
    // `get_mut`, not `publication`: an account with nothing recorded has
    // nothing deferred either, and must not gain an empty record here.
    let Some(record) = registry.publications.get_mut(handle) else {
        return;
    };
    if record.pending.is_some() {
        // Still owed: the reserved generation is not free yet.
        return;
    }
    let Some(deferred) = record.deferred.clone() else {
        return;
    };
    let Some(reported_state) = deferred.reported_state else {
        record.deferred = None;
        eprintln!(
            "indexer publish: handle={handle} has deferred captureIds with no reportedState; \
             discarding them rather than guessing what they meant"
        );
        return;
    };
    let observed_at = now_ms();
    let (unique_post_count, error) = match reported_state {
        ReportedState::Searchable => match engine.count_author(handle) {
            Ok(count) => (Some(count), None),
            Err(error) => {
                eprintln!(
                    "indexer publish: could not count posts for handle={handle} (deferred \
                     captureIds={:?} kept for a later pass): {error}",
                    deferred.capture_ids
                );
                return;
            }
        },
        ReportedState::Failed => (None, deferred.error.clone()),
    };
    let attempt = PendingPublication {
        reported_state: Some(reported_state),
        capture_ids: deferred.capture_ids,
        run_id: deferred.run_id,
        provider_account_id: deferred.provider_account_id,
        unique_post_count,
        unique_post_count_as_of: unique_post_count.map(|_| observed_at),
        error,
        observed_at_ms: observed_at,
    };
    registry.publication(handle).deferred = None;
    eprintln!(
        "indexer publish follow-on handle={handle} captureIds={:?} (imported while an earlier \
         update was owed; confirming them now)",
        attempt.capture_ids
    );
    deliver(config, registry, handle, &attempt);
}

/// Resend the update this account already reserved a generation for, byte
/// for byte, when an earlier attempt never got a response.
///
/// Nothing is rebuilt here: not the post count, not the capture ids, not
/// `observedAt`. The stored update is the one the receiver may already
/// have seen, so replaying anything else would either confirm the wrong
/// captures or land as a duplicate generation carrying different content —
/// the sender-side bug `docs/publication-contract.md` calls out.
///
/// Once nothing is owed for the account any more — because this replay was
/// answered, or because nothing was owed to begin with — anything imports
/// stood down during the outage were holding goes out as a follow-on
/// update at the next generation (see [`flush_deferred`]). That is a new
/// update with new content, not a retry of anything, so it does not spin:
/// it happens exactly once, when the queue behind the owed update drains.
///
/// A total no-op when the sender is disabled or nothing is owed or
/// deferred.
pub fn replay_pending(
    config: Option<&PublishConfig>,
    engine: &search_tantivy::Engine,
    registry: &mut Registry,
    handle: &str,
) {
    let Some(config) = config else { return };
    resolve_owed(config, registry, handle);
    flush_deferred(config, engine, registry, handle);
}

/// Resend the stored owed update, if there is one. See [`replay_pending`].
fn resolve_owed(config: &PublishConfig, registry: &mut Registry, handle: &str) {
    let Some(record) = registry.publications.get_mut(handle) else {
        return;
    };
    let Some(pending) = record.pending.clone() else {
        if record.transport_retry_pending {
            // A registry written before the owed update was recorded (an
            // older build stored only the flag). There is nothing to
            // replay and nothing may be invented: clear the flag and say
            // so. The generation was never spent, so the next import for
            // this account reports at that same number.
            record.transport_retry_pending = false;
            eprintln!(
                "indexer publish: handle={handle} was flagged for retry by an older indexer that \
                 did not record what was owed; nothing to replay"
            );
        }
        return;
    };
    if pending.reported_state.is_none() {
        record.transport_retry_pending = false;
        record.pending = None;
        eprintln!(
            "indexer publish: handle={handle} has an owed update with no reportedState; \
             discarding it rather than guessing"
        );
        return;
    }
    eprintln!(
        "indexer publish replay handle={handle} captureIds={:?} (no reimport, same generation)",
        pending.capture_ids
    );
    deliver(config, registry, handle, &pending);
}

/// Encode one publication, deliver it, and record the outcome.
///
/// The generation is always the account's watermark plus one — the number
/// reserved but not yet spent — so a first attempt and every replay of it
/// use the same generation until a response finally comes back.
fn deliver(
    config: &PublishConfig,
    registry: &mut Registry,
    handle: &str,
    publication: &PendingPublication,
) {
    let Some(reported_state) = publication.reported_state.map(ReportedState::as_str) else {
        return;
    };
    let next_generation = registry.publication(handle).generation.saturating_add(1);
    let envelope = Envelope {
        version: 1,
        provider_account_id: publication.provider_account_id.as_deref(),
        handle,
        run_id: publication.run_id.as_deref(),
        capture_ids: &publication.capture_ids,
        generation: next_generation,
        reported_state,
        unique_post_count: publication.unique_post_count,
        unique_post_count_as_of: publication.unique_post_count_as_of,
        error: publication
            .error
            .as_deref()
            .map(|message| ErrorField { message }),
        observed_at: publication.observed_at_ms,
    };
    let body = match serde_json::to_vec(&envelope) {
        Ok(body) => body,
        Err(error) => {
            eprintln!(
                "indexer publish: could not encode envelope for handle={handle} (no update sent): {error}"
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
                "indexer publish delivered handle={handle} generation={next_generation} status={status} outcome={} reportedState={reported_state}{}",
                outcome.as_deref().unwrap_or("?"),
                rejection_reason
                    .map(|reason| format!(" rejectionReason={reason}"))
                    .unwrap_or_default(),
            );
            let applied_searchable = if status == 200 && reported_state == "searchable" {
                publication
                    .unique_post_count
                    .map(|count| (count, publication.observed_at_ms))
            } else {
                None
            };
            let last_publish_error = if status == 200 {
                None
            } else {
                Some(format!("publication update rejected (HTTP {status})"))
            };
            registry.record_publish_delivered(
                handle,
                next_generation,
                applied_searchable,
                last_publish_error,
            );
        }
        SendOutcome::TransportFailed(message) => {
            eprintln!(
                "indexer publish transport failure handle={handle} generation={next_generation}: {message}"
            );
            registry.record_publish_transport_failure(handle, &message, publication.clone());
        }
    }
}
