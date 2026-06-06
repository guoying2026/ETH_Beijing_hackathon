mod axum_websocket;
mod verifier;

// Stage 1 — module skeleton (placeholders; bodies moved in subsequent steps).
mod app_state;
mod domain;
mod util;
mod signing;
mod webhook;
mod ws;
mod storage;
mod auth;
mod api;

// Re-export moved items at crate root for backwards-compatible call sites
// (notably the existing tests in src/tests/). Pure stage-1 refactor — no
// new symbols are introduced.
pub(crate) use storage::record::ProofExportRecord;
pub(crate) use storage::repo::{init_db, insert_proof_record};
pub(crate) use api::meta::{health_handler, info_handler};
pub(crate) use api::proofs::{
    get_proof_by_tx_handler, get_proof_handler, list_proofs_handler, patch_proof_tx_handler,
};
// Test-only re-exports — referenced solely by src/tests/*.
#[cfg(test)]
pub(crate) use storage::export::record_to_response;
#[cfg(test)]
pub(crate) use storage::retention::{purge_expired_ephemeral, retain_until_str};
#[cfg(test)]
pub(crate) use storage::repo::{
    get_proof_by_session_id, get_proof_by_tx_hash, list_proofs, promote_to_committed,
    test_seed_proof_handler, PromoteOutcome,
};
#[cfg(test)]
pub(crate) use storage::record::ListQuery;

#[cfg(test)]
mod tests;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, patch},
    Router,
};
use hmac::{Hmac, Mac};
use sha2::Sha256 as HmacSha256;
use axum_websocket::{WebSocket, WebSocketUpgrade};
use rangeset::prelude::RangeSet;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::Path as StdPath;
use std::sync::Arc;
use std::time::Duration;
use tlsn::transcript::PartialTranscript;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{oneshot, Mutex};
use tokio::time::timeout;
use tokio_util::compat::FuturesAsyncReadCompatExt;
use tower_http::cors::CorsLayer;
use tracing::{debug, error, info, warn};
use uuid::Uuid;
use verifier::{verifier, TranscriptCommitmentSummary, TranscriptDirectionSummary};
use ws_stream_tungstenite::WsStream;
use k256::ecdsa::{SigningKey, Signature};
use sha3::{Keccak256, Digest};

#[tokio::main]
async fn main() {
    // Initialize tracing
    tracing_subscriber::fmt()
        .with_target(true)
        .with_max_level(tracing::Level::INFO)
        .with_thread_ids(true)
        .with_line_number(true)
        .init();

    // Load environment variables from .env (without overriding already-set env vars)
    let _ = dotenvy::dotenv();

    let verifier_address = match load_verifier_signer_from_env() {
        Ok((_signing_key, address)) => address,
        Err(e) => {
            error!("Verifier signer initialization failed: {}", e);
            std::process::exit(1);
        }
    };
    info!("Verifier signer address: {}", verifier_address);

    // Load configuration from YAML file
    let config = Config::load(StdPath::new("config.yaml"));
    info!(
        "Webhook configurations loaded: {} endpoints",
        config.webhooks.len()
    );
    for (server_name, webhook) in &config.webhooks {
        info!("  {} -> {}", server_name, webhook.url);
    }

    // Initialize SQLite proof store (R.11 5-year retention)
    let db_path = std::env::var("PROOF_DB_PATH").unwrap_or_else(|_| "evidence.db".to_string());
    let conn = init_db(&db_path);
    let db = Arc::new(std::sync::Mutex::new(conn));
    info!("SQLite proof store initialized at '{}'", db_path);

    // Background purge of expired ephemeral rows (§7.3 three-condition).
    // compliance + already-committed rows are never deleted.
    {
        let db_for_purge = db.clone();
        let interval_secs = storage::retention::purge_interval_secs();
        info!(
            "Spawning ephemeral purge task (interval {}s, retain compliance forever)",
            interval_secs
        );
        tokio::spawn(async move {
            let mut ticker =
                tokio::time::interval(std::time::Duration::from_secs(interval_secs));
            // First tick fires immediately — skip it so we don't purge on the same
            // event loop turn as startup.
            ticker.tick().await;
            loop {
                ticker.tick().await;
                let db = db_for_purge.clone();
                let result = tokio::task::spawn_blocking(move || {
                    let conn = db.lock().unwrap();
                    storage::retention::purge_expired_ephemeral(
                        &conn,
                        &current_timestamp_str(),
                    )
                })
                .await;
                match result {
                    Ok(Ok(0)) => debug!("ephemeral purge: nothing expired"),
                    Ok(Ok(n)) => info!("ephemeral purge: deleted {} expired row(s)", n),
                    Ok(Err(e)) => error!("ephemeral purge failed: {}", e),
                    Err(e) => error!("ephemeral purge task panicked: {}", e),
                }
            }
        });
    }

    // Load PROOF_API_KEYS (multi-tenant; format: "k1:tenantA,k2:tenantB,super:*").
    let proof_api_keys = auth::api_key::load_proof_api_keys_from_env();

    // Optional SIWE configuration (§6.3). Both SIWE_JWT_SECRET and SIWE_DOMAIN must
    // be set for /auth/* to mount; either alone yields a warning and SIWE stays off.
    let jwt_secret = std::env::var("SIWE_JWT_SECRET").ok().filter(|s| !s.is_empty());
    let siwe_domain = std::env::var("SIWE_DOMAIN").ok().filter(|s| !s.is_empty());
    let siwe_enabled = match (&jwt_secret, &siwe_domain) {
        (Some(_), Some(_)) => true,
        (Some(_), None) => {
            warn!("SIWE_JWT_SECRET is set but SIWE_DOMAIN is missing — /auth/* disabled");
            false
        }
        (None, Some(_)) => {
            warn!("SIWE_DOMAIN is set but SIWE_JWT_SECRET is missing — /auth/* disabled");
            false
        }
        _ => false,
    };
    let (effective_jwt_secret, effective_domain) = if siwe_enabled {
        (jwt_secret, siwe_domain)
    } else {
        (None, None)
    };

    // Create application state with session storage, config, and DB
    let app_state = Arc::new(AppState {
        sessions: Arc::new(Mutex::new(HashMap::new())),
        config: Arc::new(config),
        db: db.clone(),
        proof_api_keys,
        jwt_secret: effective_jwt_secret,
        siwe_domain: effective_domain,
        siwe_nonces: Arc::new(std::sync::Mutex::new(HashMap::new())),
        ws_rate_limiter: Arc::new(std::sync::Mutex::new(HashMap::new())),
    });

    if app_state.proof_api_keys.is_empty() {
        warn!("Proof API: authentication DISABLED — set PROOF_API_KEYS for production");
    } else {
        let n_super = app_state
            .proof_api_keys
            .values()
            .filter(|s| s.tenant_id.is_none())
            .count();
        let n_tenant = app_state.proof_api_keys.len() - n_super;
        info!(
            "Proof API: authentication ENABLED ({} super, {} tenant-scoped)",
            n_super, n_tenant
        );
    }

    let cors = {
        let origins_str = std::env::var("CORS_ALLOW_ORIGINS")
            .unwrap_or_else(|_| "http://localhost:3000,http://localhost:8080".to_string());
        let origins: Vec<axum::http::HeaderValue> = origins_str
            .split(',')
            .filter_map(|s| s.trim().parse().ok())
            .collect();
        if origins.is_empty() {
            CorsLayer::permissive()
        } else {
            CorsLayer::new()
                .allow_origin(origins)
                .allow_methods([
                    axum::http::Method::GET,
                    axum::http::Method::PATCH,
                    axum::http::Method::POST,
                    axum::http::Method::OPTIONS,
                ])
                .allow_headers([
                    axum::http::header::CONTENT_TYPE,
                    axum::http::header::AUTHORIZATION,
                ])
        }
    };

    // Build router with routes
    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/info", get(info_handler))
        .route("/session", get(session_ws_handler))
        .route("/verifier", get(verifier_ws_handler))
        .route("/proxy", get(proxy_ws_handler))
        // R.11 proof store endpoints
        .route("/proof/:session_id", get(get_proof_handler))
        .route("/proof/:session_id/tx", patch(patch_proof_tx_handler))
        .route("/proof", get(get_proof_by_tx_handler))
        .route("/proofs", get(list_proofs_handler));

    // §6.3: /auth/* endpoints are only mounted when SIWE is configured.
    let app = if siwe_enabled {
        info!("SIWE auth ENABLED (domain={:?}); /auth/nonce + /auth/verify mounted",
              app_state.siwe_domain);
        app.route("/auth/nonce", get(api::auth::nonce_handler))
            .route("/auth/verify", axum::routing::post(api::auth::verify_handler))
    } else {
        app
    };

    let app = app
        .layer(axum::extract::DefaultBodyLimit::max(65_536))
        .layer(cors)
        .with_state(app_state);

    // Start server
    let addr = SocketAddr::from(([0, 0, 0, 0], 7047));
    info!("TLSNotary Verifier Server starting on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("Failed to bind to address");

    info!("Server listening on http://{}", addr);
    info!("Health endpoint: http://{}/health", addr);
    info!("Info endpoint: http://{}/info", addr);
    info!("Session WebSocket endpoint: ws://{}/session", addr);
    info!(
        "Verifier WebSocket endpoint: ws://{}/verifier?sessionId=<id>",
        addr
    );
    info!("Proxy WebSocket endpoint: ws://{}/proxy?token=<host>", addr);

    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .tcp_nodelay(true)
        .await
        .expect("Server error");
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub(crate) enum HandlerType {
    Sent,
    Recv,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum HandlerPart {
    StartLine,
    Protocol,
    Method,
    RequestTarget,
    StatusCode,
    Headers,
    Body,
    All,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Handler {
    #[serde(rename = "type")]
    pub(crate) handler_type: HandlerType,
    pub(crate) part: HandlerPart,
    /// Semantic label for Travel Rule field extraction (R.16), e.g. "originator.amount"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) label: Option<String>,
}

// Session data structure (without handlers - they come later with ranges)
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionConfig {
    #[serde(rename = "maxRecvData")]
    max_recv_data: usize,
    #[serde(rename = "maxSentData")]
    max_sent_data: usize,
}

// Range with handler metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct RangeWithHandler {
    pub(crate) start: usize,
    pub(crate) end: usize,
    pub(crate) handler: Handler,
}

// Account hash check: verifier compares keccak256 of transcript slice against expected hash
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct AccountCheck {
    pub(crate) direction: String,
    pub(crate) start: usize,
    pub(crate) end: usize,
    #[serde(rename = "expectedHash")]
    pub(crate) expected_hash: String,
    /// How to derive bytes to hash from the matched range.
    /// "full"       (default): hash entire range as-is
    /// "json_value": extract inner string value from "key":"value" fragment, hash without quotes/key
    #[serde(rename = "valueMode", default = "default_value_mode")]
    pub(crate) value_mode: String,
}

fn default_value_mode() -> String {
    "full".to_string()
}

/// Extract the inner string value from a JSON key-value fragment like `"key":"value"`.
/// Returns the bytes of `value` without surrounding quotes.
/// Returns None if the fragment doesn't match the expected pattern.
fn extract_json_string_value(data: &[u8]) -> Option<&[u8]> {
    let s = std::str::from_utf8(data).ok()?;
    // Find the colon separating key from value
    let colon_pos = s.find(':')?;
    let after_colon = s[colon_pos + 1..].trim_start();
    // Value must be a quoted string
    if !after_colon.starts_with('"') {
        return None;
    }
    let inner = &after_colon[1..];
    let closing_quote = inner.find('"')?;
    // Calculate byte offset of the opening quote of the value in the original slice
    let value_start = colon_pos + 1 + (s[colon_pos + 1..].len() - after_colon.len()) + 1;
    Some(&data[value_start..value_start + closing_quote])
}

// Reveal configuration sent before prover.reveal()
#[derive(Debug, Clone, Serialize, Deserialize)]
struct RevealConfig {
    sent: Vec<RangeWithHandler>,
    recv: Vec<RangeWithHandler>,
    #[serde(rename = "accountChecks", default)]
    account_checks: Vec<AccountCheck>,
}

// Handler result with revealed value, aligned to transcript_commitments index
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HandlerResult {
    /// Index into transcript_commitments[] this result corresponds to
    commitment_index: usize,
    #[serde(flatten)]
    handler: Handler,
    value: String,
    /// Byte offset (inclusive) in the original transcript
    start: usize,
    /// Byte offset (exclusive) in the original transcript
    end: usize,
}

#[derive(Debug, Clone, Serialize)]
struct TranscriptRangeSummary {
    start: usize,
    end: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VerifierTranscriptSummary {
    sent: Vec<u8>,
    recv: Vec<u8>,
    sent_authed: Vec<TranscriptRangeSummary>,
    recv_authed: Vec<TranscriptRangeSummary>,
}

/// Verifier secp256k1 signature of transcript commitments
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VerifierSignature {
    chain_id: u64,
    session_id: String,
    /// keccak256(hashHex[0] || hashHex[1] || ...), hex without 0x
    commitments_hash: String,
    /// keccak256(escrow||chainId||merchant||buyer||productId||orderId||assetType||amount||rate||deadline)
    /// "0x"-prefixed 32-byte hex, echoed from session_data["__tlsn_order_binding_hash"]
    #[serde(skip_serializing_if = "Option::is_none")]
    order_binding_hash: Option<String>,
    /// 65-byte ECDSA signature r+s+v, hex without 0x
    signature: String,
    /// 0x-prefixed Ethereum address derived from verifier public key
    verifier_address: String,
    /// Policy version locked into this signature (R.15)
    #[serde(skip_serializing_if = "Option::is_none")]
    policy_version: Option<String>,
    /// keccak256(policyVersion UTF-8), or 0x00..00 when policyVersion is absent
    policy_version_hash: String,
}

// Verification result containing handler results
#[derive(Debug, Clone, Serialize)]
struct VerificationResult {
    /// Revealed items sorted by commitment_index (same order as transcript_commitments).
    /// Hidden commitments have no entry here.
    results: Vec<HandlerResult>,
    transcript_commitments: Vec<TranscriptCommitmentSummary>,
    verifier_transcript: Option<VerifierTranscriptSummary>,
    verifier_signature: Option<VerifierSignature>,
    server_name: String,
}

// Type alias for the prover WebSocket sender
type ProverSocketSender = oneshot::Sender<WebSocket>;

// Session data stored in AppState (only prover socket sender - config/sessionData passed directly to verifier task)
pub(crate) struct SessionData {
    pub(crate) prover_socket_tx: ProverSocketSender,
}

// Application state for sharing data between handlers
#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) sessions: Arc<Mutex<HashMap<String, SessionData>>>,
    pub(crate) config: Arc<Config>,
    /// SQLite connection for R.11 proof persistence (std::sync::Mutex, not tokio)
    pub(crate) db: Arc<std::sync::Mutex<rusqlite::Connection>>,
    /// Proof API keys → scope (tenant_id None ⇒ SuperAdmin). Empty map = no tenant/super keys.
    pub(crate) proof_api_keys: HashMap<String, auth::api_key::KeyScope>,
    /// HS256 secret for SIWE JWTs. None ⇒ /auth/* disabled and no User principal.
    pub(crate) jwt_secret: Option<String>,
    /// EIP-4361 domain that incoming SIWE messages must declare. None ⇒ unset (no SIWE).
    pub(crate) siwe_domain: Option<String>,
    /// In-memory SIWE nonce store (issued → consumed-on-verify; short TTL).
    pub(crate) siwe_nonces: Arc<auth::siwe::NonceStore>,
    /// Per-IP WS connection rate limiter: IpAddr → (count_in_window, window_start)
    pub(crate) ws_rate_limiter: Arc<std::sync::Mutex<HashMap<std::net::IpAddr, (u32, std::time::Instant)>>>,
}

// Query parameters for verifier WebSocket connection
#[derive(Debug, Deserialize)]
struct VerifierQuery {
    #[serde(rename = "sessionId")]
    session_id: String,
}

// Query parameters for proxy WebSocket connection
// Supports both `token` (notary.pse.dev compatible) and `host` (legacy)
#[derive(Debug, Deserialize)]
struct ProxyQuery {
    #[serde(alias = "host")]
    token: String,
}

// ============================================================================
// WebSocket Message Protocol (Typed Messages)
// ============================================================================

/// Incoming messages from client (extension)
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMessage {
    /// Registration message - sent first to establish session
    Register {
        #[serde(rename = "maxRecvData")]
        max_recv_data: usize,
        #[serde(rename = "maxSentData")]
        max_sent_data: usize,
        #[serde(rename = "sessionData", default)]
        session_data: HashMap<String, String>,
    },
    /// Reveal configuration - sent with ranges and handlers
    RevealConfig {
        sent: Vec<RangeWithHandler>,
        recv: Vec<RangeWithHandler>,
        #[serde(rename = "accountChecks", default)]
        account_checks: Vec<AccountCheck>,
    },
}

/// Outgoing messages to client (extension)
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServerMessage {
    /// Session registered successfully
    SessionRegistered {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    /// MPC-TLS complete — commitments ready, client must now send reveal_config
    TranscriptReady {
        #[serde(rename = "transcriptCommitments")]
        transcript_commitments: Vec<TranscriptCommitmentSummary>,
    },
    /// Session completed with results
    SessionCompleted {
        results: Vec<HandlerResult>,
        #[serde(rename = "transcriptCommitments")]
        transcript_commitments: Vec<TranscriptCommitmentSummary>,
        #[serde(rename = "verifierTranscript", skip_serializing_if = "Option::is_none")]
        verifier_transcript: Option<VerifierTranscriptSummary>,
        #[serde(rename = "verifierSignature", skip_serializing_if = "Option::is_none")]
        verifier_signature: Option<VerifierSignature>,
        #[serde(rename = "serverName")]
        server_name: String,
    },
    /// Error occurred
    Error {
        message: String,
    },
}

// ============================================================================
// Webhook Types
// ============================================================================

/// Webhook configuration for a specific server
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct WebhookConfig {
    pub(crate) url: String,
    #[serde(default)]
    pub(crate) headers: HashMap<String, String>,
    /// Optional HMAC-SHA256 secret for X-TLSN-Signature header (R.11 security)
    #[serde(default)]
    pub(crate) secret: Option<String>,
}

/// Application configuration loaded from YAML
#[derive(Debug, Clone, Deserialize, Default)]
pub(crate) struct Config {
    #[serde(default)]
    pub(crate) webhooks: HashMap<String, WebhookConfig>,
}

impl Config {
    /// Load configuration from YAML file, returns default if file doesn't exist
    fn load(path: &StdPath) -> Self {
        match std::fs::read_to_string(path) {
            Ok(contents) => match serde_yaml::from_str(&contents) {
                Ok(config) => {
                    info!("Loaded config from {:?}", path);
                    config
                }
                Err(e) => {
                    warn!("Failed to parse config file {:?}: {}", path, e);
                    Self::default()
                }
            },
            Err(_) => {
                info!("No config file found at {:?}, using defaults", path);
                Self::default()
            }
        }
    }

    /// Get webhook configuration for a server name (with wildcard fallback)
    fn get_webhook(&self, server_name: &str) -> Option<&WebhookConfig> {
        self.webhooks
            .get(server_name)
            .or_else(|| self.webhooks.get("*"))
    }
}

/// Redacted transcript data - bytes outside revealed ranges are zeroed out
#[derive(Debug, Serialize)]
struct RedactedTranscript {
    /// Redacted sent data (request) - unrevealed bytes replaced with 0x00
    sent: String,
    /// Redacted received data (response) - unrevealed bytes replaced with 0x00
    recv: String,
    /// Original sent length before redaction
    sent_length: usize,
    /// Original recv length before redaction
    recv_length: usize,
}

impl RedactedTranscript {
    /// Create redacted transcript from raw bytes and reveal config
    fn from_transcript(
        sent_bytes: &[u8],
        recv_bytes: &[u8],
        reveal_config: &RevealConfig,
    ) -> Self {
        Self {
            sent: Self::redact_bytes(sent_bytes, &reveal_config.sent),
            recv: Self::redact_bytes(recv_bytes, &reveal_config.recv),
            sent_length: sent_bytes.len(),
            recv_length: recv_bytes.len(),
        }
    }

    /// Redact bytes by zeroing out bytes outside the revealed ranges
    fn redact_bytes(bytes: &[u8], ranges: &[RangeWithHandler]) -> String {
        let mut redacted = vec![0u8; bytes.len()];

        for range in ranges {
            if range.start < bytes.len() && range.end <= bytes.len() {
                redacted[range.start..range.end].copy_from_slice(&bytes[range.start..range.end]);
            }
        }

        // Convert to string - using lossy conversion for non-UTF8 bytes
        String::from_utf8_lossy(&redacted).to_string()
    }
}

// ============================================================================
// Compliance Structures (R.11, R.15, R.16)
// ============================================================================

/// Per-check result stored in DB and returned by GET /proof
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountCheckResult {
    pub(crate) direction: String,
    pub(crate) start: usize,
    pub(crate) end: usize,
    pub(crate) expected_hash: String,
    pub(crate) computed_hash: String,
    pub(crate) value_mode: String,
    pub(crate) passed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) field_label: Option<String>,
}

/// Single Travel Rule field value in the slim webhook payload
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TravelRuleFieldValue {
    value: String,
    commitment_index: usize,
}

/// Slim webhook payload — only fields needed for real-time compliance decisions.
/// Does NOT include raw transcript data (available separately via GET /proof/{id}).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SlimWebhookPayload {
    attestation_id: String,
    policy_version: Option<String>,
    server_name: String,
    /// Keyed by TravelRuleFieldLabel (e.g. "originator.amount"), only labeled handlers
    travel_rule_fields: HashMap<String, TravelRuleFieldValue>,
    account_checks_all_passed: bool,
    /// 65-byte ECDSA hex, or null if signing not configured
    verifier_signature: Option<String>,
    /// 0x-prefixed Ethereum address, or null
    verifier_address: Option<String>,
    order_binding_hash: Option<String>,
    /// ISO 8601 UTC timestamp
    timestamp: String,
}

// ============================================================================
// Proof Store HTTP Endpoints (R.11)
// ============================================================================

/// Returns true if this IP is within the per-IP WS rate limit, false if it should be rejected.
/// Window: 60 seconds. Limit: WS_RATE_LIMIT_PER_IP env var (default 10).
fn check_ws_rate_limit(state: &Arc<AppState>, ip: std::net::IpAddr) -> bool {
    let limit: u32 = std::env::var("WS_RATE_LIMIT_PER_IP")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(10);
    let window = std::time::Duration::from_secs(60);
    let mut limiter = state.ws_rate_limiter.lock().unwrap();
    let now = std::time::Instant::now();
    let entry = limiter.entry(ip).or_insert((0, now));
    if now.duration_since(entry.1) >= window {
        // Window expired — reset counter
        *entry = (1, now);
        true
    } else if entry.0 < limit {
        entry.0 += 1;
        true
    } else {
        false
    }
}

/// Returns true if `s` matches `^0x[0-9a-fA-F]{1,64}$`.
pub(crate) fn is_valid_tx_hash(s: &str) -> bool {
    s.starts_with("0x")
        && s.len() >= 3
        && s.len() <= 66
        && s[2..].chars().all(|c| c.is_ascii_hexdigit())
}

// WebSocket session handler for extension
pub(crate) async fn session_ws_handler(
    ws: WebSocketUpgrade,
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if !check_ws_rate_limit(&state, addr.ip()) {
        warn!("[session_ws_handler] Rate limit exceeded for {}", addr.ip());
        return (StatusCode::TOO_MANY_REQUESTS, "Rate limit exceeded").into_response();
    }
    ws.on_upgrade(move |socket| handle_session_websocket(socket, state))
}

/// Helper to send typed server messages
async fn send_server_message(socket: &mut WebSocket, message: &ServerMessage) -> bool {
    match socket
        .send(axum_websocket::Message::Text(
            serde_json::to_string(message).unwrap(),
        ))
        .await
    {
        Ok(_) => true,
        Err(e) => {
            error!("Failed to send message: {}", e);
            false
        }
    }
}

/// Helper to send error message
async fn send_error(socket: &mut WebSocket, message: &str) {
    let _ = send_server_message(socket, &ServerMessage::Error {
        message: message.to_string(),
    })
    .await;
}

// Handle the session WebSocket connection with typed message protocol
async fn handle_session_websocket(mut socket: WebSocket, state: Arc<AppState>) {
    use futures_util::StreamExt;

    // Generate session ID upfront (but don't send yet - wait for register)
    let session_id = Uuid::new_v4().to_string();
    info!("[{}] New session WebSocket connected", session_id);

    // Wait for "register" message first
    let register_msg = match socket.next().await {
        Some(Ok(axum_websocket::Message::Text(text))) => text,
        Some(Ok(msg)) => {
            error!("[{}] Expected text message, got: {:?}", session_id, msg);
            send_error(&mut socket, "Expected text message").await;
            return;
        }
        Some(Err(e)) => {
            error!("[{}] Error receiving message: {}", session_id, e);
            return;
        }
        None => {
            error!("[{}] Connection closed before registration", session_id);
            return;
        }
    };

    // Parse as ClientMessage
    let client_msg: ClientMessage = match serde_json::from_str(&register_msg) {
        Ok(msg) => msg,
        Err(e) => {
            error!("[{}] Failed to parse message: {}", session_id, e);
            send_error(&mut socket, &format!("Invalid message format: {}", e)).await;
            return;
        }
    };

    // Expect "register" message type
    let (max_recv_data, max_sent_data, session_data) = match client_msg {
        ClientMessage::Register {
            max_recv_data,
            max_sent_data,
            session_data,
        } => (max_recv_data, max_sent_data, session_data),
        _ => {
            error!("[{}] Expected 'register' message type", session_id);
            send_error(&mut socket, "Expected 'register' message type").await;
            return;
        }
    };

    info!(
        "[{}] Received registration: maxRecvData={}, maxSentData={}, sessionData keys: {:?}",
        session_id,
        max_recv_data,
        max_sent_data,
        session_data.keys().collect::<Vec<_>>()
    );

    // Send session_registered response
    if !send_server_message(
        &mut socket,
        &ServerMessage::SessionRegistered {
            session_id: session_id.clone(),
        },
    )
    .await
    {
        error!("[{}] Failed to send session_registered", session_id);
        return;
    }

    info!("[{}] Sent session_registered to client", session_id);

    // Create channels for prover socket, results, and commitments notification
    let (prover_socket_tx, prover_socket_rx) = oneshot::channel::<WebSocket>();
    let (result_tx, result_rx) = oneshot::channel::<VerificationResult>();
    let (commitments_tx, commitments_rx) = oneshot::channel::<Vec<TranscriptCommitmentSummary>>();

    // Create shared reveal config storage and session data storage
    let reveal_config_storage = Arc::new(Mutex::new(None));
    let session_data_storage = Arc::new(session_data.clone());

    let session_config = SessionConfig {
        max_recv_data,
        max_sent_data,
    };

    // Store session data (so prover can connect) — enforce WS_MAX_SESSIONS cap
    {
        let mut sessions = state.sessions.lock().await;
        let max_sessions: usize = std::env::var("WS_MAX_SESSIONS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(100);
        if sessions.len() >= max_sessions {
            warn!("[{}] WS_MAX_SESSIONS ({}) reached, rejecting new session", session_id, max_sessions);
            send_error(&mut socket, "Server at capacity — too many active sessions").await;
            return;
        }
        sessions.insert(session_id.clone(), SessionData { prover_socket_tx });
    }

    info!(
        "[{}] Session stored, prover can now connect to /verifier",
        session_id
    );

    // Spawn the verifier task with the result sender
    let session_id_clone = session_id.clone();
    let state_clone = state.clone();
    let reveal_config_storage_clone = reveal_config_storage.clone();
    let session_data_clone = session_data_storage.clone();
    tokio::spawn(async move {
        run_verifier_task(
            session_id_clone,
            session_config,
            (*session_data_clone).clone(),
            reveal_config_storage_clone,
            prover_socket_rx,
            result_tx,
            commitments_tx,
            state_clone,
        )
        .await;
    });

    info!(
        "[{}] Verifier task spawned, waiting for MPC-TLS to complete before reveal_config",
        session_id
    );

    // Wait for MPC-TLS to complete — run_verifier_task sends commitments when ready
    let transcript_commitments_for_client = match commitments_rx.await {
        Ok(c) => c,
        Err(_) => {
            error!("[{}] Verifier task dropped commitments channel unexpectedly", session_id);
            send_error(&mut socket, "Verification failed before commitments").await;
            return;
        }
    };

    info!(
        "[{}] MPC-TLS complete, sending transcript_ready ({} commitments)",
        session_id,
        transcript_commitments_for_client.len()
    );

    // Send transcript_ready so the client can build an accurate reveal_config
    if !send_server_message(
        &mut socket,
        &ServerMessage::TranscriptReady {
            transcript_commitments: transcript_commitments_for_client,
        },
    )
    .await
    {
        error!("[{}] Failed to send transcript_ready", session_id);
        return;
    }

    // Wait for reveal_config message
    let reveal_msg = match socket.next().await {
        Some(Ok(axum_websocket::Message::Text(text))) => text,
        Some(Ok(msg)) => {
            error!(
                "[{}] Expected text message for reveal_config, got: {:?}",
                session_id, msg
            );
            send_error(&mut socket, "Expected text message").await;
            return;
        }
        Some(Err(e)) => {
            error!("[{}] Error receiving reveal_config: {}", session_id, e);
            return;
        }
        None => {
            error!(
                "[{}] Connection closed before receiving reveal_config",
                session_id
            );
            return;
        }
    };

    // Parse as ClientMessage
    let client_msg: ClientMessage = match serde_json::from_str(&reveal_msg) {
        Ok(msg) => msg,
        Err(e) => {
            error!("[{}] Failed to parse reveal_config: {}", session_id, e);
            send_error(&mut socket, &format!("Invalid message format: {}", e)).await;
            return;
        }
    };

    // Expect "reveal_config" message type
    let reveal_config = match client_msg {
        ClientMessage::RevealConfig { sent, recv, account_checks } => RevealConfig { sent, recv, account_checks },
        _ => {
            error!("[{}] Expected 'reveal_config' message type", session_id);
            send_error(&mut socket, "Expected 'reveal_config' message type").await;
            return;
        }
    };

    info!(
        "[{}] Received reveal_config: {} sent ranges, {} recv ranges",
        session_id,
        reveal_config.sent.len(),
        reveal_config.recv.len()
    );

    // Store reveal config in shared storage
    {
        let mut storage = reveal_config_storage.lock().await;
        *storage = Some(reveal_config);
    }

    info!(
        "[{}] ✅ Reveal config stored, verifier task can now proceed",
        session_id
    );

    // Wait for verification result
    match result_rx.await {
        Ok(result) => {
            info!(
                "[{}] Received verification result, sending to extension",
                session_id
            );

            // Send session_completed to extension
            if send_server_message(
                &mut socket,
                &ServerMessage::SessionCompleted {
                    results: result.results,
                    transcript_commitments: result.transcript_commitments,
                    verifier_transcript: result.verifier_transcript,
                    verifier_signature: result.verifier_signature,
                    server_name: result.server_name,
                },
            )
            .await
            {
                info!("[{}] ✅ Sent session_completed to extension", session_id);
            } else {
                error!("[{}] Failed to send session_completed", session_id);
            }
        }
        Err(_) => {
            error!(
                "[{}] ❌ Verifier task closed without sending result",
                session_id
            );
            send_error(&mut socket, "Verification failed").await;
        }
    }

    // Close the WebSocket
    let _ = socket.close().await;
    info!("[{}] Session WebSocket closed", session_id);
}

// WebSocket handler for verifier (prover connection)
pub(crate) async fn verifier_ws_handler(
    ws: WebSocketUpgrade,
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    Query(query): Query<VerifierQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    if !check_ws_rate_limit(&state, addr.ip()) {
        warn!("[verifier_ws_handler] Rate limit exceeded for {}", addr.ip());
        return Err((StatusCode::TOO_MANY_REQUESTS, "Rate limit exceeded".to_string()));
    }
    let session_id = query.session_id;

    // Look up the session and extract the socket sender
    let prover_socket_tx = {
        let mut sessions = state.sessions.lock().await;
        sessions
            .remove(&session_id)
            .map(|session_data| session_data.prover_socket_tx)
    };

    match prover_socket_tx {
        Some(sender) => {
            info!(
                "[{}] Prover WebSocket connection established, passing to verifier",
                session_id
            );
            Ok(ws.on_upgrade(move |socket| async move {
                // Send the WebSocket to the waiting verifier
                if sender.send(socket).is_err() {
                    error!(
                        "[{}] Failed to send socket to verifier - channel closed",
                        session_id
                    );
                } else {
                    info!(
                        "[{}] Prover socket passed to verifier successfully",
                        session_id
                    );
                }
            }))
        }
        None => {
            error!("[{}] Session not found or already connected", session_id);
            Err((
                StatusCode::NOT_FOUND,
                format!("Session not found or already connected: {}", session_id),
            ))
        }
    }
}

// WebSocket proxy handler - bridges WebSocket to TCP
// Compatible with notary.pse.dev: /proxy?token=<host> or legacy /proxy?host=<host>
pub(crate) async fn proxy_ws_handler(
    ws: WebSocketUpgrade,
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    Query(query): Query<ProxyQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    if !check_ws_rate_limit(&state, addr.ip()) {
        warn!("[proxy_ws_handler] Rate limit exceeded for {}", addr.ip());
        return Err((StatusCode::TOO_MANY_REQUESTS, "Rate limit exceeded".to_string()));
    }
    let host = query.token;

    info!("[Proxy] New proxy request for host: {}", host);

    Ok(ws.on_upgrade(move |socket| handle_proxy_connection(socket, host)))
}

// Handle the proxy WebSocket connection by bridging to TCP
async fn handle_proxy_connection(ws: WebSocket, host: String) {
    use futures_util::{SinkExt, StreamExt};

    let proxy_id = Uuid::new_v4().to_string();
    info!(
        "[{}] Proxy WebSocket connected for host: {}",
        proxy_id, host
    );

    // Parse host and port (default to 443 for HTTPS)
    let (hostname, port) = if host.contains(':') {
        let parts: Vec<&str> = host.split(':').collect();
        (
            parts[0].to_string(),
            parts.get(1).and_then(|p| p.parse().ok()).unwrap_or(443),
        )
    } else {
        (host.clone(), 443)
    };

    info!("[{}] Connecting to {}:{}", proxy_id, hostname, port);

    // Connect to the remote TCP host
    let tcp_stream = match tokio::net::TcpStream::connect((hostname.as_str(), port)).await {
        Ok(stream) => {
            info!(
                "[{}] TCP connection established to {}:{}",
                proxy_id, hostname, port
            );
            stream
        }
        Err(e) => {
            error!(
                "[{}] Failed to connect to {}:{} - {}",
                proxy_id, hostname, port, e
            );
            return;
        }
    };

    // Split WebSocket into sink and stream
    let (mut ws_sink, mut ws_stream) = ws.split();

    // Split the TCP stream into read and write halves
    let (mut tcp_read, mut tcp_write) = tokio::io::split(tcp_stream);

    // Spawn task to forward WebSocket -> TCP
    // Read WebSocket Binary messages and write payload to TCP
    let proxy_id_clone = proxy_id.clone();
    let ws_to_tcp = tokio::spawn(async move {
        let mut total_bytes = 0u64;

        loop {
            match ws_stream.next().await {
                Some(Ok(msg)) => {
                    match msg {
                        axum_websocket::Message::Binary(data) => {
                            let len = data.len();
                            total_bytes += len as u64;

                            if let Err(e) = tcp_write.write_all(&data).await {
                                error!("[{}] Failed to write to TCP: {}", proxy_id_clone, e);
                                break;
                            }
                        }
                        axum_websocket::Message::Close(_) => {
                            info!(
                                "[{}] WebSocket close frame received, forwarded {} bytes total",
                                proxy_id_clone, total_bytes
                            );
                            break;
                        }
                        _ => {
                            // Ignore Text, Ping, Pong messages for now
                        }
                    }
                }
                Some(Err(e)) => {
                    error!("[{}] WebSocket read error: {}", proxy_id_clone, e);
                    break;
                }
                None => {
                    info!(
                        "[{}] WebSocket stream ended, forwarded {} bytes total",
                        proxy_id_clone, total_bytes
                    );
                    break;
                }
            }
        }

        total_bytes
    });

    // Spawn task to forward TCP -> WebSocket
    // Read from TCP and wrap in WebSocket Binary messages
    let proxy_id_clone = proxy_id.clone();
    let tcp_to_ws = tokio::spawn(async move {
        let mut buf = vec![0u8; 8192];
        let mut total_bytes = 0u64;

        loop {
            match tcp_read.read(&mut buf).await {
                Ok(0) => {
                    info!(
                        "[{}] TCP read EOF (server closed), forwarded {} bytes to WebSocket",
                        proxy_id_clone, total_bytes
                    );
                    // Send WebSocket close frame to signal EOF to client
                    if let Err(e) = ws_sink.send(axum_websocket::Message::Close(None)).await {
                        error!("[{}] Failed to send WebSocket close frame: {}", proxy_id_clone, e);
                    }
                    break;
                }
                Ok(n) => {
                    total_bytes += n as u64;
                    let binary_msg = axum_websocket::Message::Binary(buf[..n].to_vec());

                    if let Err(e) = ws_sink.send(binary_msg).await {
                        error!("[{}] Failed to send to WebSocket: {}", proxy_id_clone, e);
                        break;
                    }
                }
                Err(e) => {
                    error!("[{}] TCP read error: {}", proxy_id_clone, e);
                    // Send close frame on error too
                    let _ = ws_sink.send(axum_websocket::Message::Close(None)).await;
                    break;
                }
            }
        }

        total_bytes
    });

    // Wait for both tasks to complete
    let (ws_result, tcp_result) = tokio::join!(ws_to_tcp, tcp_to_ws);

    let ws_total = ws_result.unwrap_or(0);
    let tcp_total = tcp_result.unwrap_or(0);

    info!(
        "[{}] Proxy closed: WS→TCP {} bytes, TCP→WS {} bytes",
        proxy_id, ws_total, tcp_total
    );
}

// Verifier task that waits for WebSocket and runs verification
async fn run_verifier_task(
    session_id: String,
    config: SessionConfig,
    session_data: HashMap<String, String>,
    reveal_config_storage: Arc<Mutex<Option<RevealConfig>>>,
    socket_rx: oneshot::Receiver<WebSocket>,
    result_tx: oneshot::Sender<VerificationResult>,
    commitments_tx: oneshot::Sender<Vec<TranscriptCommitmentSummary>>,
    state: Arc<AppState>,
) {
    info!(
        "[{}] Verifier task started, waiting for WebSocket connection...",
        session_id
    );
    info!(
        "[{}] Configuration: maxRecvData={}, maxSentData={}",
        session_id, config.max_recv_data, config.max_sent_data
    );

    // Wait for WebSocket connection with timeout (configurable via WS_CONNECTION_TIMEOUT_SECS)
    let connection_timeout = Duration::from_secs(
        std::env::var("WS_CONNECTION_TIMEOUT_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(60),
    );
    let socket_result = timeout(connection_timeout, socket_rx).await;

    let socket = match socket_result {
        Ok(Ok(socket)) => {
            info!(
                "[{}] ✅ WebSocket received, starting verification",
                session_id
            );
            socket
        }
        Ok(Err(_)) => {
            error!(
                "[{}] ❌ Socket channel closed before connection",
                session_id
            );
            cleanup_session(&state, &session_id).await;
            return;
        }
        Err(_) => {
            error!(
                "[{}] ⏱️  Timed out waiting for WebSocket connection after {:?}",
                session_id, connection_timeout
            );
            cleanup_session(&state, &session_id).await;
            return;
        }
    };

    // Convert WebSocket to WsStream for AsyncRead/AsyncWrite compatibility
    let stream = WsStream::new(socket.into_inner());
    info!("[{}] WebSocket converted to stream", session_id);

    // Convert from futures AsyncRead/AsyncWrite to tokio AsyncRead/AsyncWrite
    let stream = stream.compat();

    // Run the verifier with timeout (configurable via WS_VERIFICATION_TIMEOUT_SECS)
    let verification_timeout = Duration::from_secs(
        std::env::var("WS_VERIFICATION_TIMEOUT_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(120),
    );
    info!(
        "[{}] Starting verification with timeout of {:?}",
        session_id, verification_timeout
    );

    let verification_result = timeout(
        verification_timeout,
        verifier(stream, config.max_sent_data, config.max_recv_data),
    )
    .await;

    // Handle the verification result
    match verification_result {
        Ok(Ok((server_name, transcript, transcript_commitments))) => {
            info!("[{}] ✅ Verification completed successfully!", session_id);

            // Extract sent and received data
            let sent_bytes = transcript.sent_unsafe().to_vec();
            let recv_bytes = transcript.received_unsafe().to_vec();

            info!(
                "[{}] Sent data length: {} bytes (authed: {} bytes)",
                session_id,
                sent_bytes.len(),
                transcript.sent_authed().len(),
            );
            info!(
                "[{}] Received data length: {} bytes (authed: {} bytes)",
                session_id,
                recv_bytes.len(),
                transcript.received_authed().len()
            );

            // Notify session_ws_handler that MPC-TLS is complete and share the commitments.
            // The handler will forward them to the client as "transcript_ready", enabling
            // the client to build a reveal_config whose ranges exactly match the commitment
            // boundaries (one range per commitment).
            if commitments_tx.send(transcript_commitments.clone()).is_err() {
                error!("[{}] session_ws_handler already gone — aborting", session_id);
                cleanup_session(&state, &session_id).await;
                return;
            }

            // Wait for RevealConfig to be available (with polling and timeout)
            let reveal_config_wait_timeout = Duration::from_secs(30);
            let start_time = tokio::time::Instant::now();

            let reveal_config = loop {
                {
                    let storage = reveal_config_storage.lock().await;
                    if let Some(config) = storage.as_ref() {
                        info!("[{}] ✅ RevealConfig found, mapping results", session_id);
                        break config.clone();
                    }
                }

                // Check timeout
                if start_time.elapsed() > reveal_config_wait_timeout {
                    error!(
                        "[{}] ❌ Timed out waiting for RevealConfig after verification",
                        session_id
                    );
                    cleanup_session(&state, &session_id).await;
                    return;
                }

                // RevealConfig not available yet, wait a bit
                info!("[{}] Waiting for RevealConfig...", session_id);
                tokio::time::sleep(Duration::from_millis(100)).await;
            };

            // Account hash verification — check before proceeding to signing.
            // Collect all check results (pass and fail) for DB persistence.
            // field_label will be populated after handler_results is built below.
            let account_checks_json: Option<String>;
            let mut account_check_results: Vec<AccountCheckResult> = Vec::new();
            {
                let sent_bytes = transcript.sent_unsafe();
                let recv_bytes = transcript.received_unsafe();

                for check in &reveal_config.account_checks {
                    let transcript_bytes = match check.direction.as_str() {
                        "recv" => recv_bytes,
                        "sent" => sent_bytes,
                        other => {
                            error!("[{}] accountCheck: invalid direction '{}'", session_id, other);
                            cleanup_session(&state, &session_id).await;
                            return;
                        }
                    };
                    if check.end > transcript_bytes.len() || check.start > check.end {
                        error!("[{}] accountCheck: range [{}..{}) out of bounds (len={})", session_id, check.start, check.end, transcript_bytes.len());
                        cleanup_session(&state, &session_id).await;
                        return;
                    }
                    let raw = &transcript_bytes[check.start..check.end];
                    let bytes_to_hash: &[u8] = if check.value_mode == "json_value" {
                        extract_json_string_value(raw).unwrap_or_else(|| {
                            error!("[{}] accountCheck: json_value extraction failed at {}[{}..{}], falling back to full range", session_id, check.direction, check.start, check.end);
                            raw
                        })
                    } else {
                        raw
                    };
                    use sha3::{Digest, Keccak256};
                    let mut hasher = Keccak256::new();
                    hasher.update(bytes_to_hash);
                    let computed = format!("0x{}", hex::encode(hasher.finalize()));
                    let passed = computed == check.expected_hash;
                    account_check_results.push(AccountCheckResult {
                        direction: check.direction.clone(),
                        start: check.start,
                        end: check.end,
                        expected_hash: check.expected_hash.clone(),
                        computed_hash: computed.clone(),
                        value_mode: check.value_mode.clone(),
                        passed,
                        field_label: None, // populated after handler_results below
                    });
                    if !passed {
                        error!(
                            "[{}] accountCheck: hash mismatch at {}[{}..{}] — expected {} got {}",
                            session_id, check.direction, check.start, check.end, check.expected_hash, computed
                        );
                        cleanup_session(&state, &session_id).await;
                        return;
                    }
                    info!("[{}] ✅ accountCheck passed {}[{}..{}]", session_id, check.direction, check.start, check.end);
                }
            }

            // Validate that reveal_config ranges match authenticated transcript ranges
            if let Err((direction, start, end)) = verify_reveal_config(&reveal_config, &transcript)
            {
                error!(
                    "[{}] ❌ Invalid {} range [{}, {}) - not fully within authenticated ranges",
                    session_id, direction, start, end
                );
                cleanup_session(&state, &session_id).await;
                return;
            }

            info!(
                "[{}] ✅ All reveal_config ranges validated against authenticated transcript",
                session_id
            );

            // Build (direction, start, end) → (handler, extracted_value) lookup from reveal_config.
            // This avoids reordering: results will be keyed by commitment index, not SENT-then-RECV.
            let mut range_lookup: std::collections::HashMap<(String, usize, usize), (Handler, String)> =
                std::collections::HashMap::new();

            for rwh in &reveal_config.sent {
                let value = extract_bytes_as_string(&sent_bytes, rwh.start, rwh.end);
                range_lookup.insert(
                    ("SENT".to_string(), rwh.start, rwh.end),
                    (rwh.handler.clone(), value),
                );
            }
            for rwh in &reveal_config.recv {
                let value = extract_bytes_as_string(&recv_bytes, rwh.start, rwh.end);
                range_lookup.insert(
                    ("RECV".to_string(), rwh.start, rwh.end),
                    (rwh.handler.clone(), value),
                );
            }

            // Build handler_results.
            //
            // Preferred path: align each result to a transcript_commitment (commitment_index
            // gives the exact MPC-hash commitment the value is bound to).
            //
            // Fallback path (transcript_commitments is empty — e.g. this TLSNotary alpha
            // version does not populate VerifierOutput::transcript_commitments): produce one
            // HandlerResult per reveal_config range in declaration order, using sequential
            // indices.  The authentication guarantee still holds because we already ran
            // verify_reveal_config() above, which confirmed every range is within the
            // verifier-authenticated transcript.
            let handler_results: Vec<HandlerResult> = if !transcript_commitments.is_empty() {
                // ── Commitment-aligned path ──────────────────────────────────────────────
                transcript_commitments
                    .iter()
                    .enumerate()
                    .filter_map(|(i, commitment)| {
                        let dir = match commitment.direction {
                            Some(TranscriptDirectionSummary::Sent) => "SENT",
                            Some(TranscriptDirectionSummary::Recv) => "RECV",
                            None => return None,
                        };
                        let ranges = commitment.ranges.as_ref()?;
                        if ranges.len() != 1 {
                            return None;
                        }
                        let r = &ranges[0];
                        let key = (dir.to_string(), r.start, r.end);
                        let (handler, value) = range_lookup.get(&key)?;
                        Some(HandlerResult {
                            commitment_index: i,
                            handler: handler.clone(),
                            value: value.clone(),
                            start: r.start,
                            end: r.end,
                        })
                    })
                    .collect()
            } else {
                // ── Direct reveal_config path (no MPC commitments available) ─────────────
                let mut results: Vec<HandlerResult> = Vec::new();
                let mut idx = 0usize;

                for rwh in &reveal_config.sent {
                    let value = extract_bytes_as_string(&sent_bytes, rwh.start, rwh.end);
                    results.push(HandlerResult {
                        commitment_index: idx,
                        handler: rwh.handler.clone(),
                        value,
                        start: rwh.start,
                        end: rwh.end,
                    });
                    idx += 1;
                }
                for rwh in &reveal_config.recv {
                    let value = extract_bytes_as_string(&recv_bytes, rwh.start, rwh.end);
                    results.push(HandlerResult {
                        commitment_index: idx,
                        handler: rwh.handler.clone(),
                        value,
                        start: rwh.start,
                        end: rwh.end,
                    });
                    idx += 1;
                }
                results
            };

            info!(
                "[{}] Built {} revealed items ({} commitments)",
                session_id,
                handler_results.len(),
                transcript_commitments.len()
            );

            // Populate field_label in account_check_results using handler range→label lookup.
            {
                let handler_label_lookup: std::collections::HashMap<(String, usize, usize), String> =
                    handler_results
                        .iter()
                        .filter_map(|hr| {
                            hr.handler.label.as_ref().map(|lbl| {
                                let dir = match hr.handler.handler_type {
                                    HandlerType::Sent => "sent".to_string(),
                                    HandlerType::Recv => "recv".to_string(),
                                };
                                ((dir, hr.start, hr.end), lbl.clone())
                            })
                        })
                        .collect();
                for result in &mut account_check_results {
                    result.field_label = handler_label_lookup
                        .get(&(result.direction.clone(), result.start, result.end))
                        .cloned();
                }
            }
            account_checks_json = serde_json::to_string(&account_check_results).ok();

            let server_name_str = server_name.as_ref();

            // Extract policy_version from session_data (injected by SessionManager, T8)
            let policy_version: Option<String> = session_data
                .get("__tlsn_policy_version")
                .map(|s| s.clone())
                .filter(|s| s != "unspecified");

            // Extract orderBindingHash from session_data if provided by the client.
            // Expected format: "0x" + 64 hex chars (32 bytes).
            let order_binding_hash_bytes: Option<[u8; 32]> = session_data
                .get("__tlsn_order_binding_hash")
                .and_then(|s| hex::decode(s.trim_start_matches("0x")).ok())
                .and_then(|bytes| bytes.try_into().ok());
            let order_binding_hash_str: Option<String> =
                order_binding_hash_bytes.map(|b| format!("0x{}", hex::encode(b)));

            let include_verifier_transcript =
                session_flag_enabled(&session_data, "__tlsn_tc_include_verifier_transcript");
            let verifier_transcript = include_verifier_transcript
                .then(|| summarize_verifier_transcript(&transcript));

            // Sign transcript commitments with verifier private key (optional) — BEFORE webhook
            let verifier_signature = match load_verifier_signer_from_env() {
                Ok((signing_key, _verifier_address)) => {
                    let chain_id: u64 = std::env::var("CHAIN_ID")
                        .ok()
                        .and_then(|s| s.parse().ok())
                        .unwrap_or(11155111); // Sepolia

                    match sign_commitments(
                        &signing_key,
                        chain_id,
                        &session_id,
                        &transcript_commitments,
                        order_binding_hash_bytes,
                        policy_version.as_deref(),
                    ) {
                        Ok(sig) => {
                            info!(
                                "[{}] ✅ Commitments signed, verifier={}",
                                session_id, sig.verifier_address
                            );
                            Some(sig)
                        }
                        Err(e) => {
                            error!("[{}] ❌ Sign failed: {}", session_id, e);
                            None
                        }
                    }
                }
                Err(e) => {
                    if order_binding_hash_bytes.is_some() {
                        error!(
                            "[{}] ❌ Verifier signing key unavailable ({}) but orderBindingHash present — \
                             refusing to produce unsigned proof for on-chain flow",
                            session_id, e
                        );
                        // Drop result_tx without sending → session handler delivers
                        // "Verification failed" error to the extension (fail-closed).
                        return;
                    } else {
                        warn!(
                            "[{}] Verifier signing key unavailable ({}), skipping signature",
                            session_id, e
                        );
                        None
                    }
                }
            };

            // Create redacted transcript for persistence and slim webhook
            let redacted_transcript = RedactedTranscript::from_transcript(
                &sent_bytes,
                &recv_bytes,
                &reveal_config,
            );

            // Build slim webhook payload (Travel Rule fields only, no raw transcripts)
            let slim_payload = build_slim_webhook_payload(
                &session_id,
                policy_version.clone(),
                server_name_str,
                &handler_results,
                true, // account_checks_all_passed (passed verify above)
                &verifier_signature,
                order_binding_hash_str.clone(),
            );

            // Fire-and-forget slim webhook if configured for this server
            if let Some(webhook_config) = state.config.get_webhook(server_name_str) {
                info!(
                    "[{}] Webhook configured for {}, sending POST to {}",
                    session_id, server_name_str, webhook_config.url
                );
                let webhook_config = webhook_config.clone();
                let session_id_for_webhook = session_id.clone();
                let payload_for_webhook = slim_payload.clone();
                tokio::spawn(async move {
                    send_webhook(&webhook_config, &payload_for_webhook, &session_id_for_webhook).await;
                });
            }

            // Persist proof record to SQLite for R.11 (5-year retention)
            {
                let sig_hex = verifier_signature.as_ref().map(|s| s.signature.clone());
                let sig_addr = verifier_signature.as_ref().map(|s| s.verifier_address.clone());
                let commitments_hash = verifier_signature
                    .as_ref()
                    .map(|s| s.commitments_hash.clone())
                    .unwrap_or_default();
                let handler_results_json =
                    serde_json::to_string(&handler_results).unwrap_or_default();
                let session_data_json =
                    serde_json::to_string(&session_data).unwrap_or_default();
                let now = current_timestamp_str();
                let transcript_commitments_json =
                    serde_json::to_string(&transcript_commitments).ok();
                let signing_chain_id_val =
                    verifier_signature.as_ref().map(|s| s.chain_id as i64);

                // §3.3: retention is decided by whether this is a compliance proof
                // (carries an order_binding_hash), independent of status / PATCH.
                let is_compliance = order_binding_hash_str.is_some();
                let retention_class = if is_compliance { "compliance" } else { "ephemeral" };
                let until = storage::retention::compute_retain_until(retention_class);

                // §4.1: owner / counterparty / tenant come from client session_data.
                // Soft-fail (store NULL) on missing/invalid — never fail the proof (§7.1).
                let owner_address = session_data
                    .get("__tlsn_owner_address")
                    .and_then(|s| util::parse_owner_address(s));
                let counterparty_address = session_data
                    .get("__tlsn_counterparty_address")
                    .and_then(|s| util::parse_owner_address(s));
                // tenant_id: explicit session_data only this stage; server_name → tenant
                // mapping fallback (§4.3) is wired in stage 5. NULL when absent/empty.
                let tenant_id = session_data
                    .get("__tlsn_tenant_id")
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());

                let record = ProofExportRecord {
                    session_id: session_id.clone(),
                    server_name: server_name_str.to_string(),
                    policy_version: policy_version.clone(),
                    order_binding_hash: order_binding_hash_str.clone(),
                    commitments_hash,
                    verifier_signature: sig_hex,
                    verifier_address: sig_addr,
                    handler_results: handler_results_json,
                    account_checks: account_checks_json,
                    redacted_sent: Some(redacted_transcript.sent.clone()),
                    redacted_recv: Some(redacted_transcript.recv.clone()),
                    session_data: Some(session_data_json),
                    tx_hash: None,
                    recorded_at: now,
                    retain_until: until,
                    transcript_commitments: transcript_commitments_json,
                    signing_chain_id: signing_chain_id_val,
                    status: "provisional".to_string(),
                    retention_class: retention_class.to_string(),
                    owner_address,
                    counterparty_address,
                    tenant_id,
                    committed_at: None,
                };

                // §7.1.1 tiered write: bounded retry happens inside insert_proof_record.
                // compliance → fail-closed (drop result_tx → client sees "Verification
                // failed"); ephemeral → fail-open (log, proof still succeeds).
                let db = state.db.clone();
                let session_id_for_write = session_id.clone();
                let write_result = tokio::task::spawn_blocking(move || {
                    let conn = db.lock().unwrap();
                    insert_proof_record(&conn, &record)
                })
                .await;

                let persisted = match write_result {
                    Ok(Ok(())) => true,
                    Ok(Err(e)) => {
                        error!(
                            "[{}] Proof persist failed (retention_class={}): {}",
                            session_id_for_write, retention_class, e
                        );
                        false
                    }
                    Err(join_err) => {
                        error!(
                            "[{}] Proof persist task panicked (retention_class={}): {}",
                            session_id_for_write, retention_class, join_err
                        );
                        false
                    }
                };
                if !persisted && is_compliance {
                    error!(
                        "[{}] ❌ Compliance proof failed to persist after retries — failing closed",
                        session_id_for_write
                    );
                    return; // drop result_tx → extension receives "Verification failed"
                }
            }

            // Send result to extension via the result channel
            let result = VerificationResult {
                results: handler_results,
                transcript_commitments,
                verifier_transcript,
                verifier_signature,
                server_name: server_name.as_ref().to_string(),
            };

            if result_tx.send(result).is_err() {
                error!(
                    "[{}] ❌ Failed to send result to extension - channel closed",
                    session_id
                );
            } else {
                info!("[{}] ✅ Result sent to extension successfully", session_id);
            }
        }
        Ok(Err(e)) => {
            error!("[{}] ❌ Verification failed: {}", session_id, e);
            // Note: result_tx will be dropped, causing extension to receive an error
        }
        Err(_) => {
            error!(
                "[{}] ⏱️  Verification timed out after {:?}",
                session_id, verification_timeout
            );
            // Note: result_tx will be dropped, causing extension to receive an error
        }
    }

    // Clean up session (if it still exists in the map)
    cleanup_session(&state, &session_id).await;

    info!("[{}] Verifier task completed and cleaned up", session_id);
}

/// Validates that all ranges in reveal config are fully within authenticated transcript ranges.
/// Returns error with (direction, start, end) if any range contains unauthenticated data.
fn verify_reveal_config(
    reveal_config: &RevealConfig,
    transcript: &PartialTranscript,
) -> Result<(), (String, usize, usize)> {
    fn validate_ranges_against_auth_set(
        ranges: &[RangeWithHandler],
        auth_set: &RangeSet<usize>,
        direction: &str,
    ) -> Result<(), (String, usize, usize)> {
        for range in ranges {
            if !(range.start..range.end).all(|i| auth_set.contains(&i)) {
                return Err((direction.to_string(), range.start, range.end));
            }

            debug!(
                "✅ {} range [{}, {}) validated - fully within authenticated ranges",
                direction, range.start, range.end
            );
        }
        Ok(())
    }

    validate_ranges_against_auth_set(&reveal_config.sent, transcript.sent_authed(), "sent")?;
    validate_ranges_against_auth_set(&reveal_config.recv, transcript.received_authed(), "recv")?;

    Ok(())
}

fn session_flag_enabled(session_data: &HashMap<String, String>, key: &str) -> bool {
    session_data
        .get(key)
        .map(|value| {
            let lowered = value.trim().to_ascii_lowercase();
            matches!(lowered.as_str(), "1" | "true" | "yes" | "on")
        })
        .unwrap_or(false)
}

fn summarize_verifier_transcript(transcript: &PartialTranscript) -> VerifierTranscriptSummary {
    VerifierTranscriptSummary {
        sent: transcript.sent_unsafe().to_vec(),
        recv: transcript.received_unsafe().to_vec(),
        sent_authed: transcript
            .sent_authed()
            .iter()
            .map(|range| TranscriptRangeSummary {
                start: range.start,
                end: range.end,
            })
            .collect(),
        recv_authed: transcript
            .received_authed()
            .iter()
            .map(|range| TranscriptRangeSummary {
                start: range.start,
                end: range.end,
            })
            .collect(),
    }
}

// Helper function to clean up session from state
async fn cleanup_session(state: &Arc<AppState>, session_id: &str) {
    let mut sessions = state.sessions.lock().await;
    if sessions.remove(session_id).is_some() {
        info!("[{}] Session removed from state", session_id);
    }
}

/// Extract bytes[start..end] as a UTF-8 string (lossy). Returns an error string on bad range.
fn extract_bytes_as_string(bytes: &[u8], start: usize, end: usize) -> String {
    if start < bytes.len() && end <= bytes.len() && start < end {
        String::from_utf8_lossy(&bytes[start..end]).to_string()
    } else {
        format!("ERROR: Invalid range [{}, {})", start, end)
    }
}

// ============================================================================
// Compliance Helper Functions (R.11, R.15, R.16)
// ============================================================================

/// Convert Unix seconds to RFC3339 UTC string (YYYY-MM-DDTHH:MM:SSZ).
/// Uses Howard Hinnant's civil-from-days algorithm; no external crates required.
pub(crate) fn format_rfc3339(secs: u64) -> String {
    let days = (secs / 86400) as i64;
    let time = secs % 86400;
    let h = time / 3600;
    let m = (time % 3600) / 60;
    let s = time % 60;

    // Civil date from days since Unix epoch (1970-01-01)
    let z = days + 719468;
    let era = if z >= 0 { z / 146097 } else { (z - 146096) / 146097 };
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mth = if mp < 10 { mp + 3 } else { mp - 9 };
    let yr = if mth <= 2 { y + 1 } else { y };

    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", yr, mth, d, h, m, s)
}

/// Return current time as RFC3339 UTC string.
pub(crate) fn current_timestamp_str() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format_rfc3339(secs)
}

/// Compute HMAC-SHA256 hex of body using secret key.
pub(crate) fn compute_hmac_sha256(secret: &str, body: &str) -> String {
    let mut mac = Hmac::<HmacSha256>::new_from_slice(secret.as_bytes())
        .expect("HMAC key init failed");
    mac.update(body.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// Build a slim webhook payload from verification results.
pub(crate) fn build_slim_webhook_payload(
    session_id: &str,
    policy_version: Option<String>,
    server_name: &str,
    handler_results: &[HandlerResult],
    account_checks_all_passed: bool,
    verifier_signature: &Option<VerifierSignature>,
    order_binding_hash: Option<String>,
) -> SlimWebhookPayload {
    let mut travel_rule_fields = HashMap::new();
    for result in handler_results {
        if let Some(ref label) = result.handler.label {
            if travel_rule_fields.contains_key(label) {
                warn!(
                    "[{}] Duplicate travel_rule label '{}' — previous value will be overwritten. \
                     Consider using unique labels or upgrading to ProofExportV2.",
                    session_id, label
                );
            }
            travel_rule_fields.insert(
                label.clone(),
                TravelRuleFieldValue {
                    value: result.value.clone(),
                    commitment_index: result.commitment_index,
                },
            );
        }
    }
    SlimWebhookPayload {
        attestation_id: session_id.to_string(),
        policy_version,
        server_name: server_name.to_string(),
        travel_rule_fields,
        account_checks_all_passed,
        verifier_signature: verifier_signature.as_ref().map(|s| s.signature.clone()),
        verifier_address: verifier_signature.as_ref().map(|s| s.verifier_address.clone()),
        order_binding_hash,
        timestamp: current_timestamp_str(),
    }
}

/// Send slim webhook POST request with optional HMAC-SHA256 signature header.
async fn send_webhook(config: &WebhookConfig, payload: &SlimWebhookPayload, session_id: &str) {
    let client = reqwest::Client::new();
    let body = serde_json::to_string(payload).unwrap_or_default();

    let mut request = client
        .post(&config.url)
        .header("Content-Type", "application/json")
        .body(body.clone());

    // Add custom headers from config
    for (key, value) in &config.headers {
        request = request.header(key, value);
    }

    // Add HMAC signature header if secret is configured (R.11 security)
    if let Some(ref secret) = config.secret {
        let hmac_hex = compute_hmac_sha256(secret, &body);
        request = request.header("X-TLSN-Signature", format!("sha256={}", hmac_hex));
    }

    match request.send().await {
        Ok(response) => {
            if response.status().is_success() {
                info!(
                    "[{}] ✅ Webhook POST successful: {}",
                    session_id, config.url
                );
            } else {
                error!(
                    "[{}] ❌ Webhook POST failed with status {}: {}",
                    session_id,
                    response.status(),
                    config.url
                );
            }
        }
        Err(e) => {
            error!(
                "[{}] ❌ Webhook POST error: {} - {}",
                session_id, config.url, e
            );
        }
    }
}

/// Parse verifier private key from hex string into a secp256k1 signing key.
/// Accepts either 64-hex chars or 0x-prefixed 64-hex chars.
pub(crate) fn parse_verifier_private_key(raw: &str) -> Result<SigningKey, eyre::ErrReport> {
    let normalized = raw.trim();
    let hex_key = normalized
        .strip_prefix("0x")
        .or_else(|| normalized.strip_prefix("0X"))
        .unwrap_or(normalized);

    if hex_key.len() != 64 {
        return Err(eyre::eyre!(
            "VERIFIER_PRIVATE_KEY must be exactly 64 hex chars (32 bytes), got {}",
            hex_key.len()
        ));
    }

    if !hex_key.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(eyre::eyre!(
            "VERIFIER_PRIVATE_KEY contains non-hex characters"
        ));
    }

    let key_bytes = hex::decode(hex_key)
        .map_err(|e| eyre::eyre!("bad VERIFIER_PRIVATE_KEY hex: {}", e))?;
    SigningKey::from_slice(&key_bytes).map_err(|e| eyre::eyre!("invalid private key: {}", e))
}

/// Load verifier signing key from VERIFIER_PRIVATE_KEY and derive its Ethereum address.
pub(crate) fn load_verifier_signer_from_env() -> Result<(SigningKey, String), eyre::ErrReport> {
    let raw_key = std::env::var("VERIFIER_PRIVATE_KEY")
        .map_err(|_| eyre::eyre!("VERIFIER_PRIVATE_KEY is not set"))?;
    let signing_key = parse_verifier_private_key(&raw_key)?;
    let verifier_address = eth_address_from_signing_key(&signing_key);
    Ok((signing_key, verifier_address))
}

/// Derive an Ethereum address from a secp256k1 signing key.
/// Address = keccak256(uncompressed_pubkey[1..])[12..] (last 20 bytes), 0x-prefixed.
fn eth_address_from_signing_key(signing_key: &SigningKey) -> String {
    let verifying_key = signing_key.verifying_key();
    let point = verifying_key.to_encoded_point(false); // uncompressed, 65 bytes (04 || x || y)
    let pubkey_bytes = &point.as_bytes()[1..];          // drop 0x04 prefix → 64 bytes
    let hash: [u8; 32] = Keccak256::digest(pubkey_bytes).into();
    format!("0x{}", hex::encode(&hash[12..]))           // last 20 bytes = Ethereum address
}

/// Sign transcript commitments with EIP-191 personal_sign scheme.
///
/// commitmentsHash  = keccak256(hashHex[0] || hashHex[1] || ...)
/// policyVersionHash= keccak256(policyVersion as UTF-8), or [0u8;32] if None
/// messageHash      = keccak256(chainId_8bytes_be || keccak256(sessionId) || commitmentsHash
///                              || orderBindingHash || policyVersionHash)
///                    preimage: 8 + 32 + 32 + 32 + 32 = 136 bytes
/// ethSignedHash    = keccak256("\x19Ethereum Signed Message:\n32" || messageHash)
///
/// Returns a [`VerifierSignature`] containing all fields needed for on-chain verification.
pub(crate) fn sign_commitments(
    signing_key: &SigningKey,
    chain_id: u64,
    session_id: &str,
    transcript_commitments: &[TranscriptCommitmentSummary],
    order_binding_hash: Option<[u8; 32]>,
    policy_version: Option<&str>,
) -> Result<VerifierSignature, eyre::ErrReport> {
    // 1. commitmentsHash = keccak256(hashHex[0] || hashHex[1] || ...)
    let mut hasher = Keccak256::new();
    for commitment in transcript_commitments {
        if let Some(hash_hex) = &commitment.hash_hex {
            let bytes = hex::decode(hash_hex)
                .map_err(|e| eyre::eyre!("Invalid hashHex '{}': {}", hash_hex, e))?;
            hasher.update(&bytes);
        }
    }
    let commitments_hash: [u8; 32] = hasher.finalize().into();
    let commitments_hash_hex = hex::encode(commitments_hash);

    // 2. sessionIdHash = keccak256(sessionId as UTF-8) → fixed 32 bytes
    let session_id_hash: [u8; 32] = Keccak256::digest(session_id.as_bytes()).into();

    // 3. policyVersionHash = keccak256(policyVersion) or [0u8;32]
    let policy_version_hash: [u8; 32] = match policy_version {
        Some(pv) => Keccak256::digest(pv.as_bytes()).into(),
        None => [0u8; 32],
    };

    // 4. messageHash = keccak256(chainId(8) || sessionIdHash(32) || commitmentsHash(32)
    //                            || orderBindingHash(32) || policyVersionHash(32)) = 136 bytes
    let chain_id_bytes = chain_id.to_be_bytes();
    let binding_bytes = order_binding_hash.unwrap_or([0u8; 32]);
    let mut message_preimage = [0u8; 136];
    message_preimage[..8].copy_from_slice(&chain_id_bytes);
    message_preimage[8..40].copy_from_slice(&session_id_hash);
    message_preimage[40..72].copy_from_slice(&commitments_hash);
    message_preimage[72..104].copy_from_slice(&binding_bytes);
    message_preimage[104..136].copy_from_slice(&policy_version_hash);
    let message_hash: [u8; 32] = Keccak256::digest(&message_preimage).into();

    // 5. ethSignedHash = keccak256("\x19Ethereum Signed Message:\n32" || messageHash)
    let prefix = b"\x19Ethereum Signed Message:\n32";
    let mut eth_preimage = Vec::with_capacity(prefix.len() + 32);
    eth_preimage.extend_from_slice(prefix);
    eth_preimage.extend_from_slice(&message_hash);
    let eth_signed_hash: [u8; 32] = Keccak256::digest(&eth_preimage).into();

    // 6. secp256k1 ECDSA sign on prehash
    let (sig, recovery_id): (Signature, k256::ecdsa::RecoveryId) = signing_key
        .sign_prehash_recoverable(&eth_signed_hash)
        .map_err(|e| eyre::eyre!("ECDSA sign failed: {}", e))?;

    // 7. Pack 65-byte signature: r(32) || s(32) || v(1)
    //    Ethereum convention: v = recovery_id + 27 (i.e. 27 or 28)
    let sig_bytes = sig.to_bytes();
    let v = recovery_id.to_byte() + 27;
    let mut sig65 = Vec::with_capacity(65);
    sig65.extend_from_slice(&sig_bytes);
    sig65.push(v);

    Ok(VerifierSignature {
        chain_id,
        session_id: session_id.to_string(),
        commitments_hash: commitments_hash_hex,
        order_binding_hash: order_binding_hash.map(|b| format!("0x{}", hex::encode(b))),
        signature: hex::encode(&sig65),
        verifier_address: eth_address_from_signing_key(signing_key),
        policy_version: policy_version.map(|s| s.to_string()),
        policy_version_hash: format!("0x{}", hex::encode(policy_version_hash)),
    })
}
