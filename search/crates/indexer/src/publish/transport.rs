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

use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(20);

/// Send one request and return `(status, body)`.
///
/// `Err` means no response was ever received at all — a DNS, connect, TLS
/// handshake, protocol, or timeout failure — not an HTTP-level rejection.
/// `http_status_as_error` is turned off on the agent so a 4xx/5xx response
/// comes back as `Ok` exactly like a 2xx does: this function only reports
/// whether a response happened, never what the caller should conclude from
/// its status.
pub(super) fn send_once(
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
    let body = response
        .body_mut()
        .read_to_vec()
        .map_err(|error| format!("read body: {error}"))?;
    Ok((status, body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// Accept exactly one connection, ignore the request, and reply with a
    /// fixed status/body — enough to prove `send_once` reports the status
    /// and body of whatever comes back, without depending on a specific
    /// request shape.
    fn spawn_fixed_responder(status_line: &'static str, body: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut discard = [0_u8; 4096];
                // Best-effort: read whatever the client already sent so far
                // (a full parse isn't needed, this fixture only checks
                // send_once's handling of the response).
                let _ = stream.read(&mut discard);
                let response_body = body.as_bytes();
                let response = format!(
                    "{status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    response_body.len()
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.write_all(response_body);
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
