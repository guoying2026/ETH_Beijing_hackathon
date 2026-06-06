// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IPlatformVerifier
 * @notice Standardised interface that every payment-platform verifier must implement.
 *
 *         Both functions receive:
 *           proofsData  — abi.encode(TLSNProof[])  (one or more proofs, platform-specific)
 *           paramsData  — abi.encode(uint256 fiatAmountX1000,
 *                                    string  targetCurrency,
 *                                    uint256 orderDeadline,
 *                                    uint256 orderCreationTime)
 *
 *         orderDeadline    — Unix timestamp; payment must not be later than this.
 *         orderCreationTime — Unix timestamp (≈ orderDeadline − ORDER_TIMEOUT);
 *                             payment must not be earlier than this (prevents reuse of
 *                             old/expired-recipient transfers).
 *
 *         The platform verifier decodes what it needs from each blob.
 *         TLSNVerifier handles all cryptographic proof validation before calling here;
 *         platform verifiers only need to implement business-logic matching.
 *
 *         Adding a new payment platform requires:
 *           1. Deploy a new contract that implements this interface.
 *           2. Call TLSNVerifier.setPlatformVerifier(platformId, newAddress).
 *           No changes to TLSNVerifier or C2CEscrow are ever needed.
 */
interface IPlatformVerifier {
    /**
     * @notice Verify that a buyer paid the merchant (CRYPTO product).
     *         Called when a buyer submits payment proof to release escrowed crypto.
     * @param proofsData  abi.encode(TLSNProof[]) — proof array (platform-specific length)
     * @param paramsData  abi.encode(fiatAmountX1000, targetCurrency, orderDeadline, orderCreationTime)
     * @return txId       Platform-unique transaction ID (used for event logging / replay prevention)
     */
    function verifyBuyerPayment(
        bytes calldata proofsData,
        bytes calldata paramsData
    ) external returns (bytes32 txId);

    /**
     * @notice Verify that a merchant paid the buyer (FIAT product).
     *         Called when a merchant submits receipt proof to claim escrowed crypto.
     * @param proofsData  abi.encode(TLSNProof[]) — proof array (platform-specific length)
     * @param paramsData  abi.encode(fiatAmountX1000, targetCurrency, orderDeadline, orderCreationTime)
     * @return txId       Platform-unique transaction ID
     */
    function verifyMerchantSent(
        bytes calldata proofsData,
        bytes calldata paramsData
    ) external returns (bytes32 txId);
}
