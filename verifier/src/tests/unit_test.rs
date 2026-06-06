use crate::{
    build_slim_webhook_payload, compute_hmac_sha256, current_timestamp_str, format_rfc3339,
    get_proof_by_session_id, get_proof_by_tx_hash, init_db, insert_proof_record,
    load_verifier_signer_from_env, parse_verifier_private_key, promote_to_committed,
    purge_expired_ephemeral, record_to_response, retain_until_str, Handler, HandlerPart,
    HandlerResult, HandlerType, ProofExportRecord, PromoteOutcome, VerifierSignature,
};
use std::sync::{Mutex, OnceLock};

// ============================================================================
// HMAC-SHA256 tests (R.11 webhook security)
// ============================================================================

#[test]
fn test_hmac_sha256_deterministic() {
    let secret = "my-secret-key";
    let body = r#"{"attestationId":"test-123"}"#;
    let hex1 = compute_hmac_sha256(secret, body);
    let hex2 = compute_hmac_sha256(secret, body);
    assert_eq!(hex1, hex2, "HMAC must be deterministic");
    assert_eq!(hex1.len(), 64, "HMAC-SHA256 hex should be 64 characters");
    // Only lowercase hex chars
    assert!(hex1.chars().all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));
}

#[test]
fn test_hmac_sha256_different_secrets_produce_different_macs() {
    let body = r#"{"attestationId":"test-123"}"#;
    let hex1 = compute_hmac_sha256("secret-a", body);
    let hex2 = compute_hmac_sha256("secret-b", body);
    assert_ne!(hex1, hex2, "Different secrets must produce different MACs");
}

#[test]
fn test_hmac_sha256_different_bodies_produce_different_macs() {
    let secret = "shared-secret";
    let hex1 = compute_hmac_sha256(secret, r#"{"attestationId":"session-1"}"#);
    let hex2 = compute_hmac_sha256(secret, r#"{"attestationId":"session-2"}"#);
    assert_ne!(hex1, hex2, "Different bodies must produce different MACs");
}

// ============================================================================
// SQLite persistence tests (R.11 proof store)
// ============================================================================

fn make_test_record(session_id: &str) -> ProofExportRecord {
    ProofExportRecord {
        session_id: session_id.to_string(),
        server_name: "wise.com".to_string(),
        policy_version: Some("v1.0.0".to_string()),
        order_binding_hash: Some("0xdeadbeef".to_string()),
        commitments_hash: "0xcafebabe".to_string(),
        verifier_signature: Some("0xsig".to_string()),
        verifier_address: Some("0xaddr".to_string()),
        handler_results: r#"[]"#.to_string(),
        account_checks: None,
        redacted_sent: Some("GET / HTTP/1.1\r\n".to_string()),
        redacted_recv: Some("HTTP/1.1 200 OK\r\n".to_string()),
        session_data: Some(r#"{"__tlsn_policy_version":"v1.0.0"}"#.to_string()),
        tx_hash: None,
        recorded_at: current_timestamp_str(),
        retain_until: retain_until_str(),
        transcript_commitments: None,
        signing_chain_id: None,
        status: "provisional".to_string(),
        retention_class: "ephemeral".to_string(),
        owner_address: None,
        counterparty_address: None,
        tenant_id: None,
        committed_at: None,
    }
}

#[test]
fn test_sqlite_insert_and_retrieve_by_session_id() {
    let conn = init_db(":memory:");
    let record = make_test_record("test-session-1");
    insert_proof_record(&conn, &record).expect("insert should succeed");

    let retrieved = get_proof_by_session_id(&conn, "test-session-1");
    assert!(retrieved.is_some(), "Should retrieve inserted record");
    let r = retrieved.unwrap();
    assert_eq!(r.session_id, "test-session-1");
    assert_eq!(r.server_name, "wise.com");
    assert_eq!(r.policy_version, Some("v1.0.0".to_string()));
    assert_eq!(r.tx_hash, None);
}

#[test]
fn test_sqlite_returns_none_for_missing_session() {
    let conn = init_db(":memory:");
    let retrieved = get_proof_by_session_id(&conn, "nonexistent-session");
    assert!(retrieved.is_none(), "Should return None for missing session");
}

#[test]
fn test_promote_first_call_writes_tx_status_and_committed_at() {
    let conn = init_db(":memory:");
    let record = make_test_record("test-session-tx");
    insert_proof_record(&conn, &record).expect("insert should succeed");
    let before = get_proof_by_session_id(&conn, "test-session-tx").unwrap();
    assert_eq!(before.status, "provisional");
    assert!(before.committed_at.is_none());
    let retain_before = before.retain_until.clone();

    let outcome = promote_to_committed(&conn, "test-session-tx", "0xabc123", Some(11155111))
        .expect("promote should not return a DB error");
    assert_eq!(outcome, PromoteOutcome::Updated);

    let after = get_proof_by_session_id(&conn, "test-session-tx").unwrap();
    assert_eq!(after.tx_hash, Some("0xabc123".to_string()));
    assert_eq!(after.signing_chain_id, before.signing_chain_id); // unchanged
    assert_eq!(after.status, "committed");
    assert!(after.committed_at.is_some(), "committed_at must be set on promotion");
    // ★ §7.2 invariant: promote MUST NOT touch retain_until.
    assert_eq!(after.retain_until, retain_before, "retain_until must not change on promote");
}

#[test]
fn test_promote_unknown_session_returns_not_found() {
    let conn = init_db(":memory:");
    let outcome = promote_to_committed(&conn, "nonexistent-session", "0xdeadbeef", None)
        .expect("promote should not return a DB error for missing session");
    assert_eq!(outcome, PromoteOutcome::NotFound);
}

#[test]
fn test_promote_second_call_returns_already_set() {
    // First-write lock: once tx_hash is set, a second PATCH must be rejected
    // without modifying the row (HTTP layer maps this to 409).
    let conn = init_db(":memory:");
    let record = make_test_record("test-session-lock");
    insert_proof_record(&conn, &record).expect("insert should succeed");
    assert_eq!(
        promote_to_committed(&conn, "test-session-lock", "0xfirst", Some(1)).unwrap(),
        PromoteOutcome::Updated
    );
    assert_eq!(
        promote_to_committed(&conn, "test-session-lock", "0xsecond", Some(2)).unwrap(),
        PromoteOutcome::AlreadySet
    );
    let after = get_proof_by_session_id(&conn, "test-session-lock").unwrap();
    assert_eq!(after.tx_hash, Some("0xfirst".to_string()), "tx_hash must not be overwritten");
}

#[test]
fn test_sqlite_get_by_tx_hash() {
    let conn = init_db(":memory:");
    let record = make_test_record("test-session-lookup");
    insert_proof_record(&conn, &record).expect("insert should succeed");
    promote_to_committed(&conn, "test-session-lookup", "0xunique-tx", None)
        .expect("promote should succeed");

    let retrieved = get_proof_by_tx_hash(&conn, "0xunique-tx");
    assert!(retrieved.is_some(), "Should find record by tx hash");
    assert_eq!(retrieved.unwrap().session_id, "test-session-lookup");
}

#[test]
fn test_sqlite_get_by_tx_hash_returns_none_if_not_set() {
    let conn = init_db(":memory:");
    let record = make_test_record("test-session-notx");
    insert_proof_record(&conn, &record).expect("insert should succeed");

    let retrieved = get_proof_by_tx_hash(&conn, "0xmissing");
    assert!(retrieved.is_none(), "Should return None when tx_hash is not set");
}

#[test]
fn test_sqlite_insert_or_replace() {
    let conn = init_db(":memory:");
    let record = make_test_record("test-session-replace");
    insert_proof_record(&conn, &record).expect("insert should succeed");

    // Insert same session_id with different policy_version
    let updated = ProofExportRecord {
        policy_version: Some("v2.0.0".to_string()),
        ..make_test_record("test-session-replace")
    };
    insert_proof_record(&conn, &updated).expect("insert should succeed");

    let retrieved = get_proof_by_session_id(&conn, "test-session-replace");
    assert!(retrieved.is_some());
    assert_eq!(retrieved.unwrap().policy_version, Some("v2.0.0".to_string()),
        "INSERT OR REPLACE should overwrite existing record");
}

// ============================================================================
// Label propagation tests (T13 / R.16)
// ============================================================================

fn make_handler_result(label: Option<&str>, value: &str, idx: usize) -> HandlerResult {
    HandlerResult {
        commitment_index: idx,
        handler: Handler {
            handler_type: HandlerType::Recv,
            part: HandlerPart::Body,
            label: label.map(|s| s.to_string()),
        },
        value: value.to_string(),
        start: 0,
        end: value.len(),
    }
}

#[test]
fn test_build_slim_webhook_payload_travel_rule_fields() {
    let results = vec![
        make_handler_result(Some("originator.amount"), "100.00", 0),
        make_handler_result(Some("transaction.id"), "TXN-001", 1),
        make_handler_result(None, "unlabeled", 2),
    ];

    let sig: Option<VerifierSignature> = None;
    let payload = build_slim_webhook_payload(
        "session-abc",
        Some("v1.0.0".to_string()),
        "wise.com",
        &results,
        true,
        &sig,
        None,
    );

    assert_eq!(payload.attestation_id, "session-abc");
    assert_eq!(payload.policy_version, Some("v1.0.0".to_string()));
    assert_eq!(payload.travel_rule_fields.len(), 2, "Only labeled handlers go into travel_rule_fields");
    assert!(payload.travel_rule_fields.contains_key("originator.amount"));
    assert_eq!(payload.travel_rule_fields["originator.amount"].value, "100.00");
    assert_eq!(payload.travel_rule_fields["originator.amount"].commitment_index, 0);
    assert!(payload.travel_rule_fields.contains_key("transaction.id"));
    assert!(!payload.travel_rule_fields.contains_key("unlabeled"),
        "Handlers without label must not appear in travel_rule_fields");
}

#[test]
fn test_build_slim_webhook_payload_no_labels_produces_empty_map() {
    let results = vec![
        make_handler_result(None, "data1", 0),
        make_handler_result(None, "data2", 1),
    ];
    let sig: Option<VerifierSignature> = None;
    let payload = build_slim_webhook_payload(
        "session-nolabel",
        None,
        "api.example.com",
        &results,
        true,
        &sig,
        None,
    );
    assert!(payload.travel_rule_fields.is_empty(),
        "No labels → travel_rule_fields should be empty");
}

// ============================================================================
// policyVersion in sign_commitments (T12 / R.15)
// ============================================================================

#[test]
fn test_sign_commitments_includes_policy_version() {
    use crate::{sign_commitments, TranscriptCommitmentSummary};
    use k256::ecdsa::SigningKey;

    // Generate a test signing key (not for production use)
    let key_bytes = [1u8; 32];
    let signing_key = SigningKey::from_slice(&key_bytes).expect("valid test key");

    let commitments: Vec<TranscriptCommitmentSummary> = vec![];
    let sig_with_pv = sign_commitments(
        &signing_key,
        11155111,
        "test-session",
        &commitments,
        None,
        Some("v1.0.0"),
    ).expect("signing should succeed");

    let sig_no_pv = sign_commitments(
        &signing_key,
        11155111,
        "test-session",
        &commitments,
        None,
        None,
    ).expect("signing should succeed");

    assert_eq!(sig_with_pv.policy_version, Some("v1.0.0".to_string()));
    assert_eq!(sig_no_pv.policy_version, None);
    assert_eq!(sig_no_pv.policy_version_hash, format!("0x{}", "00".repeat(32)));
    assert_ne!(
        sig_with_pv.policy_version_hash,
        sig_no_pv.policy_version_hash,
        "Different policyVersion must produce different policyVersionHash values",
    );
    assert_ne!(sig_with_pv.signature, sig_no_pv.signature,
        "Different policyVersion must produce different signatures");
}

#[test]
fn test_sign_commitments_same_policy_version_is_deterministic() {
    use crate::{sign_commitments, TranscriptCommitmentSummary};
    use k256::ecdsa::SigningKey;

    let key_bytes = [2u8; 32];
    let signing_key = SigningKey::from_slice(&key_bytes).expect("valid test key");
    let commitments: Vec<TranscriptCommitmentSummary> = vec![];

    let sig1 = sign_commitments(&signing_key, 1, "sess", &commitments, None, Some("v1.0.0"))
        .expect("signing should succeed");
    let sig2 = sign_commitments(&signing_key, 1, "sess", &commitments, None, Some("v1.0.0"))
        .expect("signing should succeed");

    assert_eq!(
        sig1.policy_version_hash, sig2.policy_version_hash,
        "Same policyVersion must produce same policyVersionHash",
    );
    assert_eq!(sig1.signature, sig2.signature,
        "Same inputs must produce same signature (deterministic ECDSA)");
}

// ============================================================================
// VERIFIER_PRIVATE_KEY parsing/loading tests
// ============================================================================

fn verifier_env_test_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

struct VerifierKeyEnvGuard {
    original: Option<String>,
}

impl VerifierKeyEnvGuard {
    fn set(temp_value: Option<&str>) -> Self {
        let original = std::env::var("VERIFIER_PRIVATE_KEY").ok();
        match temp_value {
            Some(v) => std::env::set_var("VERIFIER_PRIVATE_KEY", v),
            None => std::env::remove_var("VERIFIER_PRIVATE_KEY"),
        }
        Self { original }
    }
}

impl Drop for VerifierKeyEnvGuard {
    fn drop(&mut self) {
        match &self.original {
            Some(v) => std::env::set_var("VERIFIER_PRIVATE_KEY", v),
            None => std::env::remove_var("VERIFIER_PRIVATE_KEY"),
        }
    }
}

#[test]
fn test_parse_verifier_private_key_accepts_64_hex_without_prefix() {
    let key = "2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6";
    let result = parse_verifier_private_key(key);
    assert!(result.is_ok(), "64-char hex key without prefix should parse");
}

#[test]
fn test_parse_verifier_private_key_accepts_0x_prefixed_64_hex() {
    let key = "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6";
    let result = parse_verifier_private_key(key);
    assert!(result.is_ok(), "0x-prefixed 64-char hex key should parse");
}

#[test]
fn test_parse_verifier_private_key_rejects_invalid_length() {
    let key = "ab".repeat(33); // 66 hex chars
    let err = parse_verifier_private_key(&key).expect_err("invalid length must fail");
    assert!(
        err.to_string().contains("must be exactly 64 hex chars"),
        "error should explain expected key length, got: {}",
        err
    );
}

#[test]
fn test_parse_verifier_private_key_rejects_non_hex_chars() {
    let key = "g".repeat(64);
    let err = parse_verifier_private_key(&key).expect_err("non-hex key must fail");
    assert!(
        err.to_string().contains("non-hex"),
        "error should mention non-hex characters, got: {}",
        err
    );
}

#[test]
fn test_load_verifier_signer_from_env_derives_expected_address() {
    let _lock = verifier_env_test_lock()
        .lock()
        .expect("env test lock must not be poisoned");
    let _guard = VerifierKeyEnvGuard::set(Some(
        "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
    ));

    let (_signing_key, address) =
        load_verifier_signer_from_env().expect("env key should load successfully");
    assert_eq!(
        address.to_ascii_lowercase(),
        "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720".to_ascii_lowercase(),
        "derived address should match known Hardhat verifier signer"
    );
}

// ============================================================================
// Compliance full-path regression tests (Groups 1–6)
// ============================================================================

// Group 1: account_checks persisted and retrieved
#[test]
fn test_account_checks_persisted_and_retrieved() {
    let conn = init_db(":memory:");
    let account_checks_json = r#"[
        {"direction":"recv","start":100,"end":150,
         "expectedHash":"0xabc","computedHash":"0xabc",
         "valueMode":"json_value","passed":true,"fieldLabel":"originator.accountId"}
    ]"#;
    let mut record = make_test_record("session-checks");
    record.account_checks = Some(account_checks_json.to_string());
    insert_proof_record(&conn, &record).expect("insert should succeed");

    let retrieved = get_proof_by_session_id(&conn, "session-checks").unwrap();
    assert!(retrieved.account_checks.is_some());
    let parsed: serde_json::Value =
        serde_json::from_str(retrieved.account_checks.unwrap().as_str()).unwrap();
    assert_eq!(parsed[0]["passed"], true);
    assert_eq!(parsed[0]["fieldLabel"], "originator.accountId");
}

// Group 2: transcript_commitments persisted and retrieved
#[test]
fn test_transcript_commitments_persisted_and_retrieved() {
    let conn = init_db(":memory:");
    let tc_json = r#"[{"commitmentIndex":0,"hashHex":"0xcafe","start":0,"end":10}]"#;
    let mut record = make_test_record("session-tc");
    record.transcript_commitments = Some(tc_json.to_string());
    insert_proof_record(&conn, &record).expect("insert should succeed");

    let retrieved = get_proof_by_session_id(&conn, "session-tc").unwrap();
    assert!(retrieved.transcript_commitments.is_some());
    let parsed: serde_json::Value =
        serde_json::from_str(retrieved.transcript_commitments.unwrap().as_str()).unwrap();
    assert_eq!(parsed[0]["hashHex"], "0xcafe");
}

// Group 3: signing_chain_id persisted and retrieved
#[test]
fn test_signing_chain_id_persisted_and_retrieved() {
    let conn = init_db(":memory:");
    let mut record = make_test_record("session-chainid");
    record.signing_chain_id = Some(11155111);
    insert_proof_record(&conn, &record).expect("insert should succeed");

    let retrieved = get_proof_by_session_id(&conn, "session-chainid").unwrap();
    assert_eq!(retrieved.signing_chain_id, Some(11155111));
}

// Group 4: record_to_response produces ProofExportV1-aligned structure
#[test]
fn test_record_to_response_travel_rule_fields() {
    let conn = init_db(":memory:");
    let handler_results = r#"[
        {"commitmentIndex":0,"type":"RECV","part":"BODY",
         "label":"originator.amount","value":"100.00","start":0,"end":6},
        {"commitmentIndex":1,"type":"RECV","part":"BODY",
         "value":"no-label","start":6,"end":14}
    ]"#;
    let mut record = make_test_record("session-trf");
    record.handler_results = handler_results.to_string();
    insert_proof_record(&conn, &record).expect("insert should succeed");

    let retrieved = get_proof_by_session_id(&conn, "session-trf").unwrap();
    let response = record_to_response(retrieved);

    assert_eq!(response.format_version, "ProofExportV1");
    let trf = &response.travel_rule_fields;
    assert!(trf.get("originator.amount").is_some(), "labeled handler must appear");
    assert!(trf.get("no-label").is_none(), "handler without label must not appear");
}

#[test]
fn test_record_to_response_has_required_v1_fields() {
    let record = make_test_record("session-v1");
    let response = record_to_response(record);
    assert_eq!(response.format_version, "ProofExportV1");
    assert!(response.account_checks.is_array(), "accountChecks must be a JSON array");
    assert!(response.transcript_commitments.is_array(), "transcriptCommitments must be a JSON array");
}

// Group 5: duplicate travel_rule label does not panic
#[test]
fn test_duplicate_label_does_not_panic() {
    let results = vec![
        make_handler_result(Some("originator.amount"), "100.00", 0),
        make_handler_result(Some("originator.amount"), "200.00", 1),
    ];
    let sig: Option<VerifierSignature> = None;
    // Must not panic; duplicate label — last value wins
    let payload = build_slim_webhook_payload(
        "session-dup",
        Some("v1.0.0".to_string()),
        "wise.com",
        &results,
        true,
        &sig,
        None,
    );
    assert_eq!(payload.travel_rule_fields.len(), 1);
    assert_eq!(payload.travel_rule_fields["originator.amount"].value, "200.00");
}

// Group 6: timestamp functions return RFC3339 format

/// Validates that a string is a strict RFC3339 datetime using a regex that
/// checks the structural format beyond the loose `contains('T')` / `ends_with('Z')`
/// heuristics.  Pattern: YYYY-MM-DDTHH:MM:SS followed by Z or ±HH:MM offset.
fn assert_is_rfc3339(s: &str, label: &str) {
    let re = regex::Regex::new(
        r"^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$",
    )
    .expect("RFC3339 regex must compile");
    assert!(
        re.is_match(s),
        "{} must match strict RFC3339 YYYY-MM-DDTHH:MM:SS(Z|±HH:MM), got: {}",
        label,
        s
    );
}

#[test]
fn test_current_timestamp_str_is_rfc3339() {
    let ts = current_timestamp_str();
    assert_is_rfc3339(&ts, "current_timestamp_str()");
}

#[test]
fn test_retain_until_str_is_rfc3339() {
    let ts = retain_until_str();
    assert_is_rfc3339(&ts, "retain_until_str()");
}

#[test]
fn test_format_rfc3339_known_value() {
    // Unix epoch = 1970-01-01T00:00:00Z
    assert_eq!(format_rfc3339(0), "1970-01-01T00:00:00Z");
    // 1745222400 = 2025-04-21T08:00:00Z
    assert_eq!(format_rfc3339(1745222400), "2025-04-21T08:00:00Z");
    // 2024-02-29T11:34:56Z (leap year) = 1709206496
    assert_eq!(format_rfc3339(1709206496), "2024-02-29T11:34:56Z");
}

// ============================================================================
// Stage 3 — owner soft-fail parsing, retention windows, new-field round-trip
// ============================================================================

#[test]
fn test_parse_owner_address_soft_fail() {
    use crate::util::parse_owner_address;
    let forty = "0".repeat(40);
    // Valid lowercase
    assert_eq!(
        parse_owner_address(&format!("0x{}", forty)),
        Some(format!("0x{}", forty))
    );
    // EIP-55 checksummed (mixed case) is lowercased, then accepted
    let mixed = "0xAbCdef0123456789abcdef0123456789ABCDEF01";
    assert_eq!(
        parse_owner_address(mixed),
        Some(mixed.to_lowercase())
    );
    // Surrounding whitespace trimmed
    assert_eq!(
        parse_owner_address(&format!("  0x{}  ", forty)),
        Some(format!("0x{}", forty))
    );
    // Soft-fail cases → None (never panics, never errors)
    assert_eq!(parse_owner_address(""), None);
    assert_eq!(parse_owner_address("0x"), None);
    assert_eq!(parse_owner_address(&format!("0x{}", "0".repeat(39))), None); // too short
    assert_eq!(parse_owner_address(&format!("0x{}", "0".repeat(41))), None); // too long
    assert_eq!(parse_owner_address(&format!("{}", "0".repeat(42))), None); // no 0x prefix
    assert_eq!(parse_owner_address(&format!("0x{}", "g".repeat(40))), None); // non-hex
}

#[test]
fn test_compute_retain_until_compliance_longer_than_ephemeral() {
    use crate::storage::retention::compute_retain_until;
    let compliance = compute_retain_until("compliance");
    let ephemeral = compute_retain_until("ephemeral");
    // Both are RFC3339 strings; compliance window (years) sorts strictly after
    // the ephemeral window (days). String comparison works for RFC3339.
    assert!(
        compliance > ephemeral,
        "compliance retain_until ({}) must be later than ephemeral ({})",
        compliance,
        ephemeral
    );
    // compliance should be at least ~4 years out (sanity floor on the year field)
    let year: i32 = compliance[..4].parse().unwrap();
    assert!(year >= 2030, "compliance retain year {} should be far future", year);
}

#[test]
fn test_new_compliance_fields_round_trip() {
    let conn = init_db(":memory:");
    let owner = format!("0x{}", "1".repeat(40));
    let record = ProofExportRecord {
        status: "committed".to_string(),
        retention_class: "compliance".to_string(),
        owner_address: Some(owner.clone()),
        counterparty_address: Some(format!("0x{}", "2".repeat(40))),
        tenant_id: Some("exchangeA".to_string()),
        committed_at: Some("2026-05-01T00:00:00Z".to_string()),
        ..make_test_record("test-session-newfields")
    };
    insert_proof_record(&conn, &record).expect("insert should succeed");

    let r = get_proof_by_session_id(&conn, "test-session-newfields").expect("record present");
    assert_eq!(r.status, "committed");
    assert_eq!(r.retention_class, "compliance");
    assert_eq!(r.owner_address, Some(owner));
    assert_eq!(r.counterparty_address, Some(format!("0x{}", "2".repeat(40))));
    assert_eq!(r.tenant_id, Some("exchangeA".to_string()));
    assert_eq!(r.committed_at, Some("2026-05-01T00:00:00Z".to_string()));
}

#[test]
fn test_new_fields_default_when_unset() {
    let conn = init_db(":memory:");
    // make_test_record uses neutral defaults (provisional / ephemeral / None).
    let record = make_test_record("test-session-defaults");
    insert_proof_record(&conn, &record).expect("insert should succeed");

    let r = get_proof_by_session_id(&conn, "test-session-defaults").expect("record present");
    assert_eq!(r.status, "provisional");
    assert_eq!(r.retention_class, "ephemeral");
    assert_eq!(r.owner_address, None);
    assert_eq!(r.counterparty_address, None);
    assert_eq!(r.tenant_id, None);
    assert_eq!(r.committed_at, None);
}

// ============================================================================
// Stage 4 — purge_expired_ephemeral three-condition matrix (§7.3)
// ============================================================================

/// Build a record with explicit retention_class / retain_until / tx_hash for purge tests.
fn make_purge_test_record(
    sid: &str,
    retention_class: &str,
    retain_until: &str,
    tx_hash: Option<&str>,
) -> ProofExportRecord {
    ProofExportRecord {
        retention_class: retention_class.to_string(),
        retain_until: retain_until.to_string(),
        tx_hash: tx_hash.map(|s| s.to_string()),
        ..make_test_record(sid)
    }
}

#[test]
fn test_purge_only_deletes_ephemeral_expired_with_null_tx_hash() {
    let conn = init_db(":memory:");
    let past = "2020-01-01T00:00:00Z"; // far in the past
    let future = "2099-12-31T23:59:59Z";
    let now = current_timestamp_str(); // somewhere between past and future

    // (1) ephemeral + expired + tx_hash IS NULL → MUST be deleted
    insert_proof_record(&conn, &make_purge_test_record("eph-exp-null", "ephemeral", past, None))
        .unwrap();
    // (2) ephemeral + expired + tx_hash IS NOT NULL → MUST be kept (tx_hash bottom-defense)
    insert_proof_record(
        &conn,
        &make_purge_test_record("eph-exp-tx", "ephemeral", past, Some("0xonchain")),
    )
    .unwrap();
    // (3) ephemeral + NOT expired → MUST be kept
    insert_proof_record(&conn, &make_purge_test_record("eph-fresh", "ephemeral", future, None))
        .unwrap();
    // (4) compliance + expired + tx_hash IS NULL → MUST be kept (compliance is sacrosanct)
    insert_proof_record(&conn, &make_purge_test_record("comp-exp-null", "compliance", past, None))
        .unwrap();
    // (5) compliance + expired + tx_hash IS NOT NULL → MUST be kept (doubly so)
    insert_proof_record(
        &conn,
        &make_purge_test_record("comp-exp-tx", "compliance", past, Some("0xonchain")),
    )
    .unwrap();

    let deleted = purge_expired_ephemeral(&conn, &now).expect("purge should succeed");
    assert_eq!(deleted, 1, "only row (1) should be deleted");

    assert!(get_proof_by_session_id(&conn, "eph-exp-null").is_none(), "row (1) deleted");
    assert!(get_proof_by_session_id(&conn, "eph-exp-tx").is_some(), "row (2) kept (tx_hash)");
    assert!(get_proof_by_session_id(&conn, "eph-fresh").is_some(), "row (3) kept (not expired)");
    assert!(
        get_proof_by_session_id(&conn, "comp-exp-null").is_some(),
        "row (4) kept (compliance, never deleted even if expired)"
    );
    assert!(get_proof_by_session_id(&conn, "comp-exp-tx").is_some(), "row (5) kept (compliance)");
}

#[test]
fn test_purge_models_web_behavior_compliance_without_patch_survives() {
    // §3.3 modeling: production `packages/web` generates compliance proofs
    // (order_binding_hash present) but NEVER calls PATCH /tx. After EPHEMERAL_TTL_DAYS
    // pass, those rows MUST still be present because retention_class='compliance'.
    let conn = init_db(":memory:");
    let now = current_timestamp_str();
    // compliance row with retain_until 5y in future, never PATCHed (tx_hash NULL).
    let web_record = ProofExportRecord {
        retention_class: "compliance".to_string(),
        retain_until: "2031-01-01T00:00:00Z".to_string(),
        tx_hash: None,
        order_binding_hash: Some("0xbinding".to_string()),
        ..make_test_record("web-compliance-sess")
    };
    insert_proof_record(&conn, &web_record).expect("insert should succeed");

    // Run purge many times — never touches compliance.
    for _ in 0..3 {
        let deleted = purge_expired_ephemeral(&conn, &now).expect("purge should succeed");
        assert_eq!(deleted, 0, "compliance row must never be purged");
    }
    assert!(get_proof_by_session_id(&conn, "web-compliance-sess").is_some());
}

#[test]
fn test_purge_is_idempotent() {
    // Running purge twice in a row deletes the row once; second call finds nothing.
    let conn = init_db(":memory:");
    insert_proof_record(
        &conn,
        &make_purge_test_record("eph-once", "ephemeral", "2020-01-01T00:00:00Z", None),
    )
    .unwrap();
    let now = current_timestamp_str();
    assert_eq!(purge_expired_ephemeral(&conn, &now).unwrap(), 1);
    assert_eq!(purge_expired_ephemeral(&conn, &now).unwrap(), 0);
}

// ============================================================================
// Stage 5 — KeyScope parsing, Principal resolution, list_proofs filtering (§6.2, §5.3)
// ============================================================================

mod stage5 {
    use super::*;
    use crate::auth::api_key::{parse_proof_api_keys, resolve_principal, KeyScope, Principal};
    use crate::list_proofs;
    use crate::ListQuery;

    fn hm(pairs: &[(&str, Option<&str>)]) -> std::collections::HashMap<String, KeyScope> {
        pairs
            .iter()
            .map(|(k, t)| {
                (
                    (*k).to_string(),
                    KeyScope {
                        tenant_id: t.map(|s| s.to_string()),
                    },
                )
            })
            .collect()
    }

    fn header_map(value: Option<&str>) -> axum::http::HeaderMap {
        let mut h = axum::http::HeaderMap::new();
        if let Some(v) = value {
            h.insert("x-tlsn-api-key", v.parse().unwrap());
        }
        h
    }

    fn header_map_bearer(value: Option<&str>) -> axum::http::HeaderMap {
        let mut h = axum::http::HeaderMap::new();
        if let Some(v) = value {
            h.insert(
                "authorization",
                format!("Bearer {}", v).parse().unwrap(),
            );
        }
        h
    }

    #[test]
    fn parse_multi_tenant() {
        let m = parse_proof_api_keys(Some("k1:tenantA, k2:tenantB ,super:*"));
        assert_eq!(m.len(), 3);
        assert_eq!(m["k1"], KeyScope { tenant_id: Some("tenantA".to_string()) });
        assert_eq!(m["k2"], KeyScope { tenant_id: Some("tenantB".to_string()) });
        assert_eq!(m["super"], KeyScope { tenant_id: None });
    }

    #[test]
    fn parse_bare_key_without_colon_becomes_super() {
        // A piece without `:` is treated as a SuperAdmin key — convenient shorthand
        // for `key:*`.
        let m = parse_proof_api_keys(Some("foo"));
        assert_eq!(m.len(), 1);
        assert_eq!(m["foo"], KeyScope { tenant_id: None });
    }

    #[test]
    fn parse_handles_empties_and_no_separator_and_star_scope() {
        let m = parse_proof_api_keys(Some(",, justkey ,k:*"));
        assert_eq!(m.len(), 2);
        assert_eq!(m["justkey"], KeyScope { tenant_id: None });
        assert_eq!(m["k"], KeyScope { tenant_id: None });
    }

    #[test]
    fn parse_empty_env_returns_empty_map() {
        // Empty map = dev passthrough signal.
        assert!(parse_proof_api_keys(None).is_empty());
        assert!(parse_proof_api_keys(Some("")).is_empty());
    }

    #[test]
    fn resolve_principal_anonymous_when_no_header() {
        let keys = hm(&[("k1", Some("A"))]);
        assert_eq!(
            resolve_principal(&axum::http::HeaderMap::new(), &keys, None),
            Principal::Anonymous
        );
    }

    #[test]
    fn resolve_principal_superadmin() {
        let keys = hm(&[("super", None), ("k1", Some("A"))]);
        assert_eq!(
            resolve_principal(&header_map(Some("super")), &keys, None),
            Principal::SuperAdmin
        );
    }

    #[test]
    fn resolve_principal_tenant() {
        let keys = hm(&[("k1", Some("tenantA")), ("k2", Some("tenantB"))]);
        assert_eq!(
            resolve_principal(&header_map(Some("k1")), &keys, None),
            Principal::Tenant { tenant_id: "tenantA".to_string() }
        );
        assert_eq!(
            resolve_principal(&header_map(Some("k2")), &keys, None),
            Principal::Tenant { tenant_id: "tenantB".to_string() }
        );
    }

    #[test]
    fn resolve_principal_unknown_key_is_anonymous_not_super() {
        // §6.2 invariant: unknown key MUST NOT escalate to SuperAdmin or any tenant.
        let keys = hm(&[("k1", Some("A"))]);
        assert_eq!(
            resolve_principal(&header_map(Some("bogus")), &keys, None),
            Principal::Anonymous
        );
    }

    #[test]
    fn resolve_principal_accepts_bearer_authorization() {
        let keys = hm(&[("k1", Some("A"))]);
        assert_eq!(
            resolve_principal(&header_map_bearer(Some("k1")), &keys, None),
            Principal::Tenant { tenant_id: "A".to_string() }
        );
    }

    // ---- list_proofs ----

    fn make_listing_record(sid: &str, tenant: Option<&str>, owner: Option<&str>) -> ProofExportRecord {
        ProofExportRecord {
            tenant_id: tenant.map(|s| s.to_string()),
            owner_address: owner.map(|s| s.to_string()),
            ..make_test_record(sid)
        }
    }

    #[test]
    fn list_proofs_tenant_filter_isolates_rows() {
        // Plant 3 rows across two tenants + one untenanted.
        let conn = init_db(":memory:");
        insert_proof_record(&conn, &make_listing_record("a1", Some("tA"), None)).unwrap();
        insert_proof_record(&conn, &make_listing_record("a2", Some("tA"), None)).unwrap();
        insert_proof_record(&conn, &make_listing_record("b1", Some("tB"), None)).unwrap();
        insert_proof_record(&conn, &make_listing_record("o1", None, None)).unwrap();

        let q_a = ListQuery { tenant_id: Some("tA".to_string()), limit: 50, ..Default::default() };
        let page_a = list_proofs(&conn, &q_a).expect("list ok");
        let ids_a: Vec<_> = page_a.items.iter().map(|i| i.attestation_id.clone()).collect();
        assert_eq!(ids_a.len(), 2);
        assert!(ids_a.contains(&"a1".to_string()) && ids_a.contains(&"a2".to_string()));
        assert!(!ids_a.contains(&"b1".to_string()));

        let q_b = ListQuery { tenant_id: Some("tB".to_string()), limit: 50, ..Default::default() };
        let page_b = list_proofs(&conn, &q_b).expect("list ok");
        let ids_b: Vec<_> = page_b.items.iter().map(|i| i.attestation_id.clone()).collect();
        assert_eq!(ids_b, vec!["b1".to_string()]);

        // No filter (SuperAdmin behavior at the storage layer) → sees all 4.
        let q_all = ListQuery { limit: 50, ..Default::default() };
        let page_all = list_proofs(&conn, &q_all).expect("list ok");
        assert_eq!(page_all.items.len(), 4);
    }

    #[test]
    fn list_proofs_owner_and_status_filters_compose() {
        let conn = init_db(":memory:");
        let owner = format!("0x{}", "1".repeat(40));
        insert_proof_record(
            &conn,
            &ProofExportRecord {
                owner_address: Some(owner.clone()),
                status: "committed".to_string(),
                ..make_test_record("o-c")
            },
        )
        .unwrap();
        insert_proof_record(
            &conn,
            &ProofExportRecord {
                owner_address: Some(owner.clone()),
                status: "provisional".to_string(),
                ..make_test_record("o-p")
            },
        )
        .unwrap();
        insert_proof_record(&conn, &make_test_record("other")).unwrap();

        let q = ListQuery {
            owner_address: Some(owner.clone()),
            status: Some("committed".to_string()),
            limit: 50,
            ..Default::default()
        };
        let page = list_proofs(&conn, &q).expect("list ok");
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].attestation_id, "o-c");
    }

    #[test]
    fn list_proofs_pagination_emits_cursor_and_walks() {
        // Insert 5 rows; page size 2 should produce 2 + 2 + 1 across three calls.
        let conn = init_db(":memory:");
        for i in 0..5 {
            insert_proof_record(
                &conn,
                &ProofExportRecord {
                    // Distinct recorded_at so ordering is stable.
                    recorded_at: format!("2026-05-{:02}T00:00:00Z", 10 + i),
                    ..make_test_record(&format!("s{}", i))
                },
            )
            .unwrap();
        }

        let q_base = ListQuery { limit: 2, ..Default::default() };
        let page1 = list_proofs(&conn, &q_base).unwrap();
        assert_eq!(page1.items.len(), 2);
        assert!(page1.next_cursor.is_some(), "more rows remain");

        let q2 = ListQuery {
            limit: 2,
            cursor: page1.next_cursor.clone(),
            ..Default::default()
        };
        let page2 = list_proofs(&conn, &q2).unwrap();
        assert_eq!(page2.items.len(), 2);
        // Pages must not overlap.
        let ids1: std::collections::HashSet<_> =
            page1.items.iter().map(|i| i.attestation_id.clone()).collect();
        for item in &page2.items {
            assert!(!ids1.contains(&item.attestation_id), "page2 overlaps page1");
        }

        let q3 = ListQuery {
            limit: 2,
            cursor: page2.next_cursor.clone(),
            ..Default::default()
        };
        let page3 = list_proofs(&conn, &q3).unwrap();
        assert_eq!(page3.items.len(), 1, "last page has 1 row");
        assert!(page3.next_cursor.is_none(), "no more rows");
    }

    #[test]
    fn list_proofs_limit_is_clamped() {
        // limit=0 or > MAX_LIST_LIMIT should not blow up; clamp behavior.
        let conn = init_db(":memory:");
        for i in 0..3 {
            insert_proof_record(&conn, &make_test_record(&format!("s{}", i))).unwrap();
        }
        let page = list_proofs(&conn, &ListQuery { limit: 0, ..Default::default() }).unwrap();
        assert!(page.items.len() >= 1, "limit=0 must still return ≥1");
        let page = list_proofs(&conn, &ListQuery { limit: 10_000, ..Default::default() }).unwrap();
        assert_eq!(page.items.len(), 3);
    }
}

// ============================================================================
// Stage 6 — SIWE nonce store, JWT mint/verify, Principal::User resolution (§6.3)
// ============================================================================

mod stage6 {
    use super::*;
    use crate::auth::api_key::{resolve_principal, KeyScope, Principal};
    use crate::auth::siwe::{issue_nonce, mint_token, verify_token, NonceStore};

    fn fresh_nonces() -> NonceStore {
        std::sync::Mutex::new(std::collections::HashMap::new())
    }

    fn header_map_bearer(value: &str) -> axum::http::HeaderMap {
        let mut h = axum::http::HeaderMap::new();
        h.insert("authorization", format!("Bearer {}", value).parse().unwrap());
        h
    }

    // ---- siwe::issue_nonce + nonce store ----

    #[test]
    fn issued_nonce_is_url_safe_and_long() {
        let store = fresh_nonces();
        let n = issue_nonce(&store);
        assert!(!n.is_empty());
        // SIWE recommends ≥ 8 char alphanumeric nonces; the siwe crate gives more.
        assert!(n.len() >= 8, "nonce too short: {}", n);
        // Persisted in the store.
        assert_eq!(store.lock().unwrap().len(), 1);
    }

    #[test]
    fn distinct_nonces_each_call() {
        let store = fresh_nonces();
        let a = issue_nonce(&store);
        let b = issue_nonce(&store);
        assert_ne!(a, b, "nonces must not collide");
        assert_eq!(store.lock().unwrap().len(), 2);
    }

    // ---- JWT mint / verify ----

    #[test]
    fn jwt_roundtrip_returns_address() {
        let addr = "0xabcdef0123456789abcdef0123456789abcdef01";
        let secret = "secret-of-the-day";
        let (token, exp) = mint_token(addr, secret).unwrap();
        assert!(exp > 0);
        let recovered = verify_token(&token, secret);
        assert_eq!(recovered.as_deref(), Some(addr));
    }

    #[test]
    fn jwt_with_wrong_secret_is_rejected() {
        let addr = "0xabcdef0123456789abcdef0123456789abcdef01";
        let (token, _) = mint_token(addr, "secret-A").unwrap();
        assert!(verify_token(&token, "secret-B").is_none());
    }

    #[test]
    fn jwt_malformed_is_rejected_softly() {
        // verify_token must never panic on garbage — returns None.
        assert!(verify_token("not-a-jwt", "secret").is_none());
        assert!(verify_token("", "secret").is_none());
        assert!(verify_token("aaa.bbb.ccc", "secret").is_none());
    }

    // ---- resolve_principal with JWT ----

    #[test]
    fn resolve_principal_user_via_valid_jwt() {
        // Stage 6 invariant: a valid SIWE JWT yields Principal::User with the
        // address recovered from the token's `sub` claim.
        let secret = "stage6-secret";
        let addr = "0x0000000000000000000000000000000000000abc";
        let (token, _) = mint_token(addr, secret).unwrap();
        let keys: std::collections::HashMap<String, KeyScope> = std::collections::HashMap::new();
        let principal = resolve_principal(&header_map_bearer(&token), &keys, Some(secret));
        assert_eq!(principal, Principal::User { address: addr.to_string() });
    }

    #[test]
    fn resolve_principal_falls_back_to_api_key_if_jwt_invalid() {
        // Stage 6 invariant: an expired/bad JWT must NOT escalate; we silently fall
        // through to API-key matching so a valid API key in the same Bearer header
        // still works.
        let mut keys: std::collections::HashMap<String, KeyScope> =
            std::collections::HashMap::new();
        keys.insert("validkey".to_string(), KeyScope { tenant_id: Some("tA".to_string()) });
        // "validkey" is also the Bearer value — JWT decode will fail (not a JWT),
        // so we fall through to API-key lookup and find the tenant binding.
        let principal = resolve_principal(
            &header_map_bearer("validkey"),
            &keys,
            Some("any-jwt-secret"),
        );
        assert_eq!(principal, Principal::Tenant { tenant_id: "tA".to_string() });
    }

    #[test]
    fn resolve_principal_user_does_not_appear_without_jwt_secret() {
        // §6.3: if SIWE is not configured, the User branch is unreachable.
        let secret = "stage6-secret";
        let (token, _) = mint_token("0xdeadbeef0000000000000000000000000000abcd", secret).unwrap();
        let keys: std::collections::HashMap<String, KeyScope> = std::collections::HashMap::new();
        // jwt_secret = None ⇒ JWT branch skipped ⇒ Bearer treated as API key ⇒
        // unknown ⇒ Anonymous.
        let principal = resolve_principal(&header_map_bearer(&token), &keys, None);
        assert_eq!(principal, Principal::Anonymous);
    }
}
