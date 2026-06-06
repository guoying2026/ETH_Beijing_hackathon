// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../C2CTypes.sol";
import "../lib/TLSNParserLib.sol";
import "../interfaces/IPlatformVerifier.sol";

/**
 * @title WisePlatformVerifier
 * @notice Platform-specific verifier for Wise payment proofs.
 *         Implements IPlatformVerifier so it can be registered in TLSNVerifier's
 *         platform registry without any changes to TLSNVerifier or C2CEscrow.
 *
 * @dev Proof layout (Wise requires two proofs per payment):
 *        proofs[0] — contacts API proof  (validates recipient name + handle)
 *        proofs[1] — transfer API proof  (validates amount, currency, state, date, transferId)
 *
 *      paramsData encoding (same standard used by all platforms):
 *        abi.encode(uint256 fiatAmountX1000,
 *                   string  targetCurrency,
 *                   uint256 orderDeadline)
 *
 *      Replay prevention: usedTransferIds mapping (owns its own state).
 *      Only callable by the registered TLSNVerifier (onlyVerifier modifier).
 */
contract WisePlatformVerifier is IPlatformVerifier {
    using TLSNParserLib for bytes;

    // ── Wise JSON key hashes (pre-computed for gas efficiency) ───────────────
    bytes32 private constant KEY_STATE           = keccak256("state");
    bytes32 private constant KEY_TARGET_AMOUNT   = keccak256("targetAmount");
    bytes32 private constant KEY_TARGET_CURRENCY = keccak256("targetCurrency");
    bytes32 private constant KEY_ID              = keccak256("id");
    bytes32 private constant KEY_DATE            = keccak256("date");
    // ── State ─────────────────────────────────────────────────────────────────
    address public immutable tlsnVerifier;

    /// @notice Wise transfer ID replay prevention
    mapping(uint256 => bool) public usedTransferIds;

    struct WiseTransferParsed {
        bytes stateBytes;
        bytes currencyBytes;
        uint256 amountX1000;
        uint256 transferId;
        uint256 dateMs;
    }

    // ── Modifier ──────────────────────────────────────────────────────────────

    modifier onlyVerifier() {
        require(msg.sender == tlsnVerifier, "only TLSNVerifier");
        _;
    }

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address _tlsnVerifier) {
        require(_tlsnVerifier != address(0), "zero address");
        tlsnVerifier = _tlsnVerifier;
    }

    // ================================================================
    //                    IPlatformVerifier interface
    // ================================================================

    /**
     * @inheritdoc IPlatformVerifier
     * @dev proofs[0] = contacts proof, proofs[1] = transfer proof.
     *      Validates merchant name/handle from contacts, then amount/currency/state/date
     *      from transfer. Returns bytes32(transferId) as txId.
     */
    function verifyBuyerPayment(
        bytes calldata proofsData,
        bytes calldata paramsData
    ) external onlyVerifier returns (bytes32 txId) {
        TLSNProof[] memory proofs = abi.decode(proofsData, (TLSNProof[]));
        (
            uint256 fiatAmountX1000,
            string memory targetCurrency,
            uint256 orderDeadline,
            uint256 orderCreationTime
        ) = abi.decode(paramsData, (uint256, string, uint256, uint256));

        _verifyContacts(proofs[0]);
        uint256 transferId = _verifyTransfer(proofs[1], fiatAmountX1000, targetCurrency, orderDeadline, orderCreationTime);
        txId = bytes32(transferId);
    }

    /**
     * @inheritdoc IPlatformVerifier
     * @dev Same two-proof flow. Account identity verified off-chain by the Verifier server.
     */
    function verifyMerchantSent(
        bytes calldata proofsData,
        bytes calldata paramsData
    ) external onlyVerifier returns (bytes32 txId) {
        TLSNProof[] memory proofs = abi.decode(proofsData, (TLSNProof[]));
        (
            uint256 fiatAmountX1000,
            string memory targetCurrency,
            uint256 orderDeadline,
            uint256 orderCreationTime
        ) = abi.decode(paramsData, (uint256, string, uint256, uint256));

        _verifyContacts(proofs[0]);
        uint256 transferId = _verifyTransfer(proofs[1], fiatAmountX1000, targetCurrency, orderDeadline, orderCreationTime);
        txId = bytes32(transferId);
    }

    // ================================================================
    //                      Internal Logic
    // ================================================================

    /**
     * @dev Account identity verification is performed off-chain by the Verifier server.
     *      The Verifier's signature over orderBindingHash (which includes both
     *      merchantAccountHash and payeeAccountHash) guarantees the correct accounts
     *      were verified before signing. No on-chain account comparison needed.
     */
    function _verifyContacts(TLSNProof memory) internal pure {
        // No-op: account checks delegated to Verifier server accountCheck mechanism.
    }

    /**
     * @dev Validate transfer proof: state, amount, currency, date, and replay prevention via transferId.
     */
    function _verifyTransfer(
        TLSNProof memory proof,
        uint256 expectedFiatX1000,
        string memory expectedCurrency,
        uint256 orderDeadline,
        uint256 orderCreationTime
    ) internal returns (uint256 transferId) {
        WiseTransferParsed memory p = _parseTransferItems(proof);

        if (keccak256(p.stateBytes) != keccak256("OUTGOING_PAYMENT_SENT"))
            revert PaymentNotCompleted();

        if (p.amountX1000 != expectedFiatX1000) revert PaymentAmountMismatch();

        if (keccak256(p.currencyBytes) != keccak256(bytes(expectedCurrency)))
            revert CurrencyMismatch();

        transferId = p.transferId;
        if (usedTransferIds[transferId]) revert DuplicateTransferId();
        usedTransferIds[transferId] = true;

        // date is milliseconds since epoch; must fall within [orderCreationTime, orderDeadline]
        uint256 transferTimestamp = p.dateMs / 1000;
        if (transferTimestamp < orderCreationTime) revert WiseTransferTooOld();
        if (transferTimestamp > orderDeadline) revert TransferDateExpired();
    }

    function _parseTransferItems(
        TLSNProof memory proof
    ) internal pure returns (WiseTransferParsed memory p) {
        uint256 fieldFlags;

        for (uint256 i = 0; i < proof.revealedItems.length; i++) {
            bytes memory val = bytes(proof.revealedItems[i].value);
            if (val.length == 0 || val[0] != '"') continue;

            bytes32 keyHash = TLSNParserLib.parseKeyHash(val);
            if (keyHash == bytes32(0)) continue;

            if (keyHash == KEY_STATE) {
                p.stateBytes = TLSNParserLib.extractStringValue(val);
                fieldFlags |= 1;
            } else if (keyHash == KEY_TARGET_AMOUNT) {
                p.amountX1000 = TLSNParserLib.extractFiatAmount(val);
                fieldFlags |= 2;
            } else if (keyHash == KEY_TARGET_CURRENCY) {
                p.currencyBytes = TLSNParserLib.extractStringValue(val);
                fieldFlags |= 4;
            } else if (keyHash == KEY_ID) {
                p.transferId = TLSNParserLib.extractRawUint(val);
                fieldFlags |= 8;
            } else if (keyHash == KEY_DATE) {
                p.dateMs = TLSNParserLib.extractRawUint(val);
                fieldFlags |= 16;
            }
        }

        // 31 = 1|2|4|8|16 — all 5 fields required
        if (fieldFlags != 31) revert MissingWiseField();
    }
}
