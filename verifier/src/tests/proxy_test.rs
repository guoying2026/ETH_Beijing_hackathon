//! Tests for the real /proxy WebSocket endpoint.
//!
//! Unlike the external `tests/proxy_test.rs` (which tests a generic WS-to-TCP
//! forwarding helper), these tests exercise the actual `proxy_ws_handler` and
//! `handle_proxy_connection` functions from `main.rs` by starting a real verifier
//! server and connecting to its `/proxy` route.
//!
//! Covered scenarios:
//!  1. `?token=<host>:<port>` routes binary WS frames to the target TCP host
//!  2. Legacy `?host=<host>:<port>` is treated identically to `?token=`
//!  3. A client IP already at the rate limit receives HTTP 429 before WS upgrade

#[cfg(test)]
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use async_tungstenite::tungstenite::Message;
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio_util::compat::TokioAsyncReadCompatExt;
use tower_http::cors::CorsLayer;
use tracing::info;

// Ports are offset from the integration_test.rs range (which tops at +9 = 17056)
// to avoid bind conflicts when tests run in parallel.
const PROXY_VERIFIER_PORT_TOKEN: u16 = 17060;
const PROXY_VERIFIER_PORT_HOST: u16 = 17061;
const PROXY_VERIFIER_PORT_RATE: u16 = 17062;

// ============================================================================
// Helpers
// ============================================================================

/// Binds a TCP echo server on an ephemeral port and returns the bound port.
/// Any bytes received on a connection are immediately written back.
async fn start_echo_server() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    tokio::spawn(async move {
        loop {
            if let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    loop {
                        match socket.read(&mut buf).await {
                            Ok(0) => break,
                            Ok(n) => {
                                if socket.write_all(&buf[..n]).await.is_err() {
                                    break;
                                }
                            }
                            Err(_) => break,
                        }
                    }
                });
            }
        }
    });

    tokio::time::sleep(Duration::from_millis(20)).await;
    port
}

/// Spin up the real verifier server exposing only the `/proxy` route.
///
/// `rate_limiter` allows tests to pre-fill the per-IP counter so that
/// `check_ws_rate_limit` rejects the very next connection from 127.0.0.1.
async fn start_proxy_test_verifier(
    verifier_port: u16,
    rate_limiter: Option<
        Arc<std::sync::Mutex<HashMap<std::net::IpAddr, (u32, std::time::Instant)>>>,
    >,
) -> tokio::task::JoinHandle<()> {
    let config: crate::Config = serde_yaml::from_str("webhooks: {}").unwrap();

    let conn = crate::init_db(":memory:");
    let db = Arc::new(std::sync::Mutex::new(conn));

    let ws_rate_limiter =
        rate_limiter.unwrap_or_else(|| Arc::new(std::sync::Mutex::new(HashMap::new())));

    let app_state = Arc::new(crate::AppState {
        sessions: Arc::new(Mutex::new(HashMap::new())),
        config: Arc::new(config),
        db,
        proof_api_keys: HashMap::new(),
        jwt_secret: None,
        siwe_domain: None,
        siwe_nonces: Arc::new(std::sync::Mutex::new(HashMap::new())),
        ws_rate_limiter,
    });

    let app = axum::Router::new()
        .route("/health", axum::routing::get(|| async { "ok" }))
        .route("/proxy", axum::routing::get(crate::proxy_ws_handler))
        .layer(CorsLayer::permissive())
        .with_state(app_state);

    let addr = SocketAddr::from(([127, 0, 0, 1], verifier_port));

    tokio::spawn(async move {
        let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
        info!("[proxy_test] verifier listening on {}", addr);
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    })
}

/// Open a plain WebSocket connection to `url`.
async fn connect_ws_plain(
    url: &str,
) -> Result<
    async_tungstenite::WebSocketStream<tokio_util::compat::Compat<TcpStream>>,
    Box<dyn std::error::Error + Send + Sync>,
> {
    let parsed = url.parse::<http::Uri>()?;
    let host = parsed.host().ok_or("no host in url")?;
    let port = parsed.port_u16().unwrap_or(80);
    let tcp = TcpStream::connect((host, port)).await?;
    let (ws, _) = async_tungstenite::client_async(url, tcp.compat()).await?;
    Ok(ws)
}

// ============================================================================
// Tests
// ============================================================================

/// Verifies that `/proxy?token=<host>:<port>` (the canonical parameter form)
/// forwards client binary frames to the target TCP host and relays the TCP
/// echo back as binary frames.
///
/// This exercises `proxy_ws_handler` → `handle_proxy_connection` in main.rs,
/// including the `?token=` query-parameter parsing path.
#[tokio::test]
async fn test_proxy_token_param_routes_to_tcp() {
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .try_init();

    let echo_port = start_echo_server().await;
    let verifier_handle = start_proxy_test_verifier(PROXY_VERIFIER_PORT_TOKEN, None).await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    let url = format!(
        "ws://127.0.0.1:{}/proxy?token=127.0.0.1:{}",
        PROXY_VERIFIER_PORT_TOKEN, echo_port
    );
    let ws = connect_ws_plain(&url)
        .await
        .expect("WS connection to /proxy?token= must succeed");

    let (mut sink, mut stream) = ws.split();

    let payload = b"hello-proxy-token-test";
    sink.send(Message::Binary(payload.to_vec())).await.unwrap();

    let response = tokio::time::timeout(Duration::from_secs(5), stream.next())
        .await
        .expect("timed out waiting for TCP echo")
        .expect("WS stream ended prematurely")
        .expect("WS error on receive");

    assert_eq!(
        response,
        Message::Binary(payload.to_vec()),
        "?token= path must relay TCP echo back as an identical binary frame"
    );

    verifier_handle.abort();
}

/// Verifies that the legacy `?host=<host>:<port>` parameter is treated
/// identically to `?token=` by the `ProxyQuery` serde alias.
#[tokio::test]
async fn test_proxy_host_param_legacy_routes_to_tcp() {
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .try_init();

    let echo_port = start_echo_server().await;
    let verifier_handle = start_proxy_test_verifier(PROXY_VERIFIER_PORT_HOST, None).await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    let url = format!(
        "ws://127.0.0.1:{}/proxy?host=127.0.0.1:{}",
        PROXY_VERIFIER_PORT_HOST, echo_port
    );
    let ws = connect_ws_plain(&url)
        .await
        .expect("WS connection to /proxy?host= (legacy) must succeed");

    let (mut sink, mut stream) = ws.split();

    let payload = b"hello-proxy-legacy-host-test";
    sink.send(Message::Binary(payload.to_vec())).await.unwrap();

    let response = tokio::time::timeout(Duration::from_secs(5), stream.next())
        .await
        .expect("timed out waiting for TCP echo")
        .expect("WS stream ended prematurely")
        .expect("WS error on receive");

    assert_eq!(
        response,
        Message::Binary(payload.to_vec()),
        "legacy ?host= parameter must produce the same behaviour as ?token="
    );

    verifier_handle.abort();
}

/// Verifies that `check_ws_rate_limit` causes the server to return HTTP 429
/// before completing the WebSocket upgrade when the client IP has exhausted
/// its connection quota for the current 60-second window.
///
/// The in-memory rate limiter is pre-filled with 127.0.0.1 at the effective
/// limit, so the very next connection attempt must be rejected.
#[tokio::test]
async fn test_proxy_rate_limit_returns_429() {
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .try_init();

    // Mirror the limit logic from check_ws_rate_limit in main.rs
    let limit: u32 = std::env::var("WS_RATE_LIMIT_PER_IP")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(10);

    // Pre-fill 127.0.0.1 as having already consumed all slots in the current window.
    // Instant::now() as window_start ensures the 60-second window has not expired.
    let mut m: HashMap<std::net::IpAddr, (u32, std::time::Instant)> = HashMap::new();
    m.insert(
        std::net::IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1)),
        (limit, std::time::Instant::now()),
    );
    let rate_limiter = Arc::new(std::sync::Mutex::new(m));

    let verifier_handle = start_proxy_test_verifier(PROXY_VERIFIER_PORT_RATE, Some(rate_limiter)).await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Attempt WS upgrade — the server must reject with HTTP 429 before the upgrade
    // completes, causing async_tungstenite to return an error.
    let url = format!(
        "ws://127.0.0.1:{}/proxy?token=127.0.0.1:1",
        PROXY_VERIFIER_PORT_RATE
    );
    let tcp = TcpStream::connect(format!("127.0.0.1:{}", PROXY_VERIFIER_PORT_RATE))
        .await
        .expect("TCP connect to verifier must succeed");
    let result = async_tungstenite::client_async(&url, tcp.compat()).await;

    assert!(
        result.is_err(),
        "WS upgrade must fail when the client IP is at the rate limit"
    );
    let err_str = result.unwrap_err().to_string();
    assert!(
        err_str.contains("429") || err_str.to_lowercase().contains("too many"),
        "error must indicate HTTP 429 Too Many Requests, got: {}",
        err_str
    );

    verifier_handle.abort();
}
