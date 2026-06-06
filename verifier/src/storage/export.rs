//! Translate stored `ProofExportRecord` into the API-facing `ProofExportResponse`.
//!
//! Stage 1 — pure structural move from `main.rs`. No behavior changes.

use crate::storage::record::{ProofExportRecord, ProofExportResponse, RedactedTranscriptExport};
use tracing::warn;

/// Build travelRuleFields from handler_results: only entries with a "label" field.
pub(crate) fn build_travel_rule_fields_from_handler_results(
    handler_results: &serde_json::Value,
) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    if let Some(arr) = handler_results.as_array() {
        for item in arr {
            if let Some(label) = item.get("label").and_then(|v| v.as_str()) {
                if let (Some(value), Some(idx)) = (
                    item.get("value").and_then(|v| v.as_str()),
                    item.get("commitmentIndex").and_then(|v| v.as_u64()),
                ) {
                    if map.contains_key(label) {
                        warn!(
                            "Duplicate travel_rule label '{}' in handler_results — \
                             previous value will be overwritten.",
                            label
                        );
                    }
                    map.insert(
                        label.to_string(),
                        serde_json::json!({ "value": value, "commitmentIndex": idx }),
                    );
                }
            }
        }
    }
    serde_json::Value::Object(map)
}

/// Build a ProofExportResponse from a stored record.
pub(crate) fn record_to_response(r: ProofExportRecord) -> ProofExportResponse {
    // 1. handler_results (raw, kept as optional debug field)
    let handler_results_val: serde_json::Value =
        serde_json::from_str(&r.handler_results).unwrap_or(serde_json::Value::Array(vec![]));

    // 2. travelRuleFields derived from handler_results
    let travel_rule_fields = build_travel_rule_fields_from_handler_results(&handler_results_val);

    // 3. account_checks
    let account_checks: serde_json::Value = r
        .account_checks
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(serde_json::Value::Array(vec![]));

    // 4. transcript_commitments
    let transcript_commitments: serde_json::Value = r
        .transcript_commitments
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(serde_json::Value::Array(vec![]));

    // 5. session_data (optional debug)
    let session_data_val: serde_json::Value = r
        .session_data
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));

    // 6. redacted_transcript
    let redacted_transcript = match (r.redacted_sent, r.redacted_recv) {
        (Some(sent), Some(recv)) => Some(RedactedTranscriptExport { sent, recv }),
        _ => None,
    };

    ProofExportResponse {
        format_version: "ProofExportV1",
        attestation_id: r.session_id,
        tx_hash: r.tx_hash,
        policy_version: r.policy_version.unwrap_or_else(|| "unspecified".to_string()),
        timestamp: r.recorded_at,
        server_name: r.server_name,
        verifier_version: env!("CARGO_PKG_VERSION"),
        order_binding_hash: r.order_binding_hash,
        commitments_hash: r.commitments_hash,
        verifier_signature: r.verifier_signature.unwrap_or_default(),
        verifier_address: r.verifier_address.unwrap_or_default(),
        chain_id: r.signing_chain_id,
        travel_rule_fields,
        account_checks,
        transcript_commitments,
        redacted_transcript,
        handler_results: Some(handler_results_val),
        session_data: Some(session_data_val),
    }
}
