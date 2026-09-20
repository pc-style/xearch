//! HTTP/HTTPS client for the publication sender, via `ureq` with its
//! `rustls` TLS backend (`search/Cargo.toml`'s `ureq = { features =
//! ["rustls"] }`).
//!
//! This has been confirmed to reach a real Convex deployment over TLS —
//! see `search/crates/indexer/src/publish.rs`'s module doc comment for the
//! 422/401 probes run against `https://utmost-kudu-321.convex.site` with
//! zero state mutated. It is also exercised in tests against loopback
//! plain-HTTP listeners (`search/crates/indexer/tests/publication.rs` and
//! this module's own tests below).

use std::io::Read as _;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(20);

/// Ceiling on the response bytes kept in memory. The receiver's response is
/// one small JSON object (`{outcome, committedGeneration?,
/// rejectionReason?}`); this is only a memory bound against a broken or
/// hostile peer streaming forever, not a policy limit on anything.
const MAX_BODY_BYTES: usize = 64 * 1024;

/// Send one request and return `(status, body)`.
///
/// `Err` means no response was ever received at all — a DNS, connect, TLS
/// handshake, protocol, or timeout failure — not an HTTP-level rejection.
/// `http_status_as_error` is turned off on the agent so a 4xx/5xx response
/// comes back as `Ok` exactly like a 2xx does: this function only reports
/// whether a response happened, never what the caller should conclude from
/// its status.
///
/// Once the status line has arrived the response *was* received, so a body
/// that then fails or stops early (a proxy truncating it, a connection
/// dropped mid-body) still returns `Ok` with whatever bytes did arrive.
/// Reporting that as `Err` would contradict the contract above and, worse,
/// leave the generation unspent and the account flagged for retry forever
/// while the receiver has in fact already applied the update.
pub fn send_once(
    url: &str,
    token: &str,
    idempotency_key: &str,
    body: &[u8],
) -> Result<(u16, Vec<u8>), String> {
    let config = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(TIMEOUT))
        .build();
    let agent: ureq::Agent = config.into();
    let mut response = agent
        .post(url)
        .header("Content-Type", "application/json")
        .header("Authorization", &format!("Bearer {token}"))
        .header("Idempotency-Key", idempotency_key)
        .send(body)
        .map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    Ok((status, read_body(response.body_mut())))
}

/// Read whatever the peer actually sent, stopping at the first read error
/// rather than discarding the response. A partial or empty body simply
/// parses as "no known outcome" in the caller, which decides from the
/// status alone.
fn read_body(body: &mut ureq::Body) -> Vec<u8> {
    let mut reader = body.as_reader();
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 8 * 1024];
    loop {
        let remaining = MAX_BODY_BYTES.saturating_sub(buffer.len());
        if remaining == 0 {
            break;
        }
        let take = remaining.min(chunk.len());
        let Some(window) = chunk.get_mut(..take) else {
            break;
        };
        match reader.read(window) {
            Ok(0) | Err(_) => break,
            Ok(read) => match window.get(..read) {
                Some(bytes) => buffer.extend_from_slice(bytes),
                None => break,
            },
        }
    }
    buffer
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// Read the whole request — headers and the `Content-Length` body —
    /// before replying. Closing a socket that still has unread bytes in it
    /// sends an RST, and an RST can discard a response the client has not
    /// read yet, so a fixture that replies early is a flaky fixture.
    fn drain_request(stream: &mut std::net::TcpStream) {
        // A peer that never sends an HTTP request at all (the TLS-handshake
        // test below speaks TLS to this plaintext listener) must not park
        // the fixture until the client's own global timeout.
        let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
        let mut buffer = Vec::new();
        let mut chunk = [0_u8; 4096];
        let mut content_length = 0_usize;
        let mut header_end: Option<usize> = None;
        loop {
            if let Some(end) = header_end {
                let body = buffer.len().saturating_sub(end.saturating_add(4));
                if body >= content_length {
                    return;
                }
            }
            let Ok(read) = stream.read(&mut chunk) else {
                return;
            };
            if read == 0 {
                return;
            }
            let Some(bytes) = chunk.get(..read) else {
                return;
            };
            buffer.extend_from_slice(bytes);
            if header_end.is_none()
                && let Some(end) = buffer.windows(4).position(|window| window == b"\r\n\r\n")
            {
                header_end = Some(end);
                content_length = String::from_utf8_lossy(buffer.get(..end).unwrap_or_default())
                    .to_ascii_lowercase()
                    .split("\r\n")
                    .find_map(|line| line.strip_prefix("content-length:"))
                    .and_then(|value| value.trim().parse().ok())
                    .unwrap_or(0);
            }
        }
    }

    /// Accept exactly one connection, read the request, and reply with a
    /// fixed status/body — enough to prove `send_once` reports the status
    /// and body of whatever comes back, without depending on a specific
    /// request shape.
    fn spawn_fixed_responder(status_line: &'static str, body: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                drain_request(&mut stream);
                let response_body = body.as_bytes();
                let response = format!(
                    "{status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    response_body.len()
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.write_all(response_body);
                let _ = stream.flush();
            }
        });
        format!("http://{addr}/publication/update")
    }

    #[test]
    fn reports_status_and_body_for_a_2xx_response() {
        let url = spawn_fixed_responder("HTTP/1.1 200 OK", r#"{"outcome":"applied"}"#);
        let (status, body) = send_once(&url, "t", "idem-1", b"{}").unwrap();
        assert_eq!(status, 200);
        assert_eq!(body, br#"{"outcome":"applied"}"#);
    }

    #[test]
    fn reports_status_and_body_for_a_4xx_response_instead_of_erroring() {
        let url = spawn_fixed_responder(
            "HTTP/1.1 422 Unprocessable Entity",
            r#"{"outcome":"rejected_invalid"}"#,
        );
        let (status, body) = send_once(&url, "t", "idem-2", b"{}").unwrap();
        assert_eq!(
            status, 422,
            "http_status_as_error must be off: a 4xx is a delivered response, not a transport Err"
        );
        assert_eq!(body, br#"{"outcome":"rejected_invalid"}"#);
    }

    /// Reply with a real status line and a `Content-Length` larger than the
    /// bytes actually written, then close — exactly what a proxy that
    /// truncates a response looks like on the wire.
    fn spawn_truncating_responder(
        status_line: &'static str,
        partial_body: &'static str,
        declared_length: usize,
    ) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                drain_request(&mut stream);
                let response = format!(
                    "{status_line}\r\nContent-Type: application/json\r\nContent-Length: {declared_length}\r\nConnection: close\r\n\r\n",
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.write_all(partial_body.as_bytes());
                let _ = stream.flush();
            }
        });
        format!("http://{addr}/publication/update")
    }

    #[test]
    fn a_body_that_stops_early_still_reports_the_status_it_arrived_with() {
        // The status line was received, so the request was delivered. A
        // body read that fails afterwards must not be reported as "no
        // response ever arrived" — the caller would leave the generation
        // unspent and retry this account on every pass while the receiver
        // has already applied it.
        let partial = r#"{"outcome":"app"#;
        let url = spawn_truncating_responder("HTTP/1.1 200 OK", partial, partial.len() + 64);
        let (status, body) = send_once(&url, "t", "idem-truncated", b"{}")
            .expect("a truncated body is still a delivered response");
        assert_eq!(status, 200);
        assert_eq!(
            body,
            partial.as_bytes(),
            "whatever bytes did arrive must be handed back, not discarded"
        );
    }

    #[test]
    fn reports_a_transport_failure_when_nothing_is_listening() {
        let probe = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = probe.local_addr().unwrap();
        drop(probe);
        let result = send_once(&format!("http://{addr}/x"), "t", "idem-3", b"{}");
        assert!(result.is_err());
    }

    #[test]
    fn an_https_url_against_a_plain_http_server_fails_the_tls_handshake_rather_than_silently_downgrading()
     {
        // The listener only ever speaks plain HTTP. Asking for https:// must
        // attempt (and fail) a real TLS handshake against it, never quietly
        // fall back to plaintext — that would be a security regression.
        let url = spawn_fixed_responder("HTTP/1.1 200 OK", "{}");
        let https_url = url.replacen("http://", "https://", 1);
        let result = send_once(&https_url, "t", "idem-4", b"{}");
        assert!(
            result.is_err(),
            "a TLS client talking to a plaintext server must fail, not succeed"
        );
    }
}
