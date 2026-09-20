//! Liveness heartbeat for Convex's `POST /service/health` route.
//!
//! See `convex/health.ts`. Where [`crate::publish`] reports *what happened
//! to one account's posts*, this module reports the far simpler fact that
//! *this indexer is running and its last pass did or did not complete* —
//! the difference between the dashboard saying "no health report received
//! yet" forever and it saying "healthy, last success 40 seconds ago".
//!
//! Three rules this module exists to keep:
//!
//! 1. **Disabled is a complete no-op.** Without both environment variables
//!    (see [`HealthConfig::from_env`]) nothing is built, nothing is
//!    serialized, and no socket is opened — an existing deployment that
//!    never sets them behaves exactly as it did before this module existed.
//! 2. **A heartbeat failure never fails an import pass.** [`report_pass`]
//!    cannot return an error; the worst it does is print one line and hand
//!    back a [`HeartbeatOutcome`] the caller is free to ignore. Reporting
//!    is not the work.
//! 3. **`healthy: true` is only ever sent for a pass that actually
//!    finished.** It is never derived from "the indexer is configured" —
//!    that conflation is the exact bug the dashboard's health panel exists
//!    to kill.
//!
//! ## Transport
//!
//! Deliberately the same `ureq` + `rustls` client the publication sender
//! uses ([`crate::publish::transport`]) — one HTTP client in this crate, not
//! two. Its TLS path has been confirmed against a real Convex
//! HTTP-actions host; see `crate::publish`'s module documentation.

use crate::publish::{non_empty_env, transport};
use crate::users::now_ms;
use serde::Serialize;

/// Convex `/service/health` sender configuration.
///
/// Both inputs are optional; either being absent disables the heartbeat
/// entirely.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HealthConfig {
    pub url: String,
    pub token: String,
}

impl HealthConfig {
    /// Read `SERVICE_HEALTH_URL` and `SERVICE_HEALTH_TOKEN` (falling back to
    /// `DATA_SERVICE_TOKEN`), the same isolated-capability-with-legacy-
    /// fallback convention as [`crate::publish::PublishConfig::from_env`]
    /// and `convex/health.ts`'s `healthServiceToken()`. `None` when either
    /// resolves to nothing or an empty string.
    #[must_use]
    pub fn from_env() -> Option<Self> {
        let url = non_empty_env("SERVICE_HEALTH_URL")?;
        let token = non_empty_env("SERVICE_HEALTH_TOKEN")
            .or_else(|| non_empty_env("DATA_SERVICE_TOKEN"))?;
        Some(Self { url, token })
    }
}

/// What the pass being reported on actually did, in the caller's own words.
#[derive(Debug, Clone)]
pub enum PassOutcome<'a> {
    /// The pass ran to completion. This is the only thing that ever sends
    /// `healthy: true`.
    Completed,
    /// The pass failed, with this verbatim message.
    Failed(&'a str),
}

/// The result of one heartbeat attempt. Returned rather than swallowed so
/// callers and tests can see that "disabled" really is a distinct,
/// do-nothing path — but no caller is required to act on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeartbeatOutcome {
    /// No configuration: nothing was built, encoded, or sent.
    Disabled,
    /// A response was received, whatever its status.
    Delivered { status: u16 },
    /// No response was ever received (DNS/connect/TLS/timeout/protocol
    /// failure, or a URL the client rejected), or the body could not be
    /// encoded. The pass it describes is unaffected either way.
    NotDelivered(String),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorField<'a> {
    message: &'a str,
}

/// The wire shape, field for field matching `convex/health.ts`'s
/// `parseReport`. That receiver rejects any unlisted key with a 400, so
/// every optional field is skipped when absent rather than sent as null.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Report<'a> {
    version: u8,
    service: &'static str,
    healthy: bool,
    observed_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorField<'a>>,
}

/// This crate only ever reports on itself.
const SERVICE: &str = "indexer";

/// Report one poll pass's liveness to Convex.
///
/// A complete no-op when `config` is `None`. Never returns an error and
/// never panics: a heartbeat is an observation about work that already
/// happened, so it must not be able to interrupt or invalidate that work.
#[must_use]
pub fn report_pass(config: Option<&HealthConfig>, outcome: &PassOutcome<'_>) -> HeartbeatOutcome {
    let Some(config) = config else {
        return HeartbeatOutcome::Disabled;
    };
    let (healthy, error) = match outcome {
        PassOutcome::Completed => (true, None),
        // Verbatim, not rewritten: `lastError` on the Convex side is meant
        // to carry what actually went wrong.
        PassOutcome::Failed(message) => (false, Some(ErrorField { message })),
    };
    let report = Report {
        version: 1,
        service: SERVICE,
        healthy,
        observed_at: now_ms(),
        error,
    };
    let body = match serde_json::to_vec(&report) {
        Ok(body) => body,
        Err(error) => {
            let message = format!("could not encode heartbeat: {error}");
            eprintln!("indexer heartbeat: {message}");
            return HeartbeatOutcome::NotDelivered(message);
        }
    };
    // One attempt, not the publication sender's two: a heartbeat is
    // repeated by the poll loop anyway, so retrying inside one pass buys
    // nothing and only delays the real work.
    match transport::send_once(&config.url, &config.token, &idempotency_key(&report), &body) {
        Ok((status, _body)) => {
            if status != 200 {
                eprintln!("indexer heartbeat rejected status={status}");
            }
            HeartbeatOutcome::Delivered { status }
        }
        Err(message) => {
            eprintln!("indexer heartbeat transport failure: {message}");
            HeartbeatOutcome::NotDelivered(message)
        }
    }
}

/// Heartbeats are an upsert of one row per service, so replaying one is
/// already idempotent on the receiver's side; the key is sent only because
/// the shared transport takes one, and is derived from the timestamp so two
/// distinct observations never collide.
fn idempotency_key(report: &Report<'_>) -> String {
    format!("{SERVICE}-{}", report.observed_at)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc::{Receiver, channel};

    /// Accept one connection, capture the request body, and reply.
    fn spawn_responder(status_line: &'static str) -> (String, Receiver<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (sender, receiver) = channel();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buffer = Vec::new();
                let mut chunk = [0_u8; 4096];
                // Read until the body is in hand: the fixture only needs
                // enough to assert on the JSON that was posted.
                while let Ok(read) = stream.read(&mut chunk) {
                    if read == 0 {
                        break;
                    }
                    buffer.extend_from_slice(&chunk[..read]);
                    if let Some(position) =
                        buffer.windows(4).position(|window| window == b"\r\n\r\n")
                    {
                        let head = String::from_utf8_lossy(&buffer[..position]).into_owned();
                        let length = head
                            .split("\r\n")
                            .filter_map(|line| line.split_once(':'))
                            .find(|(key, _)| key.trim().eq_ignore_ascii_case("content-length"))
                            .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                            .unwrap_or(0);
                        let body_start = position.saturating_add(4);
                        if buffer.len() >= body_start.saturating_add(length) {
                            let _ = sender.send(buffer[body_start..].to_vec());
                            break;
                        }
                    }
                }
                let response =
                    format!("{status_line}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                let _ = stream.write_all(response.as_bytes());
            }
        });
        (format!("http://{addr}/service/health"), receiver)
    }

    /// A port nothing is listening on.
    fn dead_url() -> String {
        let probe = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = probe.local_addr().unwrap();
        drop(probe);
        format!("http://{addr}/service/health")
    }

    fn config(url: String) -> HealthConfig {
        HealthConfig {
            url,
            token: "test-token".to_owned(),
        }
    }

    #[test]
    fn is_a_complete_no_op_when_unconfigured() {
        assert_eq!(
            report_pass(None, &PassOutcome::Completed),
            HeartbeatOutcome::Disabled
        );
        assert_eq!(
            report_pass(None, &PassOutcome::Failed("something broke")),
            HeartbeatOutcome::Disabled
        );
    }

    #[test]
    fn a_completed_pass_reports_healthy_with_no_error_field() {
        let (url, requests) = spawn_responder("HTTP/1.1 200 OK");
        let outcome = report_pass(Some(&config(url)), &PassOutcome::Completed);
        assert_eq!(outcome, HeartbeatOutcome::Delivered { status: 200 });
        let body = requests.recv().unwrap();
        let sent: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(sent["version"], 1);
        assert_eq!(sent["service"], "indexer");
        assert_eq!(sent["healthy"], true);
        assert!(sent["observedAt"].as_i64().unwrap() > 0);
        assert!(
            sent.get("error").is_none(),
            "an omitted field must really be omitted: the receiver 400s on an unlisted key"
        );
    }

    #[test]
    fn a_failed_pass_reports_unhealthy_with_the_verbatim_message() {
        let (url, requests) = spawn_responder("HTTP/1.1 200 OK");
        let message = "index open failed: Permission denied (os error 13)";
        let outcome = report_pass(Some(&config(url)), &PassOutcome::Failed(message));
        assert_eq!(outcome, HeartbeatOutcome::Delivered { status: 200 });
        let sent: serde_json::Value = serde_json::from_slice(&requests.recv().unwrap()).unwrap();
        assert_eq!(sent["healthy"], false);
        assert_eq!(sent["error"]["message"], message);
    }

    #[test]
    fn a_rejected_heartbeat_is_reported_as_delivered_not_as_a_transport_failure() {
        let (url, _requests) = spawn_responder("HTTP/1.1 401 Unauthorized");
        assert_eq!(
            report_pass(Some(&config(url)), &PassOutcome::Completed),
            HeartbeatOutcome::Delivered { status: 401 }
        );
    }

    #[test]
    fn an_unreachable_receiver_is_reported_without_erroring() {
        match report_pass(Some(&config(dead_url())), &PassOutcome::Completed) {
            HeartbeatOutcome::NotDelivered(message) => assert!(!message.is_empty()),
            other => panic!("expected NotDelivered, got {other:?}"),
        }
    }
}
