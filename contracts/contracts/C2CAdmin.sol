// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import "./C2CTypes.sol";
import "./TLSNVerifier.sol";

/**
 * @title C2CAdmin
 * @notice 管理平台配置：admin 权限、支持资产列表、商家注册与法币账户。
 *         独立部署，C2CEscrow 通过引用读取。
 */
contract C2CAdmin {
    // ================================================================
    //                          Storage
    // ================================================================

    address public admin;
    address public pendingAdmin;

    TLSNVerifier public verifier;

    SupportCryptoInfo[] public supportCryptoList;
    SupportFiatInfo[] public supportFiatList;

    mapping(address => Merchant) public merchants;
    mapping(address => string) public merchantFiatAccounts;
    /// @notice 商家按平台存储的支付信息：merchant => platformId => PlatformBinding
    mapping(address => mapping(bytes32 => PlatformBinding)) public platformBindings;

    // 商家已发布汇率：merchant => productId => assetType(uint8) => MerchantRate
    mapping(address => mapping(uint256 => mapping(uint8 => MerchantRate)))
        public merchantRates;

    // 商家营业时间：merchant => productId => assetType(uint8) => BusinessHours
    mapping(address => mapping(uint256 => mapping(uint8 => BusinessHours)))
        public businessHours;

    // Maximum order size expressed as 18-decimal-normalised amount.
    // 1_000 * 1e18 ≡ "1000 whole tokens" regardless of the token's own decimal count.
    uint256 public maxOrderAmount = 1_000 * 1e18;

    /// @notice 授权的调用合约（如 C2CEscrow）
    mapping(address => bool) public authorizedCallers;

    // ================================================================
    //                          Events
    // ================================================================

    event SupportCryptoAdded(uint256 indexed cryptoId, address indexed tokenAddress, string tokenSymbol, bool isActive);
    event SupportFiatAdded(uint256 indexed fiatId, string fiatName, bool isActive);
    event SupportAssetStatusChanged(AssetType indexed assetType, uint256 indexed assetId, bool isActive, address indexed operator);
    event AdminTransferProposed(address indexed currentAdmin, address indexed proposedAdmin);
    event AdminTransferAccepted(address indexed newAdmin);
    event MerchantRegistered(address indexed merchant, uint256 registeredAt);
    event MerchantFiatAccountSet(address indexed merchant, string account);
    event PlatformBindingSet(
        address indexed wallet,
        bytes32 indexed platformId,
        bytes32 nameHash,
        bytes32 idHash
    );
    event RatePublished(
        address indexed merchant,
        uint256 indexed productId,
        uint8 indexed assetType,
        uint256 rate,
        uint32 version,
        uint64 expiresAt
    );
    event BusinessHoursSet(
        address indexed merchant,
        uint256 indexed productId,
        uint8 indexed assetType,
        uint32 openSecond,
        uint32 closeSecond,
        uint8 activeDays,
        uint8 manualOverride
    );
    event ManualOverrideSet(
        address indexed merchant,
        uint256 indexed productId,
        uint8 indexed assetType,
        uint8 manualOverride
    );
    event MaxOrderAmountUpdated(uint256 newAmount);

    // ================================================================
    //                         Modifiers
    // ================================================================

    modifier onlyAdmin() {
        if (msg.sender != admin) revert OnlyAdmin();
        _;
    }

    // ================================================================
    //                        Constructor
    // ================================================================

    constructor(address _verifier) {
        admin = msg.sender;
        verifier = TLSNVerifier(_verifier);
    }

    // ================================================================
    //                      Admin Transfer
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

    // ================================================================
    //                  Supported Asset Management
    // ================================================================

    function addCryptoInfo(address _tokenAddress, bool _isActive) external onlyAdmin {
        string memory _tokenSymbol = IERC20Metadata(_tokenAddress).symbol();
        uint256 cryptoId = supportCryptoList.length;
        supportCryptoList.push(
            SupportCryptoInfo({
                id: cryptoId,
                tokenSymbol: _tokenSymbol,
                tokenAddress: _tokenAddress,
                assetType: AssetType.CRYPTO,
                isActive: _isActive
            })
        );
        emit SupportCryptoAdded(cryptoId, _tokenAddress, _tokenSymbol, _isActive);
    }

    function addFiatInfo(string calldata _fiatName, bool _isActive) external onlyAdmin {
        uint256 fiatId = supportFiatList.length;
        supportFiatList.push(
            SupportFiatInfo({
                id: fiatId,
                fiatName: _fiatName,
                assetType: AssetType.FIAT,
                isActive: _isActive
            })
        );
        emit SupportFiatAdded(fiatId, _fiatName, _isActive);
    }

    function activateAsset(uint256 _id, AssetType _assetType) external onlyAdmin {
        if (_assetType == AssetType.CRYPTO) {
            if (_id >= supportCryptoList.length) revert WrongId();
            if (supportCryptoList[_id].isActive) revert AlreadyActive();
            supportCryptoList[_id].isActive = true;
        } else {
            if (_id >= supportFiatList.length) revert WrongId();
            if (supportFiatList[_id].isActive) revert AlreadyActive();
            supportFiatList[_id].isActive = true;
        }
        emit SupportAssetStatusChanged(_assetType, _id, true, msg.sender);
    }

    function deactivateAsset(uint256 _id, AssetType _assetType) external onlyAdmin {
        if (_assetType == AssetType.CRYPTO) {
            if (_id >= supportCryptoList.length) revert WrongId();
            if (!supportCryptoList[_id].isActive) revert AlreadyInactive();
            supportCryptoList[_id].isActive = false;
        } else {
            if (_id >= supportFiatList.length) revert WrongId();
            if (!supportFiatList[_id].isActive) revert AlreadyInactive();
            supportFiatList[_id].isActive = false;
        }
        emit SupportAssetStatusChanged(_assetType, _id, false, msg.sender);
    }

    // ================================================================
    //                      View Functions
    // ================================================================

    function getSupportCryptoInfo(uint256 _id) external view returns (SupportCryptoInfo memory) {
        if (_id >= supportCryptoList.length) revert WrongId();
        return supportCryptoList[_id];
    }

    function getSupportFiatInfo(uint256 _id) external view returns (SupportFiatInfo memory) {
        if (_id >= supportFiatList.length) revert WrongId();
        return supportFiatList[_id];
    }

    function getSupportCryptoList() external view returns (SupportCryptoInfo[] memory) {
        return supportCryptoList;
    }

    function getSupportFiatList() external view returns (SupportFiatInfo[] memory) {
        return supportFiatList;
    }

    function getCryptoTokenAddress(uint256 _cryptoID) external view returns (address) {
        if (_cryptoID >= supportCryptoList.length) revert WrongId();
        return supportCryptoList[_cryptoID].tokenAddress;
    }

    function getSupportCryptoCount() external view returns (uint256) {
        return supportCryptoList.length;
    }

    function getSupportFiatCount() external view returns (uint256) {
        return supportFiatList.length;
    }

    // ================================================================
    //                     Merchant Functions
    // ================================================================

    function registerMerchant(TLSNProof calldata proof) external {
        if (merchants[msg.sender].isActive) revert AlreadyRegistered();
        verifier.verifyKYB(proof);
        merchants[msg.sender] = Merchant({
            isActive: true,
            kybVerified: true,
            registeredAt: block.timestamp,
            sellCryptoAmount: 0,
            sellFiatAmount: 0
        });
        emit MerchantRegistered(msg.sender, block.timestamp);
    }

    function registerMerchantByAdmin(address _merchant) external onlyAdmin {
        if (_merchant == address(0)) revert ZeroAddress();
        if (merchants[_merchant].isActive) revert AlreadyRegistered();
        merchants[_merchant] = Merchant({
            isActive: true,
            kybVerified: true,
            registeredAt: block.timestamp,
            sellCryptoAmount: 0,
            sellFiatAmount: 0
        });
        emit MerchantRegistered(_merchant, block.timestamp);
    }

    function setMerchantFiatAccount(string calldata account) external {
        if (!merchants[msg.sender].isActive) revert NotMerchant();
        if (bytes(account).length == 0) revert EmptyAccount();
        merchantFiatAccounts[msg.sender] = account;
        emit MerchantFiatAccountSet(msg.sender, account);
    }

    function getMerchantFiatAccount(address _merchant) external view returns (string memory) {
        return merchantFiatAccounts[_merchant];
    }

    /// @notice 任意钱包为指定平台设置支付账号绑定（nameHash + idHash）。
    /// @dev    商家与买家共用同一 mapping —— buyer 也通过本函数自助绑定 (R3/R9)。
    ///         链上仅存 commit，明文与 salt 由服务器 DB 持有。
    /// @param _platformId  keccak256 of platform name，必须已在 TLSNVerifier 中注册
    /// @param _nameHash    keccak256(normalize(displayName))，不能为 0
    /// @param _idHash      keccak256(normalize(email / handle / account))，不能为 0
    function setPlatformBinding(
        bytes32 _platformId,
        bytes32 _nameHash,
        bytes32 _idHash
    ) external {
        if (verifier.platformVerifiers(_platformId) == address(0)) revert PlatformNotRegistered();
        if (_nameHash == bytes32(0) || _idHash == bytes32(0)) revert EmptyAccount();

        platformBindings[msg.sender][_platformId] = PlatformBinding({
            nameHash: _nameHash,
            idHash:   _idHash,
            isSet:    true
        });
        emit PlatformBindingSet(msg.sender, _platformId, _nameHash, _idHash);
    }

    /// @notice 读取商家在指定平台的支付信息。
    /// @param _merchant   商家地址
    /// @param _platformId keccak256 of platform name
    /// @return PlatformBinding struct（若未设置则 isSet == false）
    function getPlatformBinding(
        address _merchant,
        bytes32 _platformId
    ) external view returns (PlatformBinding memory) {
        return platformBindings[_merchant][_platformId];
    }

    function isMerchantActive(address _merchant) external view returns (bool) {
        Merchant storage m = merchants[_merchant];
        return m.isActive && m.kybVerified;
    }

    // ================================================================
    //                   Rate & Business Hours Functions
    // ================================================================

    /// @notice Merchant publishes or updates the exchange rate for a product.
    /// @param _rate Exchange rate encoded as: fiat_price_per_whole_token × 10^8
    ///              Example: 4.70 MYR per 1 USDT → _rate = 470_000_000
    ///              This encoding is token-decimal-agnostic.
    /// @dev ⚠️  MIGRATION: After the C2CEscrow contract upgrade that introduced
    ///      RATE_PRECISION_EXP = 8, all existing rates must be re-published.
    ///      Old CRYPTO encoding (rate = fiatPrice × 1e18) is incompatible.
    ///      Old FIAT encoding (rate = fiatPrice × 100) is incompatible.
    function publishRate(
        uint256 _productId,
        uint8 _assetType,
        uint256 _rate,
        uint64 _expiresAt
    ) external {
        if (!merchants[msg.sender].isActive) revert NotMerchant();
        if (_expiresAt != 0 && _expiresAt <= block.timestamp) revert RateExpired();
        MerchantRate storage mr = merchantRates[msg.sender][_productId][_assetType];
        mr.version++;
        mr.rate = _rate;
        mr.publishedAt = uint64(block.timestamp);
        mr.expiresAt = _expiresAt;
        emit RatePublished(msg.sender, _productId, _assetType, _rate, mr.version, _expiresAt);
    }

    /// @notice 商家设置营业时间表（UTC 秒）
    function setBusinessHours(
        uint256 _productId,
        uint8 _assetType,
        uint32 _openSecond,
        uint32 _closeSecond,
        uint8 _activeDays
    ) external {
        if (!merchants[msg.sender].isActive) revert NotMerchant();
        BusinessHours storage bh = businessHours[msg.sender][_productId][_assetType];
        uint8 override_ = bh.manualOverride; // preserve manualOverride
        bh.openSecond = _openSecond;
        bh.closeSecond = _closeSecond;
        bh.activeDays = _activeDays;
        bh.manualOverride = override_;
        emit BusinessHoursSet(msg.sender, _productId, _assetType, _openSecond, _closeSecond, _activeDays, override_);
    }

    /// @notice 强制开门（忽略时间表）
    function openNow(uint256 _productId, uint8 _assetType) external {
        if (!merchants[msg.sender].isActive) revert NotMerchant();
        businessHours[msg.sender][_productId][_assetType].manualOverride = 1;
        emit ManualOverrideSet(msg.sender, _productId, _assetType, 1);
    }

    /// @notice 强制关门（忽略时间表）
    function closeNow(uint256 _productId, uint8 _assetType) external {
        if (!merchants[msg.sender].isActive) revert NotMerchant();
        businessHours[msg.sender][_productId][_assetType].manualOverride = 2;
        emit ManualOverrideSet(msg.sender, _productId, _assetType, 2);
    }

    /// @notice 清除手动覆盖，回归时间表模式
    function clearManualOverride(uint256 _productId, uint8 _assetType) external {
        if (!merchants[msg.sender].isActive) revert NotMerchant();
        businessHours[msg.sender][_productId][_assetType].manualOverride = 0;
        emit ManualOverrideSet(msg.sender, _productId, _assetType, 0);
    }

    /// @notice 查询商家当前是否营业（供 C2CEscrow 调用）
    function isMerchantOpen(
        address _merchant,
        uint256 _productId,
        uint8 _assetType
    ) external view returns (bool) {
        BusinessHours storage bh = businessHours[_merchant][_productId][_assetType];
        if (bh.manualOverride == 2) return false;
        if (bh.manualOverride == 1) return true;
        // 根据时间表判断
        uint256 weekday = (block.timestamp / 86400 + 3) % 7; // 0=周一
        if (bh.activeDays & (1 << weekday) == 0) return false;
        uint32 daySecond = uint32(block.timestamp % 86400);
        bool crossMidnight = bh.closeSecond < bh.openSecond;
        if (crossMidnight) {
            return daySecond >= bh.openSecond || daySecond < bh.closeSecond;
        } else {
            return daySecond >= bh.openSecond && daySecond < bh.closeSecond;
        }
    }

    /// @notice 读取商家当前有效汇率
    function getMerchantRate(
        address _merchant,
        uint256 _productId,
        uint8 _assetType
    ) external view returns (MerchantRate memory) {
        return merchantRates[_merchant][_productId][_assetType];
    }

    /// @notice Admin 设置单笔最大金额上限
    function setMaxOrderAmount(uint256 _amount) external onlyAdmin {
        maxOrderAmount = _amount;
        emit MaxOrderAmountUpdated(_amount);
    }

    /**
     * @notice 递增商家的产品计数器并返回新 productID（仅授权合约可调用）
     */
    function incrementSellCount(address _merchant, AssetType _assetType) external returns (uint256 newId) {
        if (!authorizedCallers[msg.sender]) revert NotAuthorizedCaller();
        Merchant storage m = merchants[_merchant];
        if (_assetType == AssetType.CRYPTO) {
            newId = m.sellCryptoAmount;
            m.sellCryptoAmount++;
        } else {
            newId = m.sellFiatAmount;
            m.sellFiatAmount++;
        }
    }

    function setAuthorizedCaller(address _caller, bool _authorized) external onlyAdmin {
        authorizedCallers[_caller] = _authorized;
    }
}
