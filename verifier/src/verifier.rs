use eyre::eyre;
use serde::Serialize;
use tlsn::{
    config::{tls_commit::TlsCommitProtocolConfig, verifier::VerifierConfig},
    connection::{DnsName, ServerName},
    hash::HashAlgId,
    transcript::{Direction, PartialTranscript, TranscriptCommitment},
    verifier::VerifierOutput,
    webpki::RootCertStore,
    Session,
};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_util::compat::TokioAsyncReadCompatExt;
use tracing::{debug, info};

// ── Public types exported to main.rs ─────────────────────────────────────────

/// Transcript direction for commitment summaries.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum TranscriptDirectionSummary {
    Sent,
    Recv,
}

/// A single byte range within a transcript commitment.
#[derive(Debug, Clone, Serialize)]
pub struct TranscriptCommitmentRangeSummary {
    pub start: usize,
    pub end: usize,
}

/// Summary of a single transcript commitment, serialised into the
/// `session_completed` WebSocket message.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptCommitmentSummary {
    /// Always `"Hash"` for now (the only kind in TLSN alpha).
    pub kind: String,
    /// Which side of the transcript this commitment covers.
    pub direction: Option<TranscriptDirectionSummary>,
    /// Hash algorithm: `"Sha256"`, `"Blake3"`, or `"Keccak256"`.
    pub hash_alg: Option<String>,
    /// Byte ranges in the transcript that are covered by this commitment.
    pub ranges: Option<Vec<TranscriptCommitmentRangeSummary>>,
    /// Hex-encoded commitment hash (no `0x` prefix).
    pub hash_hex: Option<String>,
    /// Length of the commitment hash in bytes.
    pub hash_len: Option<usize>,
}

// ── Core verifier logic ───────────────────────────────────────────────────────

/// Run the MPC-TLS verifier protocol.
///
/// Returns `(dns_name, partial_transcript, commitment_summaries)`:
/// - `dns_name`            – TLS server hostname
/// - `partial_transcript`  – authed transcript data
/// - `commitment_summaries`– one summary per transcript commitment produced
///                           during the MPC reveal phase (used for signing)
pub async fn verifier<T: AsyncWrite + AsyncRead + Send + Unpin + 'static>(
    socket: T,
    max_sent_data: usize,
    max_recv_data: usize,
) -> Result<(DnsName, PartialTranscript, Vec<TranscriptCommitmentSummary>), eyre::ErrReport> {
    info!(
        "Starting verification with maxSentData={}, maxRecvData={}",
        max_sent_data, max_recv_data
    );

    // Create a session with the prover
    let session = Session::new(socket.compat());
    let (driver, mut handle) = session.split();

    // Spawn the session driver to run in the background
    let driver_task = tokio::spawn(driver);

    // Create verifier config with Mozilla root certificates for TLS verification
    let verifier_config = VerifierConfig::builder()
        .root_store(RootCertStore::mozilla())
        .build()
        .map_err(|e| eyre!("Failed to build verifier config: {}", e))?;

    let verifier = handle
        .new_verifier(verifier_config)
        .map_err(|e| eyre!("Failed to create verifier: {}", e))?;

    info!("Starting TLS commitment protocol");

    // Run the commitment protocol
    let verifier = verifier
        .commit()
        .await
        .map_err(|e| eyre!("Commitment failed: {}", e))?;

    // Check the proposed configuration
    let request = verifier.request();
    let TlsCommitProtocolConfig::Mpc(mpc_config) = request.protocol() else {
        return Err(eyre!("Only MPC protocol is supported"));
    };

    // Validate the proposed configuration
    if mpc_config.max_sent_data() > max_sent_data {
        return Err(eyre!(
            "Prover requested max_sent_data {} exceeds limit {}",
            mpc_config.max_sent_data(),
            max_sent_data
        ));
    }
    if mpc_config.max_recv_data() > max_recv_data {
        return Err(eyre!(
            "Prover requested max_recv_data {} exceeds limit {}",
            mpc_config.max_recv_data(),
            max_recv_data
        ));
    }

    info!(
        "Accepting TLS commitment with max_sent={}, max_recv={}",
        mpc_config.max_sent_data(),
        mpc_config.max_recv_data()
    );

    // Accept and run the commitment protocol
    let verifier = verifier
        .accept()
        .await
        .map_err(|e| eyre!("Accept failed: {}", e))?
        .run()
        .await
        .map_err(|e| eyre!("Run failed: {}", e))?;

    info!("TLS connection complete, starting verification");

    // Verify the proof
    let verifier = verifier
        .verify()
        .await
        .map_err(|e| eyre!("Verification failed: {}", e))?;

    let (
        VerifierOutput {
            server_name,
            transcript,
            transcript_commitments,
        },
        verifier,
    ) = verifier
        .accept()
        .await
        .map_err(|e| eyre!("Accept verification failed: {}", e))?;

    // Close the verifier
    verifier
        .close()
        .await
        .map_err(|e| eyre!("Failed to close verifier: {}", e))?;

    // Close the session handle
    handle.close();

    // Wait for the driver to complete
    driver_task
        .await
        .map_err(|e| eyre!("Driver task failed: {}", e))?
        .map_err(|e| eyre!("Session driver error: {}", e))?;

    info!("verify() returned successfully - prover sent all data");

    let server_name =
        server_name.ok_or_else(|| eyre!("prover should have revealed server name"))?;
    let transcript =
        transcript.ok_or_else(|| eyre!("prover should have revealed transcript data"))?;

    info!("server_name: {:?}", server_name);
    debug!("transcript: {:?}", &transcript);

    // Extract sent and received data for logging
    info!("Extracting transcript data...");
    let sent = transcript.sent_unsafe().to_vec();
    let received = transcript.received_unsafe().to_vec();

    // Check Session info: server name.
    let ServerName::Dns(dns_name) = server_name;
    info!("Server name verified: {:?}", dns_name);

    info!("============================================");
    info!("✅ MPC-TLS Verification successful!");
    info!("============================================");

    info!("Sent data: {:?}", bytes_to_redacted_string(&sent, "█")?);
    info!("Sent data: {}", bytes_to_redacted_string(&sent, "█")?);
    info!(
        "Received data: {:?}",
        bytes_to_redacted_string(&received, "█")?
    );

    // Convert TLSN transcript commitments to our summary type
    let commitment_summaries = build_commitment_summaries(&transcript_commitments);
    info!(
        "Built {} transcript commitment summaries",
        commitment_summaries.len()
    );

    Ok((dns_name, transcript, commitment_summaries))
}

/// Convert TLSN `TranscriptCommitment` objects into serialisable summaries.
fn build_commitment_summaries(
    commitments: &[TranscriptCommitment],
) -> Vec<TranscriptCommitmentSummary> {
    commitments
        .iter()
        .map(|c| match c {
            TranscriptCommitment::Hash(ph) => {
                let direction = match ph.direction {
                    Direction::Sent => Some(TranscriptDirectionSummary::Sent),
                    Direction::Received => Some(TranscriptDirectionSummary::Recv),
                };

                let hash_alg = if ph.hash.alg == HashAlgId::SHA256 {
                    Some("Sha256".to_string())
                } else if ph.hash.alg == HashAlgId::BLAKE3 {
                    Some("Blake3".to_string())
                } else if ph.hash.alg == HashAlgId::KECCAK256 {
                    Some("Keccak256".to_string())
                } else {
                    Some("Unknown".to_string())
                };

                let hash_bytes = ph.hash.value.as_bytes();
                let hash_hex = Some(hex::encode(hash_bytes));
                let hash_len = Some(hash_bytes.len());

                let ranges: Vec<TranscriptCommitmentRangeSummary> = ph
                    .idx
                    .iter()
                    .map(|r| TranscriptCommitmentRangeSummary {
                        start: r.start,
                        end: r.end,
                    })
                    .collect();

                TranscriptCommitmentSummary {
                    kind: "Hash".to_string(),
                    direction,
                    hash_alg,
                    ranges: Some(ranges),
                    hash_hex,
                    hash_len,
                }
            }
            // TranscriptCommitment is #[non_exhaustive], so a catch-all is required
            _ => TranscriptCommitmentSummary {
                kind: "Unknown".to_string(),
                direction: None,
                hash_alg: None,
                ranges: None,
                hash_hex: None,
                hash_len: None,
            },
        })
        .collect()
}

/// Compress long sequences of redacted emojis for better readability
#[allow(unused)]
fn compress_redacted_sequences(text: String) -> String {
    let re = regex::Regex::new(r"█{5,}").unwrap();
    re.replace_all(&text, "█…█").to_string()
}

/// Render redacted bytes as `🙈`.
fn bytes_to_redacted_string(bytes: &[u8], to: &str) -> Result<String, eyre::ErrReport> {
    Ok(String::from_utf8(bytes.to_vec())
        .map_err(|err| eyre!("Failed to parse bytes to redacted string: {err}"))?
        .replace('\0', to))
}
