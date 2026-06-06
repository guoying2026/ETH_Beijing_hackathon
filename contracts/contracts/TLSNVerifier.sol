// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import "./C2CTypes.sol";
import "./interfaces/IPlatformVerifier.sol";

/**
 * @title TLSNVerifier
 * @notice Core TLSN proof verifier + Platform Verifier Registry.
 *
 *         Responsibilities:
 *         1. Verify TLSN proof integrity (chainId, sessionId, commitments, verifier sig)
 *         2. Maintain platform verifier registry (platformId → IPlatformVerifier)
 *         3. Delegate platform-specific business matching to registered platform verifiers
 *            via verifyAndDelegate() — a single generic entry point that replaces all
 *            platform-specific wrapper methods.
 *
 *         Adding a new payment platform:
 *           - Deploy a contract implementing IPlatformVerifier.
 *           - Call setPlatformVerifier(newPlatformId, newAddress).
 *           - No changes to this contract are ever required.
 *
 *         Platform verifiers own their own state (replay maps, business logic) and
 *         are kept separate to stay under the EVM 24.5 KB contract size limit.
 */
contract TLSNVerifier {
    using ECDSA for bytes32;

    // ================================================================
    //                          Storage
    // ================================================================

    address public admin;
    address public pendingAdmin;

    mapping(address => bool) public trustedVerifiers;
    mapping(bytes32 => bool) public usedSessionIds;
    mapping(bytes32 => bool) public trustedKYBServers;
    mapping(bytes32 => bool) public trustedPaymentServers;

    /// @notice Authorized callers (C2CAdmin / C2CEscrow)
    mapping(address => bool) public authorizedCallers;

    /// @notice Platform Verifier Registry: platformId → verifier contract address
    mapping(bytes32 => address) public platformVerifiers;

    /// @notice Well-known platform IDs
    bytes32 public constant PLATFORM_WISE   = keccak256("wise");
    bytes32 public constant PLATFORM_ALIPAY = keccak256("alipay");

    uint256 private constant FIAT_DECIMALS_FACTOR = 100;

    // ================================================================
    //                          Events
    // ================================================================

    event TrustedVerifierAdded(address indexed verifier);
    event TrustedVerifierRemoved(address indexed verifier);
    event TrustedKYBServerAdded(string serverName);
    event TrustedKYBServerRemoved(string serverName);
    event TrustedPaymentServerAdded(string serverName);
    event TrustedPaymentServerRemoved(string serverName);
    event TLSNProofVerified(string indexed sessionId, address indexed verifier, string serverName);
    event AuthorizedCallerSet(address indexed caller, bool authorized);
    event AdminTransferProposed(address indexed currentAdmin, address indexed proposedAdmin);
    event AdminTransferAccepted(address indexed newAdmin);
    event PlatformVerifierSet(bytes32 indexed platformId, address indexed verifier);
    event PlatformPaymentVerified(bytes32 indexed platformId, bool isMerchantSent, bytes32 txId);

    // ================================================================
    //                         Modifiers
    // ================================================================

    modifier onlyAdmin() {
        if (msg.sender != admin) revert OnlyAdmin();
        _;
    }

    modifier onlyAuthorized() {
        require(msg.sender == admin || authorizedCallers[msg.sender], "not authorized");
        _;
    }

    // ================================================================
    //                        Constructor
    // ================================================================

    constructor() {
        admin = msg.sender;
    }

    // ================================================================
    //                      Admin Functions
    // ================================================================

    function proposeAdmin(address _newAdmin) external onlyAdmin {
        if (_newAdmin == address(0)) revert ZeroAddress();
        pendingAdmin = _newAdmin;
        emit AdminTransferProposed(admin, _newAdmin);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();
        admin = pendingAdmin;
        pendingAdmin = address(0);
        emit AdminTransferAccepted(admin);
    }

    function setAuthorizedCaller(address _caller, bool _authorized) external onlyAdmin {
        authorizedCallers[_caller] = _authorized;
        emit AuthorizedCallerSet(_caller, _authorized);
    }

    function addTrustedVerifier(address _verifier) external onlyAdmin {
        trustedVerifiers[_verifier] = true;
        emit TrustedVerifierAdded(_verifier);
    }

    function removeTrustedVerifier(address _verifier) external onlyAdmin {
        trustedVerifiers[_verifier] = false;
        emit TrustedVerifierRemoved(_verifier);
    }

    function addTrustedKYBServer(string calldata serverName) external onlyAdmin {
        trustedKYBServers[keccak256(bytes(serverName))] = true;
        emit TrustedKYBServerAdded(serverName);
    }

    function removeTrustedKYBServer(string calldata serverName) external onlyAdmin {
        trustedKYBServers[keccak256(bytes(serverName))] = false;
        emit TrustedKYBServerRemoved(serverName);
    }

    function addTrustedPaymentServer(string calldata serverName) external onlyAdmin {
        trustedPaymentServers[keccak256(bytes(serverName))] = true;
        emit TrustedPaymentServerAdded(serverName);
    }

    function removeTrustedPaymentServer(string calldata serverName) external onlyAdmin {
        trustedPaymentServers[keccak256(bytes(serverName))] = false;
        emit TrustedPaymentServerRemoved(serverName);
    }

    /**
     * @notice Register or update a platform verifier contract.
     * @param platformId  keccak256 of platform name, e.g. keccak256("alipay")
     * @param verifier    Address of the deployed platform verifier contract
     */
    function setPlatformVerifier(bytes32 platformId, address verifier) external onlyAdmin {
        if (verifier == address(0)) revert ZeroAddress();
        platformVerifiers[platformId] = verifier;
        emit PlatformVerifierSet(platformId, verifier);
    }

    // ================================================================
    //                   Core Verification (external)
    // ================================================================

    function verifyProof(TLSNProof calldata proof) external onlyAuthorized {
        _verifyTLSNProof(proof);
    }

    function verifyKYB(TLSNProof calldata proof) external onlyAuthorized {
        _verifyTLSNProof(proof);
        _matchMerchantKYBProof(proof);
    }

    // ================================================================
    //              Generic Platform Delegation (replaces all wrappers)
    // ================================================================

    /**
     * @notice Verify all TLSN proofs cryptographically, then delegate business-logic
     *         matching to the registered platform verifier for the given platformId.
     *
     *         This single function replaces all platform-specific wrapper methods.
     *         Adding a new payment platform requires only deploying a new
     *         IPlatformVerifier contract and calling setPlatformVerifier().
     *
     * @param platformId      keccak256 of platform name (e.g. PLATFORM_WISE, PLATFORM_ALIPAY)
     * @param isMerchantSent  false → buyer paid merchant (CRYPTO product)
     *                        true  → merchant paid buyer  (FIAT product)
     * @param proofs          Array of TLSNProofs. Each is cryptographically verified here
     *                        before being forwarded to the platform verifier.
     * @param paramsData      abi.encode(uint256 fiatAmountX1000,
     *                                   string  targetCurrency,
     *                                   uint256 orderDeadline,
     *                                   uint256 orderCreationTime)
     * @return txId           Platform-specific transaction ID returned by the platform verifier
     */
    function verifyAndDelegate(
        bytes32 platformId,
        bool isMerchantSent,
        TLSNProof[] calldata proofs,
        bytes calldata paramsData
    ) external onlyAuthorized returns (bytes32 txId) {
        // 1. Cryptographic verification + server trust for every proof
        for (uint256 i = 0; i < proofs.length; i++) {
            _verifyTLSNProof(proofs[i]);
            if (!trustedPaymentServers[keccak256(bytes(proofs[i].serverName))])
                revert NotTrustedPaymentServer();
        }

        // 2. Lookup platform verifier
        address verifier = platformVerifiers[platformId];
        if (verifier == address(0)) revert PlatformNotRegistered();

        // 3. ABI-encode proofs array and delegate to platform verifier
        bytes memory proofsData = abi.encode(proofs);

        if (isMerchantSent) {
            txId = IPlatformVerifier(verifier).verifyMerchantSent(proofsData, paramsData);
        } else {
            txId = IPlatformVerifier(verifier).verifyBuyerPayment(proofsData, paramsData);
        }

        emit PlatformPaymentVerified(platformId, isMerchantSent, txId);
    }

    // ================================================================
    //                   Internal Verification
    // ================================================================

    function _verifyTLSNProof(TLSNProof calldata proof) internal {
        if (proof.chainId != uint64(block.chainid)) revert WrongChainId();
        _checkAndMarkSessionId(proof.sessionId);
        _verifyCommitmentOpenings(proof);
        _verifyCommitmentsHash(proof);

        address signer = _recoverVerifierSigner(proof);
        if (!trustedVerifiers[signer]) revert UntrustedVerifier();
        emit TLSNProofVerified(proof.sessionId, signer, proof.serverName);
    }

    function _checkAndMarkSessionId(string calldata sessionId) internal {
        bytes32 sid = keccak256(bytes(sessionId));
        if (usedSessionIds[sid]) revert SessionAlreadyUsed();
        usedSessionIds[sid] = true;
    }

    function _verifyCommitmentOpenings(TLSNProof calldata proof) internal pure {
        if (proof.revealedItems.length != proof.commitmentOpenings.length)
            revert CommitmentOpeningMismatch();

        for (uint256 k = 0; k < proof.revealedItems.length; k++) {
            uint256 j = uint256(proof.revealedItems[k].commitment_index);
            if (j >= proof.commitments.length) revert CommitmentIndexOutOfBounds();

            bytes32 computed = keccak256(
                abi.encodePacked(
                    bytes(proof.revealedItems[k].value),
                    proof.commitmentOpenings[k].blinderHex
                )
            );
            if (computed != proof.commitments[j].hashValue) revert CommitmentOpeningMismatch();
        }
    }

    function _verifyCommitmentsHash(TLSNProof calldata proof) internal pure {
        bytes memory combined;
        for (uint256 i = 0; i < proof.commitments.length; i++) {
            combined = abi.encodePacked(combined, proof.commitments[i].hashValue);
        }
        if (keccak256(combined) != proof.commitmentsHash) revert CommitmentsHashMismatch();
    }

    function _recoverVerifierSigner(TLSNProof calldata proof) internal pure returns (address) {
        bytes32 sessionIdHash = keccak256(bytes(proof.sessionId));
        bytes32 messageHash = keccak256(
            abi.encodePacked(
                proof.chainId,
                sessionIdHash,
                proof.commitmentsHash,
                proof.orderBindingHash,
                proof.policyVersionHash
            )
        );
        bytes32 ethSignedHash = MessageHashUtils.toEthSignedMessageHash(messageHash);
        return ECDSA.recover(ethSignedHash, proof.verifierSignature);
    }

    // ================================================================
    //                    Business Matching (KYB only — payment
    //                    matching delegated to platform verifiers)
    // ================================================================

    function _matchMerchantKYBProof(TLSNProof calldata proof) internal view {
        if (!trustedKYBServers[keccak256(bytes(proof.serverName))]) revert NotTrustedKYBServer();
        if (proof.revealedItems.length < 1) revert MissingRevealedItems();
        bytes memory kycValue = _extractAndVerifyField(proof.revealedItems[0], true);
        if (keccak256(kycValue) != keccak256(bytes("verified"))) revert KYCNotVerified();
    }

    // ================================================================
    //                      Helper Functions
    // ================================================================

    function _extractAndVerifyField(
        TLSNRevealedItem calldata item,
        bool isStringType
    ) internal pure returns (bytes memory extracted) {
        bytes memory json = bytes(item.value);
        uint256 start = uint256(item.start_value);
        uint256 end = uint256(item.end_value);

        if (end <= start) revert InvalidValueRange();
        if (end > json.length) revert ValueRangeOutOfBounds();

        if (isStringType) {
            if (start < 1 || json[start - 1] != '"') revert LeftQuoteMissing();
            if (end >= json.length || json[end] != '"') revert RightQuoteMissing();
            if (end + 1 < json.length) {
                bytes1 next = json[end + 1];
                if (next != ',' && next != '}' && next != ']') revert RightBoundaryInvalid();
            }
        } else {
            if (end < json.length) {
                bytes1 next = json[end];
                if (next != ',' && next != '}' && next != ']') revert NumericRightBoundaryInvalid();
            }
        }

        extracted = new bytes(end - start);
        for (uint256 i = 0; i < end - start; i++) {
            extracted[i] = json[start + i];
        }
    }

    function _uint256ToFiatString(uint256 fiatAmount) internal pure returns (string memory) {
        uint256 intPart = fiatAmount / FIAT_DECIMALS_FACTOR;
        uint256 fracPart = fiatAmount % FIAT_DECIMALS_FACTOR;
        string memory intStr = Strings.toString(intPart);
        string memory fracStr = fracPart < 10
            ? string(abi.encodePacked("0", Strings.toString(fracPart)))
            : Strings.toString(fracPart);
        return string(abi.encodePacked(intStr, ".", fracStr));
    }
}
