// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../C2CTypes.sol";
import "../lib/TLSNParserLib.sol";
import "../interfaces/IPlatformVerifier.sol";

/**
 * @title AlipayPlatformVerifier
 * @notice Platform-specific verifier for Alipay payment proofs.
 *         Implements IPlatformVerifier so it can be registered in TLSNVerifier's
 *         platform registry without any changes to TLSNVerifier or C2CEscrow.
 *
 * @dev Proof layout (Alipay uses a single proof per payment):
 *        proofs[0] — Alipay order API proof
 *
 *      paramsData encoding (same standard used by all platforms):
 *        abi.encode(uint256 fiatAmountX1000,
 *                   string  targetCurrency,   ← not used by Alipay (ignored)
 *                   uint256 orderDeadline)
 *
 *      Key fields extracted from proof:
 *        payeeName        → counterpartyName
 *        payeeLoginEmail  → counterpartyHandle
 *        payAmount        → "250.00" (2 decimal places, converted to X1000)
 *        status           → "SUCCESS" (both buyer→merchant and merchant→buyer directions)
 *        bizType          → "TRANSFER"
 *        orderId          → string (replay prevention)
 *        gmtSuccess       → "YYYY-MM-DD HH:MM:SS" (UTC+8)
 *
 *      Replay prevention: usedAlipayOrderIds mapping (owns its own state).
 *      Only callable by the registered TLSNVerifier (onlyVerifier modifier).
 */
contract AlipayPlatformVerifier is IPlatformVerifier {
    // ── Alipay JSON key hashes ─────────────────────────────────────────────────
    bytes32 private constant KEY_PAY_AMOUNT        = keccak256("payAmount");
    bytes32 private constant KEY_STATUS            = keccak256("status");
    bytes32 private constant KEY_BIZ_TYPE          = keccak256("bizType");
    bytes32 private constant KEY_ORDER_ID          = keccak256("orderId");
    bytes32 private constant KEY_GMT_SUCCESS       = keccak256("gmtSuccess");

    // ── State ─────────────────────────────────────────────────────────────────
    address public immutable tlsnVerifier;

    /// @notice Alipay orderId replay prevention (hashed to save storage slot width)
    mapping(bytes32 => bool) public usedAlipayOrderIds;

    struct AlipayProofParsed {
        uint256 payAmountX1000;
        bytes statusBytes;
        bytes bizTypeBytes;
        bytes orderIdBytes;
        bytes gmtSuccessBytes;
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
     * @dev proofs[0] = Alipay order proof (buyer pays merchant, CRYPTO product).
     *      Validates payeeName/payeeLoginEmail match counterparty, amount, status="SUCCESS",
     *      bizType="TRANSFER", gmtSuccess before deadline.
     *      Returns keccak256(orderId) as txId.
     */
    function verifyBuyerPayment(
        bytes calldata proofsData,
        bytes calldata paramsData
    ) external onlyVerifier returns (bytes32 txId) {
        TLSNProof[] memory proofs = abi.decode(proofsData, (TLSNProof[]));
        (
            uint256 fiatAmountX1000,
            /* targetCurrency — not checked by Alipay */,
            uint256 orderDeadline,
            uint256 orderCreationTime
        ) = abi.decode(paramsData, (uint256, string, uint256, uint256));

        AlipayProofParsed memory p = _parseProofItems(proofs[0]);

        if (keccak256(p.statusBytes) != keccak256("SUCCESS"))
            revert AlipayPaymentNotCompleted();

        if (keccak256(p.bizTypeBytes) != keccak256("TRANSFER"))
            revert InvalidAlipayBizType();

        if (p.payAmountX1000 != fiatAmountX1000) revert PaymentAmountMismatch();

        txId = keccak256(p.orderIdBytes);
        if (usedAlipayOrderIds[txId]) revert DuplicateAlipayOrderId();
        usedAlipayOrderIds[txId] = true;

        uint256 paymentTimestamp = TLSNParserLib.parseDatetimeToUnix(p.gmtSuccessBytes);
        if (paymentTimestamp < orderCreationTime) revert AlipayTransferTooOld();
        if (paymentTimestamp > orderDeadline) revert AlipayTransferDateExpired();
    }

    /**
     * @inheritdoc IPlatformVerifier
     * @dev proofs[0] = Alipay order proof (merchant pays buyer, FIAT product).
     *      Account identity is verified off-chain by the Verifier server (accountCheck).
     *      Validates amount, status="SUCCESS", bizType="TRANSFER", gmtSuccess before deadline.
     *      Returns keccak256(orderId) as txId.
     */
    function verifyMerchantSent(
        bytes calldata proofsData,
        bytes calldata paramsData
    ) external onlyVerifier returns (bytes32 txId) {
        TLSNProof[] memory proofs = abi.decode(proofsData, (TLSNProof[]));
        (
            uint256 fiatAmountX1000,
            /* targetCurrency — not checked by Alipay */,
            uint256 orderDeadline,
            uint256 orderCreationTime
        ) = abi.decode(paramsData, (uint256, string, uint256, uint256));

        AlipayProofParsed memory p = _parseProofItems(proofs[0]);

        if (keccak256(p.statusBytes) != keccak256("SUCCESS"))
            revert AlipayPaymentNotCompleted();

        if (keccak256(p.bizTypeBytes) != keccak256("TRANSFER"))
            revert InvalidAlipayBizType();

        if (p.payAmountX1000 != fiatAmountX1000) revert ReceivedAmountMismatch();

        txId = keccak256(p.orderIdBytes);
        if (usedAlipayOrderIds[txId]) revert DuplicateAlipayOrderId();
        usedAlipayOrderIds[txId] = true;

        uint256 paymentTimestamp = TLSNParserLib.parseDatetimeToUnix(p.gmtSuccessBytes);
        if (paymentTimestamp < orderCreationTime) revert AlipayTransferTooOld();
        if (paymentTimestamp > orderDeadline) revert AlipayTransferDateExpired();
    }

    // ================================================================
    //                      Internal Parsing
    // ================================================================

    function _parseProofItems(
        TLSNProof memory proof
    ) internal pure returns (AlipayProofParsed memory p) {
        uint256 fieldFlags;

        for (uint256 i = 0; i < proof.revealedItems.length; i++) {
            bytes memory val = bytes(proof.revealedItems[i].value);
            if (val.length == 0 || val[0] != '"') continue;

            bytes32 keyHash = TLSNParserLib.parseKeyHash(val);
            if (keyHash == bytes32(0)) continue;

            if (keyHash == KEY_PAY_AMOUNT) {
                p.payAmountX1000 = TLSNParserLib.extractFiatAmount(val);
                fieldFlags |= 1;
            } else if (keyHash == KEY_STATUS) {
                p.statusBytes = TLSNParserLib.extractStringValue(val);
                fieldFlags |= 2;
            } else if (keyHash == KEY_BIZ_TYPE) {
                p.bizTypeBytes = TLSNParserLib.extractStringValue(val);
                fieldFlags |= 4;
            } else if (keyHash == KEY_ORDER_ID) {
                p.orderIdBytes = TLSNParserLib.extractStringValue(val);
                fieldFlags |= 8;
            } else if (keyHash == KEY_GMT_SUCCESS) {
                p.gmtSuccessBytes = TLSNParserLib.extractStringValue(val);
                fieldFlags |= 16;
            }
        }

        // 31 = 1|2|4|8|16 — payAmount, status, bizType, orderId, gmtSuccess required
        // (payeeName and payeeLoginEmail verified off-chain by Verifier accountCheck)
        if (fieldFlags != 31) revert MissingAlipayField();
    }
}
