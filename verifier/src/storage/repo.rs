//! SQLite persistence for the proof store (R.11 retention).
//!
//! Stage 1 — pure structural move from `main.rs`. No behavior changes.

use crate::storage::export::build_travel_rule_fields_from_handler_results;
use crate::storage::record::{ListItem, ListPage, ListQuery, ProofExportRecord};
use rusqlite::types::Value;

/// Open SQLite DB and apply schema.
pub(crate) fn init_db(path: &str) -> rusqlite::Connection {
    let conn = rusqlite::Connection::open(path).expect("Failed to open SQLite DB");
    conn.execute_batch(include_str!("schema.sql"))
        .expect("Failed to init DB schema");
    // Migrate existing DBs: add new columns if they don't exist yet.
    // SQLite does not support IF NOT EXISTS on ALTER TABLE; ignore duplicate-column errors.
    if let Err(e) = conn.execute(
        "ALTER TABLE proof_store ADD COLUMN transcript_commitments TEXT",
        [],
    ) {
        let msg = e.to_string();
        if !msg.contains("duplicate column") {
            panic!("Unexpected ALTER TABLE error: {}", e);
        }
    }
    if let Err(e) = conn.execute(
        "ALTER TABLE proof_store ADD COLUMN signing_chain_id INTEGER",
        [],
    ) {
        let msg = e.to_string();
        if !msg.contains("duplicate column") {
            panic!("Unexpected ALTER TABLE error: {}", e);
        }
    }

    // Stage 2 (COMPLIANCE_STORAGE_PLAN §3.2): add status/retention/owner/tenant columns.
    // Each ALTER ignores "duplicate column" so existing DBs migrate idempotently.
    for stmt in [
        "ALTER TABLE proof_store ADD COLUMN status TEXT NOT NULL DEFAULT 'provisional'",
        "ALTER TABLE proof_store ADD COLUMN retention_class TEXT NOT NULL DEFAULT 'ephemeral'",
        "ALTER TABLE proof_store ADD COLUMN owner_address TEXT",
        "ALTER TABLE proof_store ADD COLUMN counterparty_address TEXT",
        "ALTER TABLE proof_store ADD COLUMN tenant_id TEXT",
        "ALTER TABLE proof_store ADD COLUMN committed_at TEXT",
    ] {
        if let Err(e) = conn.execute(stmt, []) {
            let msg = e.to_string();
            if !msg.contains("duplicate column") {
                panic!("Unexpected ALTER TABLE error: {}", e);
            }
        }
    }

    // Indexes for owner/tenant/status/retention lookups (idempotent).
    for stmt in [
        "CREATE INDEX IF NOT EXISTS idx_owner     ON proof_store(owner_address)",
        "CREATE INDEX IF NOT EXISTS idx_tenant    ON proof_store(tenant_id)",
        "CREATE INDEX IF NOT EXISTS idx_status    ON proof_store(status)",
        "CREATE INDEX IF NOT EXISTS idx_retention ON proof_store(retention_class, retain_until)",
    ] {
        conn.execute(stmt, [])
            .expect("Failed to create proof_store index");
    }

    // Historical backfill — ORDER MATTERS (set retention before status):
    // 1. Compliance rows (have an order_binding_hash) keep the long retention window,
    //    so the new ephemeral purge can never delete them.
    conn.execute(
        "UPDATE proof_store SET retention_class='compliance' \
         WHERE order_binding_hash IS NOT NULL AND retention_class='ephemeral'",
        [],
    )
    .expect("Failed to backfill retention_class");
    // 2. Any row that already carries a tx_hash is, by definition, committed.
    conn.execute(
        "UPDATE proof_store SET status='committed', committed_at=recorded_at \
         WHERE tx_hash IS NOT NULL AND status='provisional'",
        [],
    )
    .expect("Failed to backfill status");

    conn
}

/// True for transient SQLite errors worth retrying (lock contention only).
fn is_retryable(e: &rusqlite::Error) -> bool {
    matches!(
        e,
        rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error {
                code: rusqlite::ffi::ErrorCode::DatabaseBusy
                    | rusqlite::ffi::ErrorCode::DatabaseLocked,
                ..
            },
            _,
        )
    )
}

/// Insert a proof record into the SQLite store.
///
/// COMPLIANCE_STORAGE_PLAN §7.1.1: bounded retry on SQLITE_BUSY / database-is-locked
/// (≈20/50/100ms backoff). All other errors (disk full, constraint, schema) return
/// immediately without retry. The caller decides fail-open vs fail-closed by
/// retention_class.
pub(crate) fn insert_proof_record(
    conn: &rusqlite::Connection,
    r: &ProofExportRecord,
) -> Result<(), rusqlite::Error> {
    const BACKOFFS_MS: [u64; 3] = [20, 50, 100];
    let mut attempt = 0usize;
    loop {
        match try_insert_proof_record(conn, r) {
            Ok(()) => return Ok(()),
            Err(e) => {
                if is_retryable(&e) && attempt < BACKOFFS_MS.len() {
                    std::thread::sleep(std::time::Duration::from_millis(BACKOFFS_MS[attempt]));
                    attempt += 1;
                    continue;
                }
                return Err(e);
            }
        }
    }
}

/// Single INSERT attempt (no retry).
fn try_insert_proof_record(
    conn: &rusqlite::Connection,
    r: &ProofExportRecord,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT OR REPLACE INTO proof_store (
            session_id, server_name, policy_version, order_binding_hash,
            commitments_hash, verifier_signature, verifier_address,
            handler_results, account_checks,
            redacted_sent, redacted_recv, session_data,
            tx_hash, recorded_at, retain_until,
            transcript_commitments, signing_chain_id,
            status, retention_class, owner_address, counterparty_address, tenant_id, committed_at
        ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23)",
        rusqlite::params![
            r.session_id,
            r.server_name,
            r.policy_version,
            r.order_binding_hash,
            r.commitments_hash,
            r.verifier_signature,
            r.verifier_address,
            r.handler_results,
            r.account_checks,
            r.redacted_sent,
            r.redacted_recv,
            r.session_data,
            r.tx_hash,
            r.recorded_at,
            r.retain_until,
            r.transcript_commitments,
            r.signing_chain_id,
            r.status,
            r.retention_class,
            r.owner_address,
            r.counterparty_address,
            r.tenant_id,
            r.committed_at,
        ],
    )
    .map(|_| ())
}

/// Fetch a proof record by session ID.
pub(crate) fn get_proof_by_session_id(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Option<ProofExportRecord> {
    conn.query_row(
        "SELECT session_id,server_name,policy_version,order_binding_hash,
                commitments_hash,verifier_signature,verifier_address,
                handler_results,account_checks,
                redacted_sent,redacted_recv,session_data,
                tx_hash,recorded_at,retain_until,
                transcript_commitments,signing_chain_id,
                status,retention_class,owner_address,counterparty_address,tenant_id,committed_at
         FROM proof_store WHERE session_id = ?1",
        rusqlite::params![session_id],
        |row| {
            Ok(ProofExportRecord {
                session_id: row.get(0)?,
                server_name: row.get(1)?,
                policy_version: row.get(2)?,
                order_binding_hash: row.get(3)?,
                commitments_hash: row.get(4)?,
                verifier_signature: row.get(5)?,
                verifier_address: row.get(6)?,
                handler_results: row.get(7)?,
                account_checks: row.get(8)?,
                redacted_sent: row.get(9)?,
                redacted_recv: row.get(10)?,
                session_data: row.get(11)?,
                tx_hash: row.get(12)?,
                recorded_at: row.get(13)?,
                retain_until: row.get(14)?,
                transcript_commitments: row.get(15)?,
                signing_chain_id: row.get(16)?,
                status: row.get(17)?,
                retention_class: row.get(18)?,
                owner_address: row.get(19)?,
                counterparty_address: row.get(20)?,
                tenant_id: row.get(21)?,
                committed_at: row.get(22)?,
            })
        },
    )
    .ok()
}

/// Outcome of `promote_to_committed` — used by the HTTP handler to choose 200 / 409 / 404.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PromoteOutcome {
    /// First successful PATCH: tx_hash / chain_id / status / committed_at written.
    Updated,
    /// Session exists but already has tx_hash set — first-write lock rejects overwrite (→ 409).
    AlreadySet,
    /// session_id does not exist (→ 404).
    NotFound,
}

/// Promote a proof from `provisional` to `committed` on first PATCH /tx.
///
/// In one UPDATE:
///   - writes `tx_hash`, `chain_id`, `status='committed'`, `committed_at=now`
///   - **does NOT touch `retain_until`** (§3.3 / §7.2: retention was decided at insert
///     time by `retention_class`; promotion is a label change only).
/// First-write lock: only updates rows where `tx_hash IS NULL`.
pub(crate) fn promote_to_committed(
    conn: &rusqlite::Connection,
    session_id: &str,
    tx_hash: &str,
    chain_id: Option<i64>,
) -> Result<PromoteOutcome, rusqlite::Error> {
    let now = crate::current_timestamp_str();
    let rows = conn.execute(
        "UPDATE proof_store \
         SET tx_hash = ?1, chain_id = ?2, status = 'committed', committed_at = ?3 \
         WHERE session_id = ?4 AND tx_hash IS NULL",
        rusqlite::params![tx_hash, chain_id, now, session_id],
    )?;
    if rows > 0 {
        return Ok(PromoteOutcome::Updated);
    }
    // 0 rows updated: distinguish NotFound vs AlreadySet.
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM proof_store WHERE session_id = ?1",
            rusqlite::params![session_id],
            |_| Ok(true),
        )
        .unwrap_or(false);
    Ok(if exists {
        PromoteOutcome::AlreadySet
    } else {
        PromoteOutcome::NotFound
    })
}

/// Fetch a proof record by on-chain tx hash.
pub(crate) fn get_proof_by_tx_hash(
    conn: &rusqlite::Connection,
    tx_hash: &str,
) -> Option<ProofExportRecord> {
    conn.query_row(
        "SELECT session_id,server_name,policy_version,order_binding_hash,
                commitments_hash,verifier_signature,verifier_address,
                handler_results,account_checks,
                redacted_sent,redacted_recv,session_data,
                tx_hash,recorded_at,retain_until,
                transcript_commitments,signing_chain_id,
                status,retention_class,owner_address,counterparty_address,tenant_id,committed_at
         FROM proof_store WHERE tx_hash = ?1",
        rusqlite::params![tx_hash],
        |row| {
            Ok(ProofExportRecord {
                session_id: row.get(0)?,
                server_name: row.get(1)?,
                policy_version: row.get(2)?,
                order_binding_hash: row.get(3)?,
                commitments_hash: row.get(4)?,
                verifier_signature: row.get(5)?,
                verifier_address: row.get(6)?,
                handler_results: row.get(7)?,
                account_checks: row.get(8)?,
                redacted_sent: row.get(9)?,
                redacted_recv: row.get(10)?,
                session_data: row.get(11)?,
                tx_hash: row.get(12)?,
                recorded_at: row.get(13)?,
                retain_until: row.get(14)?,
                transcript_commitments: row.get(15)?,
                signing_chain_id: row.get(16)?,
                status: row.get(17)?,
                retention_class: row.get(18)?,
                owner_address: row.get(19)?,
                counterparty_address: row.get(20)?,
                tenant_id: row.get(21)?,
                committed_at: row.get(22)?,
            })
        },
    )
    .ok()
}

/// Default page size for `GET /proofs`. Capped at MAX_LIMIT regardless of request.
pub(crate) const DEFAULT_LIST_LIMIT: u32 = 50;
pub(crate) const MAX_LIST_LIMIT: u32 = 200;

/// List proofs with filters + cursor pagination (COMPLIANCE_STORAGE_PLAN §5.3).
///
/// The caller (auth layer) is responsible for injecting tenant_id / owner_address
/// filters according to the Principal — storage just executes the ListQuery as-is.
///
/// Ordering: `recorded_at DESC, session_id DESC`. The cursor is `<recorded_at>|<session_id>`
/// taken from the last item of the prior page; SQLite emulates tuple comparison via
/// `(recorded_at < ?) OR (recorded_at = ? AND session_id < ?)`.
pub(crate) fn list_proofs(
    conn: &rusqlite::Connection,
    q: &ListQuery,
) -> Result<ListPage, rusqlite::Error> {
    let mut sql = String::from(
        "SELECT session_id, server_name, recorded_at, tx_hash, status, retention_class, \
                owner_address, tenant_id, committed_at, handler_results \
         FROM proof_store WHERE 1=1",
    );
    let mut params: Vec<Value> = Vec::new();

    if let Some(t) = &q.tenant_id {
        sql.push_str(" AND tenant_id = ?");
        params.push(Value::Text(t.clone()));
    }
    if let Some(o) = &q.owner_address {
        sql.push_str(" AND owner_address = ?");
        params.push(Value::Text(o.clone()));
    }
    if let Some(s) = &q.status {
        sql.push_str(" AND status = ?");
        params.push(Value::Text(s.clone()));
    }
    if let Some(from) = &q.from {
        sql.push_str(" AND recorded_at >= ?");
        params.push(Value::Text(from.clone()));
    }
    if let Some(to) = &q.to {
        sql.push_str(" AND recorded_at < ?");
        params.push(Value::Text(to.clone()));
    }
    if let Some(cursor) = &q.cursor {
        if let Some((cur_ts, cur_sid)) = cursor.split_once('|') {
            sql.push_str(" AND (recorded_at < ? OR (recorded_at = ? AND session_id < ?))");
            params.push(Value::Text(cur_ts.to_string()));
            params.push(Value::Text(cur_ts.to_string()));
            params.push(Value::Text(cur_sid.to_string()));
        }
    }

    let effective_limit = q.limit.clamp(1, MAX_LIST_LIMIT);
    // Fetch one extra to detect whether there's another page.
    sql.push_str(" ORDER BY recorded_at DESC, session_id DESC LIMIT ?");
    params.push(Value::Integer((effective_limit as i64) + 1));

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?, // session_id
                row.get::<_, String>(1)?, // server_name
                row.get::<_, String>(2)?, // recorded_at
                row.get::<_, Option<String>>(3)?, // tx_hash
                row.get::<_, String>(4)?, // status
                row.get::<_, String>(5)?, // retention_class
                row.get::<_, Option<String>>(6)?, // owner_address
                row.get::<_, Option<String>>(7)?, // tenant_id
                row.get::<_, Option<String>>(8)?, // committed_at
                row.get::<_, String>(9)?, // handler_results (JSON)
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let has_more = rows.len() > effective_limit as usize;
    let mut items = Vec::with_capacity(effective_limit as usize);
    for (i, r) in rows.into_iter().enumerate() {
        if i >= effective_limit as usize {
            break;
        }
        let handler_results_val: serde_json::Value =
            serde_json::from_str(&r.9).unwrap_or(serde_json::Value::Array(vec![]));
        let travel_rule_fields =
            build_travel_rule_fields_from_handler_results(&handler_results_val);
        items.push(ListItem {
            attestation_id: r.0,
            status: r.4,
            retention_class: r.5,
            owner_address: r.6,
            tenant_id: r.7,
            server_name: r.1,
            tx_hash: r.3,
            timestamp: r.2,
            committed_at: r.8,
            travel_rule_fields,
        });
    }

    let next_cursor = if has_more {
        items
            .last()
            .map(|item| format!("{}|{}", item.timestamp, item.attestation_id))
    } else {
        None
    };

    Ok(ListPage { items, next_cursor })
}

/// Test-only HTTP handler: POST /test/seed — inserts a ProofExportRecord directly into the DB.
/// Only compiled when running tests (`#[cfg(test)]`).
#[cfg(test)]
pub(crate) async fn test_seed_proof_handler(
    axum::extract::State(state): axum::extract::State<std::sync::Arc<crate::AppState>>,
    axum::Json(record): axum::Json<ProofExportRecord>,
) -> impl axum::response::IntoResponse {
    let result = tokio::task::spawn_blocking(move || {
        let conn = state.db.lock().unwrap();
        let _ = insert_proof_record(&conn, &record);
    })
    .await;
    match result {
        Ok(_) => axum::http::StatusCode::CREATED,
        Err(_) => axum::http::StatusCode::INTERNAL_SERVER_ERROR,
    }
}
