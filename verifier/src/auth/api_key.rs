//! Proof-store API key check (tenant-scoped keys, COMPLIANCE_STORAGE_PLAN §6.2).
//!
//! Backwards compatibility: a legacy single `PROOF_API_KEY=foo` becomes a single
//! SuperAdmin entry — behavior identical to pre-stage-5.

use crate::AppState;
use axum::http::StatusCode;
use std::collections::HashMap;
use std::sync::Arc;

/// Scope of a proof API key. `tenant_id: None` ⇒ SuperAdmin (sees everything).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct KeyScope {
    pub(crate) tenant_id: Option<String>,
}

/// Resolved caller identity after parsing the request's auth header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Principal {
    SuperAdmin,
    Tenant { tenant_id: String },
    /// Stage 6: end-user authenticated via SIWE + JWT. Address is lowercase 0x...,
    /// matching the normalization used by `parse_owner_address` (§4.1).
    User { address: String },
    Anonymous,
}

/// Pure parser for `PROOF_API_KEYS` — extracted so unit tests don't need to
/// mutate process environment.
///
/// Format: `"k1:tenantA, k2:tenantB, super:*"`. Empty/None input → empty map
/// (the dev-passthrough signal for single-record endpoints).
pub(crate) fn parse_proof_api_keys(keys_env: Option<&str>) -> HashMap<String, KeyScope> {
    let mut map = HashMap::new();
    if let Some(raw) = keys_env {
        for piece in raw.split(',') {
            let piece = piece.trim();
            if piece.is_empty() {
                continue;
            }
            match piece.split_once(':') {
                Some((k, scope)) => {
                    let k = k.trim();
                    let scope = scope.trim();
                    if k.is_empty() {
                        continue;
                    }
                    let key_scope = if scope == "*" || scope.is_empty() {
                        KeyScope { tenant_id: None }
                    } else {
                        KeyScope {
                            tenant_id: Some(scope.to_string()),
                        }
                    };
                    map.insert(k.to_string(), key_scope);
                }
                None => {
                    // No ':' separator — treat the whole piece as a SuperAdmin key.
                    map.insert(piece.to_string(), KeyScope { tenant_id: None });
                }
            }
        }
    }
    map
}

/// Read `PROOF_API_KEYS` from the environment and parse it.
pub(crate) fn load_proof_api_keys_from_env() -> HashMap<String, KeyScope> {
    parse_proof_api_keys(std::env::var("PROOF_API_KEYS").ok().as_deref())
}

/// Extract a Bearer token from the `Authorization` header. Returns the trimmed
/// token (without the "Bearer " prefix) or None.
fn extract_bearer(headers: &axum::http::HeaderMap) -> Option<String> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer ").or_else(|| s.strip_prefix("bearer ")))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Extract an API key from `X-TLSN-Api-Key` or `Authorization: Bearer <k>`.
/// Returns the trimmed key or None.
fn extract_provided_key(headers: &axum::http::HeaderMap) -> Option<String> {
    if let Some(v) = headers.get("X-TLSN-Api-Key").and_then(|v| v.to_str().ok()) {
        let v = v.trim();
        if !v.is_empty() {
            return Some(v.to_string());
        }
    }
    extract_bearer(headers)
}

/// Resolve the caller's Principal.
///
/// Priority:
///   1. `Authorization: Bearer <jwt>`  → if `jwt_secret` is Some and the token
///      decodes + validates, returns `User { address }`. (Stage 6.)
///   2. `X-TLSN-Api-Key` / `Authorization: Bearer <key>` → SuperAdmin or Tenant.
///   3. Otherwise → Anonymous.
///
/// Unknown JWTs that fail to decode fall through to the API-key branch — this
/// keeps an existing API-key client working even after SIWE is enabled (the same
/// Bearer header field is reused). Unknown API keys → Anonymous (never escalates).
pub(crate) fn resolve_principal(
    headers: &axum::http::HeaderMap,
    keys: &HashMap<String, KeyScope>,
    jwt_secret: Option<&str>,
) -> Principal {
    if let Some(secret) = jwt_secret {
        if let Some(bearer) = extract_bearer(headers) {
            if let Some(address) = super::siwe::verify_token(&bearer, secret) {
                return Principal::User { address };
            }
        }
    }
    let Some(provided) = extract_provided_key(headers) else {
        return Principal::Anonymous;
    };
    match keys.get(&provided) {
        Some(KeyScope { tenant_id: None }) => Principal::SuperAdmin,
        Some(KeyScope {
            tenant_id: Some(t),
        }) => Principal::Tenant {
            tenant_id: t.clone(),
        },
        None => Principal::Anonymous,
    }
}

/// Single-record endpoints' check (GET /proof/:id, PATCH /proof/:id/tx,
/// GET /proof?txHash=). Behavior:
///   - no auth configured at all     → dev mode, allow all (Ok)
///   - any auth configured + Anon    → 401
///   - SuperAdmin / Tenant / User    → Ok (row-level ownership filter applied
///     by the handler against the loaded record)
pub(crate) fn check_proof_api_key(
    headers: &axum::http::HeaderMap,
    state: &Arc<AppState>,
) -> Result<(), StatusCode> {
    if state.proof_api_keys.is_empty() && state.jwt_secret.is_none() {
        return Ok(()); // dev mode
    }
    match resolve_principal(headers, &state.proof_api_keys, state.jwt_secret.as_deref()) {
        Principal::Anonymous => Err(StatusCode::UNAUTHORIZED),
        _ => Ok(()),
    }
}
