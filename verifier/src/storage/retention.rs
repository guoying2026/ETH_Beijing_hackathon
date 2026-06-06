//! Retention timestamps and (future) purge task for the proof store.
//!
//! Retention is decided by `retention_class` at insert time, NOT by `status`
//! (COMPLIANCE_STORAGE_PLAN §3.3).

/// Compliance retention window in years (env `RETENTION_YEARS`, default 5 — FATF R.11).
pub(crate) fn retention_years() -> u64 {
    std::env::var("RETENTION_YEARS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(5)
}

/// Ephemeral retention window in days (env `EPHEMERAL_TTL_DAYS`, default 30).
pub(crate) fn ephemeral_ttl_days() -> u64 {
    std::env::var("EPHEMERAL_TTL_DAYS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(30)
}

/// Compute `retain_until` (RFC3339 UTC) for a record being inserted now.
/// `compliance` → now + RETENTION_YEARS; anything else → now + EPHEMERAL_TTL_DAYS.
pub(crate) fn compute_retain_until(retention_class: &str) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let add_secs = if retention_class == "compliance" {
        retention_years() * 365 * 24 * 3600
    } else {
        ephemeral_ttl_days() * 24 * 3600
    };
    crate::format_rfc3339(now + add_secs)
}

/// Delete expired ephemeral rows that were never committed (§7.3 three-condition).
///
/// `retention_class='ephemeral' AND retain_until < ?now AND tx_hash IS NULL`
///
/// - `compliance` rows are NEVER deleted (R.11 5-year retention is sacrosanct).
/// - Any row with a non-null `tx_hash` is NEVER deleted (belt-and-suspenders: even if a
///   row were mis-labeled `ephemeral`, having been committed on-chain protects it).
///
/// Returns the number of rows deleted.
pub(crate) fn purge_expired_ephemeral(
    conn: &rusqlite::Connection,
    now_rfc3339: &str,
) -> Result<usize, rusqlite::Error> {
    conn.execute(
        "DELETE FROM proof_store \
         WHERE retention_class = 'ephemeral' \
           AND retain_until < ?1 \
           AND tx_hash IS NULL",
        rusqlite::params![now_rfc3339],
    )
}

/// Background purge cadence in seconds (env `PURGE_INTERVAL_SECS`, default 300 = 5 min).
pub(crate) fn purge_interval_secs() -> u64 {
    std::env::var("PURGE_INTERVAL_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(300)
}

/// Return RFC3339 UTC string for recorded_at + 5 years (legacy helper, used by tests only).
#[cfg(test)]
pub(crate) fn retain_until_str() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let five_years: u64 = 5 * 365 * 24 * 3600;
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        + five_years;
    crate::format_rfc3339(secs)
}
