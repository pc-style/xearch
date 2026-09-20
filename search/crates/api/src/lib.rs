//! Bounded HTTP transport; no engine-specific types or browser-held secrets.
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use hmac::{Hmac, Mac};
use search_backend::SearchBackend;
use search_model::{Error, SearchRequest, SearchResponse};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::sync::Arc;
use tokio::sync::Semaphore;

type HttpError = (StatusCode, String);

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Signed {
    pub payload: String,
    pub signature: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Ticket {
    pub session_id: String,
    pub owner: String,
    pub expires_at: i64,
    pub request: SearchRequest,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    session_id: String,
    owner: String,
    expires_at: i64,
    result: SearchResponse,
}

/// Sign an exact UTF-8 payload with domain separation between tickets and receipts.
///
/// # Errors
/// Rejects keys shorter than 32 bytes.
pub fn sign(payload: String, purpose: &str, key: &[u8]) -> Result<Signed, Error> {
    let mut mac = mac(purpose, key)?;
    mac.update(payload.as_bytes());
    Ok(Signed {
        payload,
        signature: hex::encode(mac.finalize().into_bytes()),
    })
}

fn mac(purpose: &str, key: &[u8]) -> Result<Hmac<Sha256>, Error> {
    if key.len() < 32 {
        return Err(Error::Invalid(
            "Signing key must contain at least 32 bytes.".into(),
        ));
    }
    let mut mac =
        Hmac::<Sha256>::new_from_slice(key).map_err(|_| Error::Invalid("Invalid key.".into()))?;
    mac.update(purpose.as_bytes());
    mac.update(b"\n");
    Ok(mac)
}

fn verify(signed: &Signed, purpose: &str, key: &[u8]) -> Result<(), HttpError> {
    let mut mac = mac(purpose, key).map_err(map_error)?;
    mac.update(signed.payload.as_bytes());
    let bytes = hex::decode(&signed.signature).map_err(|_| unauthorized())?;
    mac.verify_slice(&bytes).map_err(|_| unauthorized())
}

#[derive(Clone)]
struct App {
    engine: Arc<dyn SearchBackend>,
    key: Arc<[u8]>,
    bearer: Arc<[u8]>,
    permits: Arc<Semaphore>,
}

/// Construct routes. The caller must bind loopback and configure its private proxy.
///
/// # Errors
/// Refuses short credentials so the service cannot accidentally start unsecured.
pub fn router(
    engine: Arc<dyn SearchBackend>,
    key: Vec<u8>,
    bearer: Vec<u8>,
) -> Result<Router, Error> {
    if key.len() < 32 || bearer.len() < 32 {
        return Err(Error::Invalid(
            "Use separate signing and bearer secrets of at least 32 bytes.".into(),
        ));
    }
    if key == bearer {
        return Err(Error::Invalid(
            "Signing and bearer secrets must differ.".into(),
        ));
    }
    Ok(Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/search", post(search))
        .route("/ticket-search", post(ticket_search))
        .layer(DefaultBodyLimit::max(16 * 1024))
        .with_state(App {
            engine,
            key: key.into(),
            bearer: bearer.into(),
            permits: Arc::new(Semaphore::new(8)),
        }))
}

/// Domain-separation purposes. Cursors are signed so a client cannot forge
/// a deep `offset` (bypassing pagination) or reset the TTL through `now`.
const TICKET_PURPOSE: &str = "xearch-ticket-v1";
const RECEIPT_PURPOSE: &str = "xearch-receipt-v1";
const CURSOR_PURPOSE: &str = "xearch-cursor-v1";
const BEARER_PURPOSE: &str = "bearer";

fn unauthorized() -> HttpError {
    (
        StatusCode::UNAUTHORIZED,
        "Invalid or expired search authorization.".into(),
    )
}

fn map_error(error: Error) -> HttpError {
    match error {
        Error::Invalid(message) => (StatusCode::BAD_REQUEST, message),
        Error::StaleCursor => (
            StatusCode::CONFLICT,
            "The index changed. Start a new search.".into(),
        ),
        Error::Storage(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            "Search storage unavailable.".into(),
        ),
    }
}

async fn run(app: &App, mut request: SearchRequest) -> Result<SearchResponse, HttpError> {
    request.validate().map_err(map_error)?;
    // Cursors cross the wire HMAC-signed; verify before the engine sees them.
    if let Some(outer) = request.cursor.take() {
        let signed: Signed = serde_json::from_str(outer.as_str())
            .map_err(|_| (StatusCode::BAD_REQUEST, "Invalid cursor signature.".into()))?;
        verify(&signed, CURSOR_PURPOSE, &app.key)?;
        request.cursor = Some(signed.payload);
    }
    let expression =
        search_query::parse(&request.query, request.author.as_deref()).map_err(map_error)?;
    let permit = Arc::clone(&app.permits).try_acquire_owned().map_err(|_| {
        (
            StatusCode::TOO_MANY_REQUESTS,
            "Search is busy. Retry shortly.".into(),
        )
    })?;
    let engine = Arc::clone(&app.engine);
    let task = tokio::task::spawn_blocking(move || {
        let result = engine.search(
            &expression,
            &request,
            jiff::Timestamp::now().as_millisecond(),
        );
        drop(permit);
        result
    });
    // Blocking work retains its permit even if the caller times out or disconnects.
    let mut response = tokio::time::timeout(std::time::Duration::from_secs(10), task)
        .await
        .map_err(|_| (StatusCode::GATEWAY_TIMEOUT, "Search timed out.".into()))?
        .map_err(|_| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "Search worker failed.".into(),
            )
        })?
        .map_err(map_error)?;
    let mut truncated = false;
    for post in &mut response.rows {
        truncated |= truncate(&mut post.text, 6000);
        if let Some(name) = &mut post.display_name {
            truncated |= truncate(name, 100);
        }
        if post.links.len() > 10 {
            post.links.truncate(10);
            truncated = true;
        }
    }
    if truncated {
        response
            .warnings
            .push("Some display fields were truncated; the full text remains indexed.".into());
    }
    // Re-sign any continuing cursor so page depth stays server-controlled.
    if let Some(cursor) = response.next_cursor.take() {
        let signed = sign(cursor, CURSOR_PURPOSE, &app.key).map_err(map_error)?;
        let encoded = serde_json::to_string(&signed).map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Cursor encoding failed.".into(),
            )
        })?;
        response.next_cursor = Some(encoded);
    }
    Ok(response)
}

fn truncate(text: &mut String, limit: usize) -> bool {
    let mut units = 0_usize;
    let boundary = text.char_indices().find_map(|(offset, c)| {
        units = units.saturating_add(c.len_utf16());
        (units > limit).then_some(offset)
    });
    boundary.is_some_and(|boundary| {
        text.truncate(boundary);
        true
    })
}

async fn search(
    State(app): State<App>,
    headers: HeaderMap,
    Json(request): Json<SearchRequest>,
) -> Result<Json<SearchResponse>, HttpError> {
    let token = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .ok_or_else(unauthorized)?;
    // Compare fixed-length MACs instead of a timing-sensitive string comparison.
    let mut expected = mac(BEARER_PURPOSE, &app.key).map_err(map_error)?;
    expected.update(&app.bearer);
    let mut actual = mac(BEARER_PURPOSE, &app.key).map_err(map_error)?;
    actual.update(token.as_bytes());
    expected
        .verify_slice(&actual.finalize().into_bytes())
        .map_err(|_| unauthorized())?;
    run(&app, request).await.map(Json)
}

async fn ticket_search(
    State(app): State<App>,
    Json(signed): Json<Signed>,
) -> Result<Json<Signed>, HttpError> {
    verify(&signed, TICKET_PURPOSE, &app.key)?;
    let ticket: Ticket = serde_json::from_str(&signed.payload).map_err(|_| unauthorized())?;
    let now = jiff::Timestamp::now().as_millisecond();
    if ticket.expires_at <= now || ticket.expires_at > now.saturating_add(60_000) {
        return Err(unauthorized());
    }
    let result = run(&app, ticket.request).await?;
    let receipt = Receipt {
        session_id: ticket.session_id,
        owner: ticket.owner,
        expires_at: ticket.expires_at,
        result,
    };
    let payload = serde_json::to_string(&receipt).map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Result encoding failed.".into(),
        )
    })?;
    sign(payload, RECEIPT_PURPOSE, &app.key)
        .map(Json)
        .map_err(map_error)
}
