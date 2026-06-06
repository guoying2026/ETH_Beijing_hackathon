// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./C2CTypes.sol";
import "./C2CAdmin.sol";
import "./interfaces/IC2CBondVault.sol";

contract C2CBondVault is IC2CBondVault {
    using SafeERC20 for IERC20;

    struct OrderBondState {
        address token;        // 保证金代币
        address prover;       // 存入保证金的一方（需要证明的人）
        address counterpart;  // 另一方
        uint256 bond;         // 保证金金额
        bool    initialized;
        bool    settled;
    }

    C2CAdmin public adminContract;
    address  public escrow;
    address  public pendingEscrow;

    mapping(bytes32 => OrderBondState) public orderBonds;
    mapping(address => mapping(address => uint256)) private _claimable;

    event OrderBondCreated(bytes32 indexed orderKey, address token, address prover, address counterpart, uint256 bond);
    event OrderBondSettled(bytes32 indexed orderKey, SettlementType stype, address recipient, uint256 amount);
    event ClaimableIncreased(address indexed user, address indexed token, uint256 amount);
    event Claimed(address indexed user, address indexed token, uint256 amount);
    event EscrowMigrated(address indexed oldEscrow, address indexed newEscrow);

    modifier onlyEscrow() {
        if (msg.sender != escrow) revert OnlyEscrow();
        _;
    }

    modifier onlyAdmin() {
        if (adminContract.admin() != msg.sender) revert OnlyAdmin();
        _;
    }

    constructor(address _adminContract) {
        if (_adminContract == address(0)) revert ZeroAddress();
        adminContract = C2CAdmin(_adminContract);
    }

    function setEscrow(address _escrow) external onlyAdmin {
        if (_escrow == address(0)) revert InvalidManagerAddress();
        escrow = _escrow;
    }

    function proposeMigrateEscrow(address newEscrow) external onlyAdmin {
        if (newEscrow == address(0)) revert InvalidManagerAddress();
        pendingEscrow = newEscrow;
    }

    function acceptMigrateEscrow() external {
        if (msg.sender != pendingEscrow) revert NotAllowed();
        emit EscrowMigrated(escrow, pendingEscrow);
        escrow        = pendingEscrow;
        pendingEscrow = address(0);
    }

    function createOrderBond(
        bytes32 orderKey,
        address token,
        address prover,
        address counterpart,
        uint256 bond
    ) external onlyEscrow {
        OrderBondState storage s = orderBonds[orderKey];
        if (s.initialized) revert OrderBondAlreadyInitialized();
        s.token       = token;
        s.prover      = prover;
        s.counterpart = counterpart;
        s.bond        = bond;
        s.initialized = true;
        emit OrderBondCreated(orderKey, token, prover, counterpart, bond);
    }

    function settle(bytes32 orderKey, SettlementType stype) external onlyEscrow {
        OrderBondState storage s = orderBonds[orderKey];
        if (!s.initialized) revert OrderBondNotFound();
        if (s.settled)      revert OrderBondAlreadySettled();

        address recipient = stype == SettlementType.PROOF_SUCCESS ? s.prover : s.counterpart;
        if (s.bond > 0) _credit(recipient, s.token, s.bond);

        s.settled = true;
        emit OrderBondSettled(orderKey, stype, recipient, s.bond);
    }

    function settle(bytes32 orderKey, SettlementType stype, uint256 proverExtra, uint256 counterpartExtra) external onlyEscrow {
        OrderBondState storage s = orderBonds[orderKey];
        if (!s.initialized) revert OrderBondNotFound();
        if (s.settled)      revert OrderBondAlreadySettled();

        if (stype == SettlementType.PROOF_SUCCESS) {
            _credit(s.prover, s.token, s.bond + proverExtra);
        } else {
            _credit(s.counterpart, s.token, s.bond + counterpartExtra);
            if (proverExtra > 0) _credit(s.prover, s.token, proverExtra);
        }

        s.settled = true;
        address recipient = stype == SettlementType.PROOF_SUCCESS ? s.prover : s.counterpart;
        emit OrderBondSettled(orderKey, stype, recipient, s.bond);
    }

    // ── Storage warm-up ──────────────────────────────────────────
    // Call initClaimable() for the user+token pair before the first expected
    // settlement. Writes sentinel=1 so the slot stays non-zero permanently,
    // turning every subsequent _credit write from cold (20,000 gas) to warm
    // (2,900 gas). claim() preserves the sentinel so the slot never returns
    // to zero. Only needs to be called once per user+token pair.

    function initClaimable(address user, address token) external {
        if (_claimable[user][token] == 0) {
            _claimable[user][token] = 1;
        }
    }

    function claim(address token) external returns (uint256 amount) {
        uint256 raw = _claimable[msg.sender][token];
        if (raw <= 1) return 0;          // sentinel only, nothing to claim
        amount = raw - 1;                // subtract sentinel from actual balance
        _claimable[msg.sender][token] = 1; // preserve sentinel so slot stays non-zero
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, token, amount);
    }

    function claimableBalance(address user, address token) external view returns (uint256) {
        uint256 raw = _claimable[user][token];
        return raw <= 1 ? 0 : raw - 1;  // hide sentinel from external callers
    }

    function _credit(address user, address token, uint256 amount) internal {
        if (amount == 0) return;
        _claimable[user][token] += amount;
        emit ClaimableIncreased(user, token, amount);
    }
}
