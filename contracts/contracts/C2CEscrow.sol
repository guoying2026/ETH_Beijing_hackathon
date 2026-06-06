// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./C2CTypes.sol";
import "./C2CAdmin.sol";
import "./TLSNVerifier.sol";
import "./lib/UintQueue.sol";
import "./interfaces/IC2CRiskManager.sol";
import "./interfaces/IC2CBondVault.sol";

/**
 * @title C2CEscrow (V4 — 双边公平惩罚)
 * @notice 产品上架 + 订单生命周期管理。
 *         V4 新增：
 *           - 每笔订单自动计算并锁定保证金（BondVault）
 *           - CRYPTO 买家存保证金；FIAT 商家保证金从 collateral 划出
 *           - 超时 → PROOF_TIMEOUT → 保证金归对手方
 *           - 成功 → PROOF_SUCCESS → 保证金退回 prover
 *           - cancelOrder 禁用
 *           - 争议函数全部删除
 */
contract C2CEscrow is ReentrancyGuard {
    using UintQueue for UintQueue.Queue;
    using SafeERC20 for IERC20;

    // ================================================================
    //                       External Refs
    // ================================================================

    C2CAdmin        public adminContract;
    TLSNVerifier    public verifier;
    IC2CRiskManager public riskManager;
    IC2CBondVault   public bondVault;

    // cryptoId => 买家保证金代币（address(0) = 使用同交易代币）
    mapping(uint256 => address) public cryptoBuyerBondToken;

    // ================================================================
    //                       Product Storage
    // ================================================================

    struct Order {
        address buyer;
        uint256 amount;
        uint256 rate;
        uint32  rateVersion;
        uint256 deadline;
        OrderStatus status;
        bytes32 merchantNameHash;
        bytes32 merchantIdHash;
        bytes32 platformTxId;
        uint256 bondAmount;
        uint16  bondBpsSnapshot;
    }

    struct Product {
        uint256 productID;
        uint256 cryptoID;
        uint256 fiatID;
        AssetType assetType;
        bytes32 platformId;
        uint256 collateralAmount;
        uint256 pendingAmount;
        uint256 buyerEscrowedAmount;
        bool isActive;
        uint256 nextOrderId;
        uint256 activeOrderCount;
        UintQueue.Queue pendingOrderIds;
        mapping(uint256 => Order) orders;
    }

    mapping(address => Product[]) private merchantsProductCrypto;
    mapping(address => Product[]) private merchantsProductFiat;

    struct SweepTarget {
        address merchant;
        uint256 productId;
        AssetType assetType;
        uint256 maxSteps; // 0 = MAX_PENDING_ORDERS
    }

    // ================================================================
    //                    Buyer Payment Info Storage
    // ================================================================

    mapping(address => mapping(uint256 => mapping(uint256 => BuyerPaymentInfo)))
        private buyerOrderPaymentInfo;

    // ================================================================
    //                        Order Storage
    // ================================================================

    mapping(address => mapping(address => mapping(uint8 => mapping(uint256 => bool)))) public hasActiveOrder;
    mapping(address => bool) public hasEverOrdered;

    uint256 public constant MAX_PENDING_ORDERS = 200;
    uint256 public constant MAX_SWEEP_BATCH    = 20;
    uint256 private constant ORDER_TIMEOUT     = 15 minutes;

    uint256 private constant RATE_PRECISION_EXP = 8;

    bool public paused;

    // ================================================================
    //                          Events
    // ================================================================

    event ProductListed(
        address indexed merchant,
        uint256 indexed productId,
        AssetType indexed assetType,
        uint256 cryptoID,
        uint256 fiatID,
        uint256 collateralAmount,
        bool isActive
    );
    event ProductStatusChanged(
        address indexed merchant,
        uint256 indexed productId,
        AssetType indexed assetType,
        bool isActive
    );
    event ProductCollateralChanged(
        address indexed merchant,
        uint256 indexed productId,
        AssetType indexed assetType,
        int256 delta,
        uint256 collateralAmount,
        uint256 pendingAmount,
        uint256 buyerEscrowedAmount
    );
    event OrderPlaced(
        address indexed buyer,
        address indexed merchant,
        uint256 indexed orderId,
        uint256 productId,
        AssetType assetType,
        uint256 amount,
        uint256 rate,
        uint256 deadline,
        uint256 salt
    );
    event BuyerPaymentInfoSet(
        address indexed buyer,
        address indexed merchant,
        uint256 indexed orderId,
        bytes32 nameHash,
        bytes32 idHash
    );
    event OrderStatusChanged(
        address indexed buyer,
        address indexed merchant,
        uint256 indexed orderId,
        uint256 productId,
        AssetType assetType,
        OrderStatus status,
        uint256 deadline
    );
    event BuyerEscrowDeposited(
        address indexed buyer,
        address indexed merchant,
        uint256 indexed orderId,
        uint256 productId,
        uint256 amount,
        uint256 totalBuyerEscrowedAmount
    );
    event OrderProofLinked(
        address indexed buyer,
        address indexed merchant,
        uint256 indexed orderId,
        uint256 productId,
        bytes32 platformTxId,
        string  sessionId
    );
    event Paused(address indexed operator);
    event Unpaused(address indexed operator);
    event ExpiredSwept(
        address indexed caller,
        address indexed merchant,
        uint256 indexed productId,
        AssetType assetType,
        uint256 cleanedCount
    );

    // ================================================================
    //                         Modifiers
    // ================================================================

    modifier onlyMerchant() {
        if (!adminContract.isMerchantActive(msg.sender)) revert NotMerchant();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    // ================================================================
    //                        Constructor
    // ================================================================

    constructor(address _adminContract, address _verifier) {
        adminContract = C2CAdmin(_adminContract);
        verifier = TLSNVerifier(_verifier);
    }

    // ================================================================
    //                     Admin Management
    // ================================================================

    function setManagers(address _riskManager, address _bondVault) external {
        if (adminContract.admin() != msg.sender) revert OnlyAdmin();
        if (_riskManager == address(0) || _bondVault == address(0)) revert InvalidManagerAddress();
        riskManager = IC2CRiskManager(_riskManager);
        bondVault   = IC2CBondVault(_bondVault);
    }

    function setCryptoBuyerBondToken(uint256 cryptoId, address bondToken) external {
        if (adminContract.admin() != msg.sender) revert OnlyAdmin();
        cryptoBuyerBondToken[cryptoId] = bondToken;
    }

    function pause() external {
        if (adminContract.admin() != msg.sender) revert OnlyAdmin();
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external {
        if (adminContract.admin() != msg.sender) revert OnlyAdmin();
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ================================================================
    //                     Product Functions
    // ================================================================

    function _getTokenAddress(uint256 _cryptoID) internal view returns (address) {
        return adminContract.getCryptoTokenAddress(_cryptoID);
    }

    function _computeFiatAmountX1000(
        uint256 amountRaw,
        uint256 rate,
        uint256 cryptoID
    ) internal view returns (uint256) {
        address tokenAddr = _getTokenAddress(cryptoID);
        uint8 decimals = IERC20Metadata(tokenAddr).decimals();
        uint256 denominator = 10 ** (uint256(decimals) + RATE_PRECISION_EXP);
        return Math.mulDiv(amountRaw * 1000, rate, denominator);
    }

    function listCryptoProduct(
        uint256 _cryptoID,
        uint256 _fiatID,
        uint256 _amount,
        bool _isActive,
        bytes32 _platformId
    ) external onlyMerchant {
        if (_cryptoID >= adminContract.getSupportCryptoCount()) revert WrongId();
        if (_fiatID >= adminContract.getSupportFiatCount()) revert WrongId();

        address tokenAddress = _getTokenAddress(_cryptoID);
        IERC20(tokenAddress).safeTransferFrom(msg.sender, address(this), _amount);

        uint256 pid = adminContract.incrementSellCount(msg.sender, AssetType.CRYPTO);
        Product storage p = merchantsProductCrypto[msg.sender].push();
        p.productID = pid;
        p.cryptoID = _cryptoID;
        p.fiatID = _fiatID;
        p.assetType = AssetType.CRYPTO;
        p.platformId = _platformId;
        p.collateralAmount = _amount;
        p.isActive = _isActive;

        emit ProductListed(msg.sender, pid, AssetType.CRYPTO, _cryptoID, _fiatID, _amount, _isActive);
    }

    function listFiatProduct(
        uint256 _fiatID,
        uint256 _cryptoID,
        uint256 _amount,
        bool _isActive,
        bytes32 _platformId
    ) external onlyMerchant {
        if (_fiatID >= adminContract.getSupportFiatCount()) revert WrongId();
        if (_cryptoID >= adminContract.getSupportCryptoCount()) revert WrongId();

        address tokenAddress = _getTokenAddress(_cryptoID);
        IERC20(tokenAddress).safeTransferFrom(msg.sender, address(this), _amount);

        uint256 pid = adminContract.incrementSellCount(msg.sender, AssetType.FIAT);
        Product storage p = merchantsProductFiat[msg.sender].push();
        p.productID = pid;
        p.cryptoID = _cryptoID;
        p.fiatID = _fiatID;
        p.assetType = AssetType.FIAT;
        p.platformId = _platformId;
        p.collateralAmount = _amount;
        p.isActive = _isActive;

        emit ProductListed(msg.sender, pid, AssetType.FIAT, _cryptoID, _fiatID, _amount, _isActive);
    }

    function activeProduct(uint256 _id, AssetType _assetType) external onlyMerchant {
        Product storage p = _getOwnProduct(_id, _assetType);
        if (p.isActive) revert AlreadyActive();
        p.isActive = true;
        emit ProductStatusChanged(msg.sender, p.productID, _assetType, true);
    }

    function inactiveProduct(uint256 _id, AssetType _assetType) external onlyMerchant {
        Product storage p = _getOwnProduct(_id, _assetType);
        if (!p.isActive) revert AlreadyInactive();
        p.isActive = false;
        emit ProductStatusChanged(msg.sender, p.productID, _assetType, false);
    }

    function addAmount(uint256 _id, AssetType _assetType, uint256 _amount) external onlyMerchant {
        Product storage p = _getOwnProduct(_id, _assetType);
        address tokenAddress = _getTokenAddress(p.cryptoID);
        IERC20(tokenAddress).safeTransferFrom(msg.sender, address(this), _amount);
        p.collateralAmount += _amount;
        emit ProductCollateralChanged(
            msg.sender, p.productID, _assetType,
            int256(_amount), p.collateralAmount, p.pendingAmount, p.buyerEscrowedAmount
        );
    }

    function takeAmount(uint256 _id, AssetType _assetType, uint256 _amount) external onlyMerchant {
        Product storage p = _getOwnProduct(_id, _assetType);
        uint256 available = p.collateralAmount - p.pendingAmount;
        if (_amount > available) revert InsufficientPendingLocked();

        address tokenAddress = _getTokenAddress(p.cryptoID);
        IERC20(tokenAddress).safeTransfer(msg.sender, _amount);
        p.collateralAmount -= _amount;
        emit ProductCollateralChanged(
            msg.sender, p.productID, _assetType,
            -int256(_amount), p.collateralAmount, p.pendingAmount, p.buyerEscrowedAmount
        );
    }

    // ================================================================
    //                   Internal Product Helpers
    // ================================================================

    function _getOwnProduct(uint256 _id, AssetType _assetType) internal view returns (Product storage) {
        return _getProduct(msg.sender, _id, _assetType);
    }

    function _getProduct(
        address _merchant,
        uint256 _productID,
        AssetType _assetType
    ) internal view returns (Product storage) {
        if (_assetType == AssetType.CRYPTO) {
            if (_productID >= merchantsProductCrypto[_merchant].length) revert WrongId();
            return merchantsProductCrypto[_merchant][_productID];
        }
        if (_productID >= merchantsProductFiat[_merchant].length) revert WrongId();
        return merchantsProductFiat[_merchant][_productID];
    }

    function _availableAmount(Product storage p) internal view returns (uint256) {
        return p.collateralAmount - p.pendingAmount;
    }

    // ================================================================
    //                   Order Binding Helpers
    // ================================================================

    function _computeOrderBindingHash(
        address _merchant,
        address _buyer,
        uint256 _productId,
        uint256 _orderId,
        AssetType _assetType,
        uint256 _amount,
        uint256 _rate,
        uint32  _rateVersion,
        uint256 _deadline,
        bytes32 _merchantNameHash,
        bytes32 _merchantIdHash,
        bytes32 _payeeNameHash,
        bytes32 _payeeIdHash
    ) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(
            address(this),
            uint64(block.chainid),
            _merchant,
            _buyer,
            _productId,
            _orderId,
            uint8(_assetType),
            _amount,
            _rate,
            _rateVersion,
            _deadline,
            _merchantNameHash,
            _merchantIdHash,
            _payeeNameHash,
            _payeeIdHash
        ));
    }

    function getBuyerPaymentInfo(
        address _merchant,
        uint256 _productId,
        uint256 _orderId
    ) external view returns (BuyerPaymentInfo memory) {
        return buyerOrderPaymentInfo[_merchant][_productId][_orderId];
    }

    function _requireOrderBinding(TLSNProof calldata proof, bytes32 expectedHash) internal pure {
        if (proof.orderBindingHash != expectedHash) revert OrderBindingHashMismatch();
    }

    // ================================================================
    //                   Internal Bond Helper
    // ================================================================

    function _orderKey(
        address merchant,
        uint256 productId,
        AssetType assetType,
        uint256 orderId
    ) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(
            address(this), block.chainid, merchant, productId, uint8(assetType), orderId
        ));
    }

    // ================================================================
    //                       Order Functions
    // ================================================================

    function placeOrder(
        address _merchant,
        uint256 _productId,
        AssetType _assetType,
        uint256 _amount,
        BuyerPaymentInfo calldata _buyerInfo
    ) external whenNotPaused {
        // R4: 商家不能下自己的单
        if (msg.sender == _merchant) revert SelfTradeNotAllowed();

        // 基础校验
        if (address(riskManager) == address(0) || address(bondVault) == address(0))
            revert ManagersNotSet();

        Product storage p = _getProduct(_merchant, _productId, _assetType);
        if (!p.isActive) revert ProductInactive();
        if (!adminContract.isMerchantOpen(_merchant, _productId, uint8(_assetType))) revert MerchantClosed();

        _cleanupExpired(p, _merchant);

        if (p.activeOrderCount >= MAX_PENDING_ORDERS) revert TooManyPending();
        if (hasActiveOrder[msg.sender][_merchant][uint8(_assetType)][_productId]) revert AlreadyHasActiveOrder();
        if (_amount == 0) revert ZeroAmount();

        // USD 上限校验
        {
            address tokenAddr = _getTokenAddress(p.cryptoID);
            uint8 dec = IERC20Metadata(tokenAddr).decimals();
            uint256 normalised = dec <= 18
                ? _amount * (10 ** (18 - dec))
                : _amount / (10 ** (dec - 18));
            if (normalised > adminContract.maxOrderAmount()) revert ExceedsUsdCap();
        }

        MerchantRate memory mr = adminContract.getMerchantRate(_merchant, _productId, uint8(_assetType));
        if (mr.publishedAt == 0) revert RateNotPublished();
        if (mr.expiresAt != 0 && block.timestamp > mr.expiresAt) revert RateExpired();

        PlatformBinding memory merchantPayInfo =
            adminContract.getPlatformBinding(_merchant, p.platformId);
        if (!merchantPayInfo.isSet) revert MerchantBindingNotSet();

        // R3: buyer 必须已在该 platform 绑定（链上 commit）
        PlatformBinding memory buyerBound =
            adminContract.getPlatformBinding(msg.sender, p.platformId);
        if (!buyerBound.isSet) revert BuyerBindingNotSet();

        hasActiveOrder[msg.sender][_merchant][uint8(_assetType)][_productId] = true;
        uint256 oid = p.nextOrderId++;
        uint256 deadline = block.timestamp + ORDER_TIMEOUT;
        if (!hasEverOrdered[msg.sender]) hasEverOrdered[msg.sender] = true;

        if (_assetType == AssetType.CRYPTO) {
            // CRYPTO 分支：merchant collateral 需覆盖订单金额
            if (_availableAmount(p) < _amount) revert InsufficientAvailable();

            // V4: 双方都需通过黑名单/冻结校验
            riskManager.requiredBondBps(_merchant); // 触发商家黑名单/冻结校验
            uint16 bondBps = riskManager.requiredBondBps(msg.sender);
            uint256 bond   = Math.mulDiv(_amount, bondBps, 10_000);

            address bondToken = cryptoBuyerBondToken[p.cryptoID];
            if (bondToken == address(0)) bondToken = _getTokenAddress(p.cryptoID);

            p.orders[oid] = Order({
                buyer:            msg.sender,
                amount:           _amount,
                rate:             mr.rate,
                rateVersion:      mr.version,
                deadline:         deadline,
                status:           OrderStatus.PENDING,
                merchantNameHash: merchantPayInfo.nameHash,
                merchantIdHash:   merchantPayInfo.idHash,
                platformTxId:     bytes32(0),
                bondAmount:       bond,
                bondBpsSnapshot:  bondBps
            });

            bytes32 ok = _orderKey(_merchant, _productId, _assetType, oid);
            if (bond > 0) {
                IERC20(bondToken).safeTransferFrom(msg.sender, address(bondVault), bond);
                bondVault.createOrderBond(ok, bondToken, msg.sender, _merchant, bond);
            }

            p.pendingOrderIds.enqueue(oid);
            p.pendingAmount += _amount;
            p.activeOrderCount++;
            emit OrderPlaced(msg.sender, _merchant, oid, _productId, _assetType, _amount, mr.rate, deadline, 0);
            emit OrderStatusChanged(msg.sender, _merchant, oid, _productId, _assetType, OrderStatus.PENDING, deadline);
        } else {
            // FIAT 分支：商家保证金从 collateral 划拨到 BondVault
            riskManager.requiredBondBps(msg.sender); // 触发黑名单/冻结校验
            uint16 bondBps = riskManager.requiredBondBps(_merchant);
            uint256 bond   = Math.mulDiv(_amount, bondBps, 10_000);

            // collateral 需覆盖订单金额（pendingAmount 净增量 = _amount - bond）
            if (_availableAmount(p) < _amount) revert InsufficientAvailable();

            if (_buyerInfo.nameHash == bytes32(0) || _buyerInfo.idHash == bytes32(0)) revert BuyerPaymentInfoRequired();
            // R3: FIAT 路径 _buyerInfo 必须与 buyer 链上 binding 一致
            if (_buyerInfo.nameHash != buyerBound.nameHash ||
                _buyerInfo.idHash   != buyerBound.idHash) {
                revert BuyerBindingMismatch();
            }
            buyerOrderPaymentInfo[_merchant][_productId][oid] = BuyerPaymentInfo({
                nameHash: _buyerInfo.nameHash,
                idHash:   _buyerInfo.idHash,
                isSet:    true
            });

            address tokenAddress = _getTokenAddress(p.cryptoID);
            IERC20(tokenAddress).safeTransferFrom(msg.sender, address(this), _amount);
            p.buyerEscrowedAmount += _amount;

            bytes32 ok = _orderKey(_merchant, _productId, _assetType, oid);
            if (bond > 0) {
                IERC20(tokenAddress).safeTransfer(address(bondVault), bond);
                p.collateralAmount -= bond;
                bondVault.createOrderBond(ok, tokenAddress, _merchant, msg.sender, bond);
            }

            p.orders[oid] = Order({
                buyer:            msg.sender,
                amount:           _amount,
                rate:             mr.rate,
                rateVersion:      mr.version,
                deadline:         deadline,
                status:           OrderStatus.WAITING,
                merchantNameHash: merchantPayInfo.nameHash,
                merchantIdHash:   merchantPayInfo.idHash,
                platformTxId:     bytes32(0),
                bondAmount:       bond,
                bondBpsSnapshot:  bondBps
            });

            p.pendingOrderIds.enqueue(oid);
            p.pendingAmount += (_amount - bond);
            p.activeOrderCount++;
            emit BuyerEscrowDeposited(msg.sender, _merchant, oid, _productId, _amount, p.buyerEscrowedAmount);
            emit BuyerPaymentInfoSet(msg.sender, _merchant, oid, _buyerInfo.nameHash, _buyerInfo.idHash);
            emit OrderPlaced(msg.sender, _merchant, oid, _productId, _assetType, _amount, mr.rate, deadline, 0);
            emit OrderStatusChanged(msg.sender, _merchant, oid, _productId, _assetType, OrderStatus.WAITING, deadline);
        }
    }

    function cleanupProductExpired(
        address _merchant,
        uint256 _productId,
        AssetType _assetType
    ) external {
        Product storage p = _getProduct(_merchant, _productId, _assetType);
        _cleanupExpired(p, _merchant);
    }

    /// @notice V4: cancelOrder 已禁用。
    function cancelOrder(address, uint256, AssetType, uint256) external pure {
        revert OrderCancellationDisabled();
    }

    // ================================================================
    //          Platform Payment — CRYPTO product (buyer pays fiat)
    // ================================================================

    function payOrderByPlatform(
        address _merchant,
        uint256 _productId,
        uint256 _orderId,
        TLSNProof[] calldata proofs
    ) external whenNotPaused {
        Product storage p = _getProduct(_merchant, _productId, AssetType.CRYPTO);
        Order storage o = p.orders[_orderId];
        _requireBuyerPending(o);
        if (block.timestamp > o.deadline) revert OutOfDeadline();

        uint256 fiatAmountX1000 = _computeFiatAmountX1000(o.amount, o.rate, p.cryptoID);
        string memory targetCurrency = adminContract.getSupportFiatInfo(p.fiatID).fiatName;

        bytes32 expectedBinding = _computeOrderBindingHash(
            _merchant, o.buyer, _productId, _orderId,
            AssetType.CRYPTO, o.amount, o.rate, o.rateVersion, o.deadline,
            o.merchantNameHash, o.merchantIdHash,
            o.merchantNameHash, o.merchantIdHash
        );
        for (uint256 i = 0; i < proofs.length; i++) {
            _requireOrderBinding(proofs[i], expectedBinding);
        }

        bytes memory paramsData = abi.encode(
            fiatAmountX1000,
            targetCurrency,
            o.deadline,
            o.deadline - ORDER_TIMEOUT
        );

        bytes32 txId = verifier.verifyAndDelegate(p.platformId, false, proofs, paramsData);
        o.platformTxId = txId;

        address tokenAddress = _getTokenAddress(p.cryptoID);
        IERC20(tokenAddress).safeTransfer(o.buyer, o.amount);

        p.pendingAmount -= o.amount;
        p.collateralAmount -= o.amount;
        p.activeOrderCount--;
        o.status = OrderStatus.COMPLETED;

        // V4: 保证金退回买家
        bytes32 ok = _orderKey(_merchant, _productId, AssetType.CRYPTO, _orderId);
        if (o.bondAmount > 0) bondVault.settle(ok, SettlementType.PROOF_SUCCESS);
        riskManager.onCompleted(o.buyer);

        emit OrderProofLinked(o.buyer, _merchant, _orderId, _productId, txId, proofs[proofs.length - 1].sessionId);
        emit OrderStatusChanged(o.buyer, _merchant, _orderId, _productId, AssetType.CRYPTO, OrderStatus.COMPLETED, o.deadline);
        emit ProductCollateralChanged(
            _merchant, p.productID, AssetType.CRYPTO,
            -int256(o.amount), p.collateralAmount, p.pendingAmount, p.buyerEscrowedAmount
        );
        _releaseActive(o.buyer, _merchant, p.assetType, _productId);
        _cleanupExpired(p, _merchant);
    }

    // ================================================================
    //          Platform Payment — FIAT product (merchant pays fiat)
    // ================================================================

    function receiveCryptoWithPlatformPayment(
        uint256 _productId,
        uint256 _orderId,
        TLSNProof[] calldata proofs
    ) external whenNotPaused {
        address _merchant = msg.sender;
        Product storage p = _getProduct(_merchant, _productId, AssetType.FIAT);
        Order storage o = p.orders[_orderId];
        if (block.timestamp > o.deadline) revert OutOfDeadline();
        if (o.status != OrderStatus.WAITING) revert NotWaiting();

        BuyerPaymentInfo storage buyerInfo = buyerOrderPaymentInfo[_merchant][_productId][_orderId];
        if (!buyerInfo.isSet) revert BuyerPaymentInfoNotSet();

        uint256 fiatAmountX1000 = _computeFiatAmountX1000(o.amount, o.rate, p.cryptoID);
        string memory targetCurrency = adminContract.getSupportFiatInfo(p.fiatID).fiatName;

        bytes32 expectedBinding = _computeOrderBindingHash(
            _merchant, o.buyer, _productId, _orderId,
            AssetType.FIAT, o.amount, o.rate, o.rateVersion, o.deadline,
            o.merchantNameHash, o.merchantIdHash,
            buyerInfo.nameHash, buyerInfo.idHash
        );
        for (uint256 i = 0; i < proofs.length; i++) {
            _requireOrderBinding(proofs[i], expectedBinding);
        }

        bytes memory paramsData = abi.encode(
            fiatAmountX1000,
            targetCurrency,
            o.deadline,
            o.deadline - ORDER_TIMEOUT
        );

        bytes32 txId = verifier.verifyAndDelegate(p.platformId, true, proofs, paramsData);
        o.platformTxId = txId;

        address tokenAddress = _getTokenAddress(p.cryptoID);
        IERC20(tokenAddress).safeTransfer(_merchant, o.amount);

        uint256 stake = o.amount - o.bondAmount;
        p.buyerEscrowedAmount -= o.amount;
        p.pendingAmount -= stake;
        p.collateralAmount -= stake;
        p.activeOrderCount--;
        o.status = OrderStatus.COMPLETED;

        delete buyerOrderPaymentInfo[_merchant][_productId][_orderId];

        // V4: 保证金 + 质押归还商家（FIAT unified claim via BondVault）
        bytes32 ok = _orderKey(_merchant, _productId, AssetType.FIAT, _orderId);
        if (o.bondAmount > 0) {
            IERC20(tokenAddress).safeTransfer(address(bondVault), stake);
            bondVault.settle(ok, SettlementType.PROOF_SUCCESS, stake, 0);
        } else if (stake > 0) {
            IERC20(tokenAddress).safeTransfer(_merchant, stake);
        }
        riskManager.onCompleted(_merchant);

        emit OrderProofLinked(o.buyer, _merchant, _orderId, _productId, txId, proofs[proofs.length - 1].sessionId);
        emit OrderStatusChanged(o.buyer, _merchant, _orderId, _productId, AssetType.FIAT, OrderStatus.COMPLETED, o.deadline);
        emit ProductCollateralChanged(
            _merchant, p.productID, AssetType.FIAT,
            -int256(stake), p.collateralAmount, p.pendingAmount, p.buyerEscrowedAmount
        );
        _releaseActive(o.buyer, _merchant, p.assetType, _productId);
        _cleanupExpired(p, _merchant);
    }

    // ================================================================
    //                    View Functions
    // ================================================================

    function getOrder(
        address _merchant,
        uint256 _productId,
        uint8 _assetType,
        uint256 _orderId
    ) external view returns (
        address buyer,
        uint256 amount,
        uint256 rate,
        uint256 deadline,
        uint8 status,
        uint32 rateVersion,
        bytes32 platformTxId,
        bytes32 merchantNameHash,
        bytes32 merchantIdHash
    ) {
        Product storage p = _getProduct(_merchant, _productId, AssetType(_assetType));
        Order storage o = p.orders[_orderId];
        return (
            o.buyer, o.amount, o.rate, o.deadline,
            uint8(o.status), o.rateVersion, o.platformTxId,
            o.merchantNameHash, o.merchantIdHash
        );
    }

    function getProductPlatformId(
        address _merchant,
        uint256 _productId,
        AssetType _assetType
    ) external view returns (bytes32) {
        return _getProduct(_merchant, _productId, _assetType).platformId;
    }

    struct ProductView {
        uint256 productId;
        uint256 cryptoID;
        uint256 fiatID;
        uint8   assetType;
        bytes32 platformId;
        uint256 collateralAmount;
        uint256 pendingAmount;
        uint256 availableAmount;
        bool    isActive;
        uint256 activeOrderCount;
    }

    function getProductInfo(
        address _merchant,
        uint256 _productId,
        uint8   _assetType
    ) external view returns (ProductView memory) {
        Product storage p = _getProduct(_merchant, _productId, AssetType(_assetType));
        return ProductView({
            productId:        p.productID,
            cryptoID:         p.cryptoID,
            fiatID:           p.fiatID,
            assetType:        uint8(p.assetType),
            platformId:       p.platformId,
            collateralAmount: p.collateralAmount,
            pendingAmount:    p.pendingAmount,
            availableAmount:  _availableAmount(p),
            isActive:         p.isActive,
            activeOrderCount: p.activeOrderCount
        });
    }

    // ================================================================
    //                    Internal Order Helpers
    // ================================================================

    function _releaseActive(address buyer, address merchant, AssetType assetType, uint256 productId) internal {
        delete hasActiveOrder[buyer][merchant][uint8(assetType)][productId];
    }

    function _requireBuyerPending(Order storage o) internal view {
        if (o.buyer == address(0)) revert OrderNotFound();
        if (o.status != OrderStatus.PENDING) revert NotPending();
        if (msg.sender != o.buyer) revert NotAllowed();
    }

    function _cleanupExpired(Product storage p, address merchant) internal {
        _cleanupExpiredBounded(p, merchant, MAX_PENDING_ORDERS);
    }

    function _cleanupExpiredBounded(
        Product storage p,
        address merchant,
        uint256 maxSteps
    ) internal {
        uint256 steps = 0;
        while (!p.pendingOrderIds.isEmpty() && steps < maxSteps) {
            uint256 oid = p.pendingOrderIds.peek();
            Order storage o = p.orders[oid];

            // 清理已终结订单（COMPLETED / EXPIRED）
            if (o.status != OrderStatus.PENDING && o.status != OrderStatus.WAITING) {
                p.pendingOrderIds.dequeue();
                delete buyerOrderPaymentInfo[merchant][p.productID][oid];
                delete p.orders[oid];
                steps++;
                continue;
            }

            if (o.deadline > block.timestamp) break;

            // FIAT 商家超时：买家通过 BondVault claim 本金+bond；商家可 claim 质押
            if (o.status == OrderStatus.WAITING) {
                address tokenAddress = _getTokenAddress(p.cryptoID);
                uint256 stake = o.amount - o.bondAmount;
                p.buyerEscrowedAmount -= o.amount;
                p.collateralAmount -= stake;
                bytes32 ok = _orderKey(merchant, p.productID, p.assetType, oid);
                if (o.bondAmount > 0) {
                    IERC20(tokenAddress).safeTransfer(address(bondVault), o.amount + stake);
                    bondVault.settle(ok, SettlementType.PROOF_TIMEOUT, stake, o.amount);
                } else {
                    IERC20(tokenAddress).safeTransfer(o.buyer, o.amount);
                    if (stake > 0) IERC20(tokenAddress).safeTransfer(merchant, stake);
                }
                riskManager.onTimeout(merchant);
            }

            // CRYPTO 买家超时：买家保证金归商家
            if (o.status == OrderStatus.PENDING) {
                bytes32 ok = _orderKey(merchant, p.productID, p.assetType, oid);
                if (o.bondAmount > 0) bondVault.settle(ok, SettlementType.PROOF_TIMEOUT);
                riskManager.onTimeout(o.buyer);
            }

            uint256 pendingDeduct = o.status == OrderStatus.WAITING ? o.amount - o.bondAmount : o.amount;
            o.status = OrderStatus.EXPIRED;
            p.pendingAmount -= pendingDeduct;
            p.activeOrderCount--;
            p.pendingOrderIds.dequeue();
            emit OrderStatusChanged(o.buyer, merchant, oid, p.productID, p.assetType, OrderStatus.EXPIRED, o.deadline);
            _releaseActive(o.buyer, merchant, p.assetType, p.productID);
            delete buyerOrderPaymentInfo[merchant][p.productID][oid];
            delete p.orders[oid];
            steps++;
        }
    }

    // ================================================================
    //                  Public Sweep (anyone-callable)
    // ================================================================

    function sweepExpired(
        address merchant,
        uint256 productId,
        AssetType assetType,
        uint256 maxSteps
    ) external whenNotPaused nonReentrant returns (uint256 cleaned) {
        Product storage p = _getProduct(merchant, productId, assetType);
        uint256 before_ = p.activeOrderCount;
        _cleanupExpiredBounded(p, merchant, maxSteps == 0 ? MAX_PENDING_ORDERS : maxSteps);
        cleaned = before_ - p.activeOrderCount;
        if (cleaned > 0) {
            emit ExpiredSwept(msg.sender, merchant, productId, assetType, cleaned);
        }
    }

    function sweepExpiredBatch(SweepTarget[] calldata targets)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 totalCleaned)
    {
        uint256 len = targets.length;
        if (len == 0 || len > MAX_SWEEP_BATCH) revert BatchSizeInvalid();
        for (uint256 i = 0; i < len; ) {
            SweepTarget calldata t = targets[i];
            Product storage p = _getProduct(t.merchant, t.productId, t.assetType);
            uint256 before_ = p.activeOrderCount;
            _cleanupExpiredBounded(
                p,
                t.merchant,
                t.maxSteps == 0 ? MAX_PENDING_ORDERS : t.maxSteps
            );
            uint256 cleaned = before_ - p.activeOrderCount;
            totalCleaned += cleaned;
            if (cleaned > 0) {
                emit ExpiredSwept(msg.sender, t.merchant, t.productId, t.assetType, cleaned);
            }
            unchecked { ++i; }
        }
    }
}
