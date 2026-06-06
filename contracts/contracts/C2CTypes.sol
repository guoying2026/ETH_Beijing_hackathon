// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ================================================================
//                    Shared Enums & Structs
// ================================================================

enum AssetType {
    CRYPTO,
    FIAT
}

enum OrderStatus {
    PENDING,
    EXPIRED,
    COMPLETED,
    WAITING
}

struct SupportCryptoInfo {
    uint256 id;
    string tokenSymbol;
    address tokenAddress;
    AssetType assetType;
    bool isActive;
}

struct SupportFiatInfo {
    uint256 id;
    string fiatName;
    AssetType assetType;
    bool isActive;
}

struct TLSNRevealedItem {
    string handlerType;
    string part;
    string value;
    uint64 commitment_index;
    uint64 start_item;
    uint64 end_item;
    uint64 start_value;
    uint64 end_value;
}

struct TLSNCommitmentOpening {
    bytes blinderHex;
}

struct TLSNCommitment {
    string direction;
    string hashAlg;
    bytes32 hashValue;
}

struct TLSNProof {
    uint64 chainId;
    string sessionId;
    bytes32 commitmentsHash;
    /// @dev keccak256(abi.encodePacked(escrow, chainId, merchant, buyer, productId, orderId, assetType, amount, rate, deadline))
    bytes32 orderBindingHash;
    /// @dev keccak256(policyVersion as UTF-8), or bytes32(0) if absent
    bytes32 policyVersionHash;
    bytes verifierSignature;
    TLSNRevealedItem[] revealedItems;
    TLSNCommitmentOpening[] commitmentOpenings;
    TLSNCommitment[] commitments;
    string serverName;
}

struct Merchant {
    bool isActive;
    bool kybVerified;
    uint256 registeredAt;
    uint256 sellCryptoAmount;
    uint256 sellFiatAmount;
}

struct PlatformBinding {
    bytes32 nameHash;  // keccak256(normalize(displayName))
    bytes32 idHash;    // keccak256(normalize(email / handle))
    bool isSet;
}

struct BuyerPaymentInfo {
    bytes32 nameHash;  // keccak256(normalize(displayName))
    bytes32 idHash;    // keccak256(normalize(email / handle))
    bool isSet;
}

struct MerchantRate {
    uint256 rate;         // 汇率值，精度同现有 Order.rate
    uint32  version;      // 单调递增版本号，第一次发布后 == 1；0 表示未发布
    uint64  publishedAt;  // 发布时间戳 (block.timestamp)
    uint64  expiresAt;    // 过期时间戳；0 = 永不过期
}

struct BusinessHours {
    uint32  openSecond;     // 开门时间（UTC 秒，相对当天零点，0–86399）
    uint32  closeSecond;    // 关门时间（UTC 秒）
    uint8   activeDays;     // bitmask：bit0=周一 … bit6=周日
    uint8   manualOverride; // 0=自动(遵循时间表) 1=强制开 2=强制关
}

// ================================================================
//                       Custom Errors
// ================================================================

error ZeroAddress();
error OnlyAdmin();
error NotPendingAdmin();
error WrongId();
error AlreadyActive();
error AlreadyInactive();
error AlreadyRegistered();
error NotMerchant();
error EmptyAccount();
error ProductInactive();
error AssetTypeMismatch();
error TooManyPending();
error AlreadyHasActiveOrder();
error ZeroAmount();
error InsufficientAvailable();
error BuyerMismatch();
error RateNotPublished();
error RateExpired();
error ExceedsUsdCap();
error MerchantClosed();
error RateVersionMismatch();
error OrderNotFound();
error NotPending();
error NotWaiting();
error NotAllowed();
error OutOfDeadline();
error NotYetExpired();
error UntrustedVerifier();
error SessionAlreadyUsed();
error WrongChainId();
error CommitmentOpeningMismatch();
error CommitmentsHashMismatch();
error CommitmentIndexOutOfBounds();
error InvalidValueRange();
error ValueRangeOutOfBounds();
error LeftQuoteMissing();
error RightQuoteMissing();
error RightBoundaryInvalid();
error NumericRightBoundaryInvalid();
error MissingRevealedItems();
error KYCNotVerified();
error PaymentAmountMismatch();
error RecipientAccountMismatch();
error PaymentNotCompleted();
error ReceivedAmountMismatch();
error NotTrustedKYBServer();
error NotTrustedPaymentServer();
error CurrencyMismatch();
error InsufficientPendingLocked();
error InvalidKeyValueFormat();
error DuplicateTransferId();
error TransferDateExpired();
error RecipientMismatch();
error MissingWiseField();
error MissingAlipayField();
error DuplicateAlipayOrderId();
error AlipayPaymentNotCompleted();
error AlipayTransferDateExpired();
error InvalidAlipayBizType();
error PlatformNotRegistered();
error BuyerPaymentInfoRequired();
error BuyerPaymentInfoNotSet();
error OrderBindingHashMismatch();
error AlipayTransferTooOld();
error WiseTransferTooOld();
error MerchantBindingNotSet();
error SelfTradeNotAllowed();
error BuyerBindingNotSet();
error BuyerBindingMismatch();
error ContractPaused();

// ── V4: Bond & Risk errors ────────────────────────────────────────
error NotAuthorizedCaller();
error InvalidDatetimeFormat();
error InvalidBps();
error OrderCancellationDisabled();
error UserBlacklisted();
error UserTemporarilyFrozen();
error OnlyEscrow();
error InvalidManagerAddress();
error ManagersNotSet();
error OrderBondNotFound();
error OrderBondAlreadyInitialized();
error OrderBondAlreadySettled();
error BatchSizeInvalid();
