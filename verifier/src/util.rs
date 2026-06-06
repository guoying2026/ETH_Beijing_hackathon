//! Small shared helpers.

/// Normalize + validate an Ethereum address taken from untrusted `session_data`.
///
/// Per COMPLIANCE_STORAGE_PLAN §4.1: lowercase first, then check `^0x[0-9a-f]{40}$`.
/// Returns `None` on any mismatch or absence — callers store NULL (soft-fail, §7.1),
/// never failing the proof.
pub(crate) fn parse_owner_address(raw: &str) -> Option<String> {
    let lower = raw.trim().to_lowercase();
    let valid = lower.len() == 42
        && lower.starts_with("0x")
        && lower[2..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if valid {
        Some(lower)
    } else {
        None
    }
}
