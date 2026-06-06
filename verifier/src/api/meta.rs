//! Meta endpoints: GET /health, GET /info.
//!
//! Stage 1 — pure structural move from `main.rs`. No behavior changes.

use axum::response::IntoResponse;
use serde::Serialize;

/// Health check endpoint handler
pub(crate) async fn health_handler() -> impl IntoResponse {
    "ok"
}

/// Info response structure
#[derive(Debug, Serialize)]
struct InfoResponse {
    /// Package version from Cargo.toml
    version: &'static str,
    /// Git commit hash (from GIT_HASH env var, set by CI)
    git_hash: String,
    /// TLSNotary library version
    tlsn_version: &'static str,
}

/// Info endpoint handler - returns server information as JSON
pub(crate) async fn info_handler() -> impl IntoResponse {
    let git_hash = std::env::var("GIT_HASH").unwrap_or_else(|_| "dev".to_string());

    axum::Json(InfoResponse {
        version: env!("CARGO_PKG_VERSION"),
        git_hash,
        tlsn_version: "0.1.0-alpha.14",
    })
}
