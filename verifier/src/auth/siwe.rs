//! SIWE (EIP-4361) authentication + stateless JWT.
//!
//! Flow (COMPLIANCE_STORAGE_PLAN §6.3):
//!   1. Client GETs /auth/nonce → server returns a fresh nonce (short TTL).
//!   2. Client builds an EIP-4361 message including that nonce, signs it with
//!      the wallet, and POSTs message + signature to /auth/verify.
//!   3. Server checks signature ↔ recovered address, then mints a JWT (HS256)
//!      with the recovered address in the `sub` claim. Client uses
//!      `Authorization: Bearer <token>` on subsequent /proof* calls.

use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// Default TTL for nonces issued via /auth/nonce (5 min). Env override: SIWE_NONCE_TTL_SECS.
pub(crate) const DEFAULT_NONCE_TTL_SECS: u64 = 300;
/// Default TTL for issued JWTs (24h). Env override: SIWE_JWT_TTL_SECS.
pub(crate) const DEFAULT_JWT_TTL_SECS: u64 = 24 * 3600;

/// In-memory nonce store. `nonce → issued_at`. Cleaned lazily on each issue/verify.
pub(crate) type NonceStore = Mutex<HashMap<String, Instant>>;

pub(crate) fn nonce_ttl_secs() -> u64 {
    std::env::var("SIWE_NONCE_TTL_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_NONCE_TTL_SECS)
}

pub(crate) fn jwt_ttl_secs() -> u64 {
    std::env::var("SIWE_JWT_TTL_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_JWT_TTL_SECS)
}

/// Issue a fresh nonce and remember it in the store. siwe's nonce generator gives
/// 96 bits of entropy in a URL-safe alphabet.
pub(crate) fn issue_nonce(store: &NonceStore) -> String {
    let nonce = siwe::generate_nonce();
    let mut s = store.lock().unwrap();
    cleanup_expired(&mut s);
    s.insert(nonce.clone(), Instant::now());
    nonce
}

/// Remove nonces past TTL. Called inside lock-holders.
fn cleanup_expired(store: &mut HashMap<String, Instant>) {
    let ttl = std::time::Duration::from_secs(nonce_ttl_secs());
    let now = Instant::now();
    store.retain(|_, issued_at| now.duration_since(*issued_at) <= ttl);
}

/// Consume a nonce (remove it from the store). Returns true if the nonce was
/// present and not yet expired. One-shot use guards against replay.
fn consume_nonce(store: &NonceStore, nonce: &str) -> bool {
    let mut s = store.lock().unwrap();
    cleanup_expired(&mut s);
    s.remove(nonce).is_some()
}

#[derive(Debug)]
pub(crate) enum SiweAuthError {
    MalformedMessage(String),
    MalformedSignature,
    BadSignature(String),
    BadNonce,
    DomainMismatch { expected: String, actual: String },
}

impl std::fmt::Display for SiweAuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MalformedMessage(e) => write!(f, "malformed SIWE message: {}", e),
            Self::MalformedSignature => {
                write!(f, "malformed signature: must be 65-byte hex (0x-prefixed)")
            }
            Self::BadSignature(e) => write!(f, "signature verification failed: {}", e),
            Self::BadNonce => write!(f, "nonce not recognized or expired"),
            Self::DomainMismatch { expected, actual } => {
                write!(f, "domain mismatch: expected '{}', got '{}'", expected, actual)
            }
        }
    }
}

impl std::error::Error for SiweAuthError {}

/// JWT claims minted on successful SIWE verification.
#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct Claims {
    /// Subject: the verified wallet address (lowercase 0x...).
    pub(crate) sub: String,
    /// Expiry (unix seconds).
    pub(crate) exp: u64,
    /// Issued at (unix seconds).
    pub(crate) iat: u64,
}

/// Verify a SIWE message + signature against the configured domain. On success
/// returns the recovered wallet address (lowercased). The supplied nonce is
/// consumed from the store regardless of message-side validity once we've
/// confirmed it matches, so replay is impossible.
pub(crate) async fn verify_siwe(
    message: &str,
    signature_hex: &str,
    nonces: &NonceStore,
    expected_domain: &str,
) -> Result<String, SiweAuthError> {
    // 1. Parse EIP-4361 message.
    let msg: siwe::Message = message
        .parse()
        .map_err(|e: siwe::ParseError| SiweAuthError::MalformedMessage(e.to_string()))?;

    // 2. Domain check (prevent cross-site replay of an old signature against
    //    a different deployment).
    if msg.domain.as_str() != expected_domain {
        return Err(SiweAuthError::DomainMismatch {
            expected: expected_domain.to_string(),
            actual: msg.domain.to_string(),
        });
    }

    // 3. Decode signature: accept "0x..." or bare hex; must be exactly 65 bytes.
    let sig_hex = signature_hex.trim().trim_start_matches("0x");
    let sig_bytes = hex::decode(sig_hex).map_err(|_| SiweAuthError::MalformedSignature)?;
    let sig_arr: [u8; 65] = sig_bytes
        .as_slice()
        .try_into()
        .map_err(|_| SiweAuthError::MalformedSignature)?;

    // 4. Verify ECDSA against the EIP-191 prefixed digest. siwe checks address-in-
    //    message matches recovered address internally.
    msg.verify_eip191(&sig_arr)
        .map_err(|e| SiweAuthError::BadSignature(e.to_string()))?;

    // 5. Nonce check + one-shot consume (replay defense). We verify after signature
    //    so we don't burn nonces on bad-signature attempts.
    if !consume_nonce(nonces, &msg.nonce) {
        return Err(SiweAuthError::BadNonce);
    }

    // 6. Return the 0x-prefixed lowercase address (matches our DB normalization,
    //    §4.1).
    Ok(format!("0x{}", hex::encode(msg.address)))
}

/// Mint a signed JWT for the verified address.
pub(crate) fn mint_token(address: &str, secret: &str) -> Result<(String, u64), String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    let exp = now + jwt_ttl_secs();
    let claims = Claims {
        sub: address.to_string(),
        exp,
        iat: now,
    };
    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| e.to_string())?;
    Ok((token, exp))
}

/// Verify a JWT and return its address claim (the `sub`). None on any failure
/// (bad signature, expired, malformed). Callers MUST treat any failure as
/// "no User principal" rather than 500.
pub(crate) fn verify_token(token: &str, secret: &str) -> Option<String> {
    let mut validation = Validation::default();
    validation.validate_exp = true;
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .ok()
    .map(|data| data.claims.sub)
}

