//! Proof-store HTTP handlers: GET /proof/:id, PATCH /proof/:id/tx, GET /proof?txHash=.
//!
//! Stage 1 — pure structural move from `main.rs`. No behavior changes.

use crate::auth::api_key::{check_proof_api_key, resolve_principal, Principal};
use crate::storage::export::record_to_response;
use crate::storage::record::{GetProofByTxQuery, ListQuery, PatchTxBody};
use crate::storage::repo::{
    get_proof_by_session_id, get_proof_by_tx_hash, list_proofs, promote_to_committed,
    PromoteOutcome, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT,
};
use crate::{is_valid_tx_hash, AppState};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use std::sync::Arc;
use tracing::{error, info, warn};

/// Mode of access being authorized — read vs write — needed because a User can
/// READ records where they're owner OR counterparty, but can only WRITE (PATCH)
/// records where they're owner (§6.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AccessMode {
    Read,
    Write,
}

/// §6.4 row-level filter applied after loading a record. Returns 403 if the
/// Principal isn't allowed to see/touch this row.
///
/// `Anonymous` here only ever appears in dev mode (no auth configured) — in
/// that case the handler's pre-check (`check_proof_api_key`) already let the
/// request through, so we mirror that by allowing.
fn enforce_record_ownership(
    principal: &Principal,
    record_tenant: Option<&str>,
    record_owner: Option<&str>,
    record_counterparty: Option<&str>,
    mode: AccessMode,
) -> Result<(), StatusCode> {
    match principal {
        Principal::SuperAdmin => Ok(()),
        Principal::Anonymous => Ok(()), // dev-mode passthrough
        Principal::Tenant { tenant_id } => {
            if record_tenant == Some(tenant_id.as_str()) {
                Ok(())
            } else {
                Err(StatusCode::FORBIDDEN)
            }
        }
        Principal::User { address } => {
            let addr = address.as_str();
            let allowed = match mode {
                // Read: owner OR counterparty can see the proof.
                AccessMode::Read => {
                    record_owner == Some(addr) || record_counterparty == Some(addr)
                }
                // Write (PATCH /tx): only the owner can record the on-chain tx hash.
                AccessMode::Write => record_owner == Some(addr),
            };
            if allowed {
                Ok(())
            } else {
                Err(StatusCode::FORBIDDEN)
            }
        }
    }
}

/// GET /proof/:session_id — retrieve full proof by session ID
pub(crate) async fn get_proof_handler(
    headers: axum::http::HeaderMap,
    Path(session_id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> axum::response::Response {
    if let Err(status) = check_proof_api_key(&headers, &state) {
        return status.into_response();
    }
    let principal = resolve_principal(
        &headers,
        &state.proof_api_keys,
        state.jwt_secret.as_deref(),
    );
    let session_id_for_log = session_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        let conn = state.db.lock().unwrap();
        get_proof_by_session_id(&conn, &session_id)
    })
    .await
    .unwrap_or(None);

    let Some(record) = result else {
        return (StatusCode::NOT_FOUND, "Proof not found").into_response();
    };
    if let Err(status) = enforce_record_ownership(
        &principal,
        record.tenant_id.as_deref(),
        record.owner_address.as_deref(),
        record.counterparty_address.as_deref(),
        AccessMode::Read,
    ) {
        return status.into_response();
    }
    info!(session_id = %session_id_for_log, action = "proof_read", "Proof accessed");
    (StatusCode::OK, Json(record_to_response(record))).into_response()
}

/// PATCH /proof/:session_id/tx — write on-chain tx hash after confirmation
pub(crate) async fn patch_proof_tx_handler(
    headers: axum::http::HeaderMap,
    Path(session_id): Path<String>,
    State(state): State<Arc<AppState>>,
    Json(body): Json<PatchTxBody>,
) -> axum::response::Response {
    if let Err(status) = check_proof_api_key(&headers, &state) {
        return status.into_response();
    }
    if !is_valid_tx_hash(&body.tx_hash) {
        return (StatusCode::BAD_REQUEST, "Invalid tx_hash format: must be 0x<1-64 hex chars>")
            .into_response();
    }
    if let Some(cid) = body.chain_id {
        if cid <= 0 {
            return (StatusCode::BAD_REQUEST, "Invalid chain_id: must be positive").into_response();
        }
    }
    let principal = resolve_principal(
        &headers,
        &state.proof_api_keys,
        state.jwt_secret.as_deref(),
    );

    let tx_hash_for_log = body.tx_hash.clone();
    let session_id_for_log = session_id.clone();

    // Load the existing record first so we can enforce row-level ownership
    // (§6.4: Tenant → tenant_id=t; User → owner=address, NOT counterparty).
    let db_clone = state.db.clone();
    let sid_for_lookup = session_id.clone();
    let existing = tokio::task::spawn_blocking(move || {
        let conn = db_clone.lock().unwrap();
        get_proof_by_session_id(&conn, &sid_for_lookup)
    })
    .await
    .unwrap_or(None);

    let Some(existing_record) = existing else {
        return (StatusCode::NOT_FOUND, "Proof not found").into_response();
    };
    if let Err(status) = enforce_record_ownership(
        &principal,
        existing_record.tenant_id.as_deref(),
        existing_record.owner_address.as_deref(),
        existing_record.counterparty_address.as_deref(),
        AccessMode::Write,
    ) {
        return status.into_response();
    }

    let result = tokio::task::spawn_blocking(move || {
        let conn = state.db.lock().unwrap();
        promote_to_committed(&conn, &session_id, &body.tx_hash, body.chain_id)
    })
    .await;

    match result {
        Ok(Ok(PromoteOutcome::Updated)) => {
            info!(
                session_id = %session_id_for_log,
                tx_hash = %tx_hash_for_log,
                action = "tx_hash_written",
                "tx_hash recorded, status promoted to committed"
            );
            StatusCode::OK.into_response()
        }
        Ok(Ok(PromoteOutcome::AlreadySet)) => {
            warn!("[{}] Attempted overwrite of tx_hash rejected (409)", session_id_for_log);
            (
                StatusCode::CONFLICT,
                "tx_hash already set for this session — overwrite not allowed",
            )
                .into_response()
        }
        Ok(Ok(PromoteOutcome::NotFound)) => {
            (StatusCode::NOT_FOUND, "Proof not found").into_response()
        }
        Ok(Err(e)) => {
            error!("promote_to_committed DB error: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(e) => {
            error!("promote_to_committed spawn error: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// GET /proof?txHash=xxx — reverse lookup by on-chain tx hash
pub(crate) async fn get_proof_by_tx_handler(
    headers: axum::http::HeaderMap,
    Query(params): Query<GetProofByTxQuery>,
    State(state): State<Arc<AppState>>,
) -> axum::response::Response {
    if let Err(status) = check_proof_api_key(&headers, &state) {
        return status.into_response();
    }
    if !is_valid_tx_hash(&params.tx_hash) {
        return (StatusCode::BAD_REQUEST, "Invalid txHash query parameter").into_response();
    }
    let principal = resolve_principal(
        &headers,
        &state.proof_api_keys,
        state.jwt_secret.as_deref(),
    );
    let tx_hash_for_log = params.tx_hash.clone();
    let result = tokio::task::spawn_blocking(move || {
        let conn = state.db.lock().unwrap();
        get_proof_by_tx_hash(&conn, &params.tx_hash)
    })
    .await
    .unwrap_or(None);

    let Some(record) = result else {
        return (StatusCode::NOT_FOUND, "Proof not found").into_response();
    };
    if let Err(status) = enforce_record_ownership(
        &principal,
        record.tenant_id.as_deref(),
        record.owner_address.as_deref(),
        record.counterparty_address.as_deref(),
        AccessMode::Read,
    ) {
        return status.into_response();
    }
    info!(tx_hash = %tx_hash_for_log, action = "proof_read_by_tx", "Proof accessed by tx_hash");
    (StatusCode::OK, Json(record_to_response(record))).into_response()
}

/// Query params for GET /proofs (COMPLIANCE_STORAGE_PLAN §5.3).
#[derive(Debug, Deserialize, Default)]
pub(crate) struct ListProofsParams {
    /// Caller-supplied owner filter (lowercased on the wire). Honored for SuperAdmin only.
    pub(crate) owner: Option<String>,
    /// Caller-supplied tenant filter. Honored for SuperAdmin only; ignored / overridden
    /// for Tenant principals (their scope is always their own tenant).
    pub(crate) tenant: Option<String>,
    pub(crate) status: Option<String>,
    pub(crate) from: Option<String>,
    pub(crate) to: Option<String>,
    pub(crate) limit: Option<u32>,
    pub(crate) cursor: Option<String>,
}

/// GET /proofs — paginated list with forced tenant/owner filter by Principal.
///
/// Auth (§6.4 row for /proofs):
///   - SuperAdmin       → may specify owner/tenant filters freely.
///   - Tenant(t)        → tenant filter is locked to `t` (any caller-supplied tenant is overridden).
///   - Anonymous        → 401 (§5.3: no dev-passthrough, to prevent full data egress).
///   - User(address)    → stage 6 (SIWE).
pub(crate) async fn list_proofs_handler(
    headers: axum::http::HeaderMap,
    Query(params): Query<ListProofsParams>,
    State(state): State<Arc<AppState>>,
) -> axum::response::Response {
    let principal = resolve_principal(
        &headers,
        &state.proof_api_keys,
        state.jwt_secret.as_deref(),
    );
    let (tenant_filter, owner_filter) = match principal {
        Principal::SuperAdmin => (params.tenant.clone(), params.owner.clone()),
        Principal::Tenant { tenant_id } => {
            // Tenant: lock tenant=t. Owner may still be supplied to narrow inside the tenant.
            (Some(tenant_id), params.owner.clone())
        }
        Principal::User { address } => {
            // User (SIWE): force owner=address; ignore any caller-supplied owner override.
            // Tenant from query is honored (lets a user narrow to a specific platform).
            (params.tenant.clone(), Some(address))
        }
        Principal::Anonymous => {
            // §5.3 explicit: /proofs always requires credentials, even in dev mode,
            // so an unconfigured server can't accidentally expose the whole proof_store.
            return (
                StatusCode::UNAUTHORIZED,
                "Missing or unknown API key — /proofs requires authentication",
            )
                .into_response();
        }
    };

    let q = ListQuery {
        tenant_id: tenant_filter,
        owner_address: owner_filter,
        status: params.status,
        from: params.from,
        to: params.to,
        limit: params.limit.unwrap_or(DEFAULT_LIST_LIMIT).min(MAX_LIST_LIMIT),
        cursor: params.cursor,
    };

    let result = tokio::task::spawn_blocking(move || {
        let conn = state.db.lock().unwrap();
        list_proofs(&conn, &q)
    })
    .await;

    match result {
        Ok(Ok(page)) => {
            info!(
                action = "proofs_list",
                items = page.items.len(),
                "GET /proofs"
            );
            (StatusCode::OK, Json(page)).into_response()
        }
        Ok(Err(e)) => {
            error!("list_proofs DB error: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(e) => {
            error!("list_proofs spawn error: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}
