//! Proof store data types (R.11 retention).
//!
//! Stage 1 — pure structural move from `main.rs`. No behavior changes.
//! Fields promoted to `pub(crate)` so peer modules (repo, export) can read them.

use serde::{Deserialize, Serialize};

/// Internal record stored in SQLite for R.11 retrieval
#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct ProofExportRecord {
    pub(crate) session_id: String,
    pub(crate) server_name: String,
    pub(crate) policy_version: Option<String>,
    pub(crate) order_binding_hash: Option<String>,
    pub(crate) commitments_hash: String,
    pub(crate) verifier_signature: Option<String>,
    pub(crate) verifier_address: Option<String>,
    pub(crate) handler_results: String,   // JSON
    pub(crate) account_checks: Option<String>, // JSON
    pub(crate) redacted_sent: Option<String>,
    pub(crate) redacted_recv: Option<String>,
    pub(crate) session_data: Option<String>, // JSON
    pub(crate) tx_hash: Option<String>,
    pub(crate) recorded_at: String,
    pub(crate) retain_until: String,
    pub(crate) transcript_commitments: Option<String>, // JSON of Vec<TranscriptCommitmentSummary>
    pub(crate) signing_chain_id: Option<i64>,          // chain_id locked into verifier ECDSA signature
    // ↓ Stage 2 additions (COMPLIANCE_STORAGE_PLAN §3). Defaulted at DB level; see repo.rs.
    #[serde(default = "default_status")]
    pub(crate) status: String, // "provisional" | "committed"
    #[serde(default = "default_retention_class")]
    pub(crate) retention_class: String, // "compliance" | "ephemeral"
    #[serde(default)]
    pub(crate) owner_address: Option<String>,
    #[serde(default)]
    pub(crate) counterparty_address: Option<String>,
    #[serde(default)]
    pub(crate) tenant_id: Option<String>,
    #[serde(default)]
    pub(crate) committed_at: Option<String>,
}

fn default_status() -> String {
    "provisional".to_string()
}

fn default_retention_class() -> String {
    "ephemeral".to_string()
}

/// Body for PATCH /proof/:session_id/tx
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PatchTxBody {
    pub(crate) tx_hash: String,
    pub(crate) chain_id: Option<i64>,
}

/// Query params for GET /proof?txHash=
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GetProofByTxQuery {
    pub(crate) tx_hash: String,
}

/// Response body for GET /proof/{id} — aligned to ProofExportV1 contract in types.ts
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProofExportResponse {
    pub(crate) format_version: &'static str,              // "ProofExportV1"
    pub(crate) attestation_id: String,
    pub(crate) tx_hash: Option<String>,
    pub(crate) policy_version: String,
    pub(crate) timestamp: String,                         // RFC3339 UTC
    pub(crate) server_name: String,
    pub(crate) verifier_version: &'static str,
    pub(crate) order_binding_hash: Option<String>,
    pub(crate) commitments_hash: String,
    pub(crate) verifier_signature: String,                // empty string when no signing key
    pub(crate) verifier_address: String,                  // empty string when no signing key
    pub(crate) chain_id: Option<i64>,                     // signing_chain_id from ECDSA signature
    pub(crate) travel_rule_fields: serde_json::Value,     // {label: {value, commitmentIndex}}
    pub(crate) account_checks: serde_json::Value,         // JSON array of AccountCheckResult
    pub(crate) transcript_commitments: serde_json::Value, // JSON array of TranscriptCommitmentSummary
    pub(crate) redacted_transcript: Option<RedactedTranscriptExport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) handler_results: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) session_data: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
pub(crate) struct RedactedTranscriptExport {
    pub(crate) sent: String,
    pub(crate) recv: String,
}

/// Query input for GET /proofs (COMPLIANCE_STORAGE_PLAN §5.3).
///
/// Auth layer is responsible for INJECTING the tenant_id / owner_address filters
/// based on the caller's Principal (Tenant locks tenant; User locks owner); the
/// storage layer just executes whatever is set here.
#[derive(Debug, Default, Clone)]
pub(crate) struct ListQuery {
    pub(crate) tenant_id: Option<String>,
    pub(crate) owner_address: Option<String>,
    pub(crate) status: Option<String>,
    pub(crate) from: Option<String>,           // recorded_at >= from (RFC3339)
    pub(crate) to: Option<String>,             // recorded_at <  to   (RFC3339)
    pub(crate) limit: u32,                     // capped to 200
    pub(crate) cursor: Option<String>,         // recorded_at|session_id from prior page
}

/// One row in the `GET /proofs` response — deliberately slim (no redacted_transcript).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListItem {
    pub(crate) attestation_id: String,
    pub(crate) status: String,
    pub(crate) retention_class: String,
    pub(crate) owner_address: Option<String>,
    pub(crate) tenant_id: Option<String>,
    pub(crate) server_name: String,
    pub(crate) tx_hash: Option<String>,
    pub(crate) timestamp: String,              // recorded_at
    pub(crate) committed_at: Option<String>,
    pub(crate) travel_rule_fields: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListPage {
    pub(crate) items: Vec<ListItem>,
    pub(crate) next_cursor: Option<String>,
}
