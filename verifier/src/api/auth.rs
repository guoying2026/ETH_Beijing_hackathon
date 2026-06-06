//! /auth/* endpoints — SIWE nonce + verification (COMPLIANCE_STORAGE_PLAN §5.5, §5.6).
//!
//! Only mounted when SIWE is configured (SIWE_JWT_SECRET + SIWE_DOMAIN set).

use crate::auth::siwe::{issue_nonce, mint_token, nonce_ttl_secs, verify_siwe};
use crate::AppState;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{info, warn};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NonceResponse {
    pub(crate) nonce: String,
    pub(crate) expires_at: u64, // unix seconds
}

#[derive(Debug, Deserialize)]
pub(crate) struct VerifyBody {
    pub(crate) message: String,
    pub(crate) signature: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VerifyResponse {
    pub(crate) token: String,
    pub(crate) address: String,
    pub(crate) expires_at: u64,
}

/// GET /auth/nonce — issue a one-shot nonce for the client to embed in its
/// SIWE message. Nonce is single-use (consumed on /auth/verify) and short-TTL.
pub(crate) async fn nonce_handler(
    State(state): State<Arc<AppState>>,
) -> axum::response::Response {
    let nonce = issue_nonce(&state.siwe_nonces);
    let expires_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() + nonce_ttl_secs())
        .unwrap_or(0);
    (
        StatusCode::OK,
        Json(NonceResponse { nonce, expires_at }),
    )
        .into_response()
}

/// POST /auth/verify — verify the EIP-4361 message + signature, consume the
/// nonce, and mint a JWT for the recovered address.
pub(crate) async fn verify_handler(
    State(state): State<Arc<AppState>>,
    Json(body): Json<VerifyBody>,
) -> axum::response::Response {
    let Some(secret) = state.jwt_secret.as_deref() else {
        // Defensive — handler wouldn't have been mounted, but check anyway.
        return (StatusCode::SERVICE_UNAVAILABLE, "SIWE not configured").into_response();
    };
    let Some(domain) = state.siwe_domain.as_deref() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "SIWE not configured").into_response();
    };

    let result = verify_siwe(&body.message, &body.signature, &state.siwe_nonces, domain).await;
    match result {
        Ok(address) => match mint_token(&address, secret) {
            Ok((token, expires_at)) => {
                info!(address = %address, action = "siwe_verify", "SIWE login");
                (
                    StatusCode::OK,
                    Json(VerifyResponse {
                        token,
                        address,
                        expires_at,
                    }),
                )
                    .into_response()
            }
            Err(e) => {
                warn!("JWT mint failed: {}", e);
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        },
        Err(e) => {
            warn!("SIWE verify failed: {}", e);
            (StatusCode::UNAUTHORIZED, e.to_string()).into_response()
        }
    }
}
