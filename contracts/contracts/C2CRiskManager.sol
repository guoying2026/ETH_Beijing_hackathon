// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./C2CTypes.sol";
import "./C2CAdmin.sol";
import "./interfaces/IC2CRiskManager.sol";
import "./interfaces/IC2CRiskManagerAdmin.sol";

contract C2CRiskManager is IC2CRiskManager, IC2CRiskManagerAdmin {

    struct Reputation {
        uint32 completedCount;
        uint32 timeoutCount;
        uint8  consecutiveTimeouts;
        uint8  completedSinceLastTimeout;
        uint8  riskLevel;
        bool   temporarilyFrozen;
        bool   blacklisted;
        uint64 frozenUntil;
        uint64 lastTimeoutAt;
        // Warm-up sentinel: set to true by initReputation() so the slot is non-zero
        // before onTimeout/onCompleted, avoiding a 20,000-gas cold SSTORE.
        // Total struct: 30 bytes → still packed in one storage slot.
        bool   initialized;
    }

    C2CAdmin public adminContract;
    address  public escrow;
    address  public pendingEscrow;

    uint16 public minBondBps               = 500;
    uint16 public baseBondBps              = 1000;
    uint16 public maxBondBps               = 10000;
    uint16 public stepBps                  = 300;
    uint8  public maxRiskLevel             = 10;
    uint8  public resetThreshold           = 3;
    uint32 public freezeThreshold          = 15;
    uint32 public freezeDays               = 30;
    uint32 public rewardCompletedThreshold = 10;
    uint32 public decayIntervalDays        = 90;

    mapping(address => Reputation) private reps;

    event RiskConfigUpdated(uint16 min, uint16 base, uint16 max, uint16 step);
    event ReputationUpdated(address indexed user, uint8 riskLevel, uint32 completed, uint32 timeouts, bool frozen, bool blacklisted);
    event BlacklistUpdated(address indexed user, bool value);
    event FreezeUpdated(address indexed user, bool frozen, uint64 frozenUntil);
    event EscrowMigrationProposed(address indexed newEscrow);
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

    // ── IC2CRiskManagerAdmin ──────────────────────────────────────

    function setEscrow(address _escrow) external onlyAdmin {
        if (_escrow == address(0)) revert InvalidManagerAddress();
        escrow = _escrow;
    }

    function proposeMigrateEscrow(address newEscrow) external onlyAdmin {
        if (newEscrow == address(0)) revert InvalidManagerAddress();
        pendingEscrow = newEscrow;
        emit EscrowMigrationProposed(newEscrow);
    }

    function acceptMigrateEscrow() external {
        if (msg.sender != pendingEscrow) revert NotAllowed();
        emit EscrowMigrated(escrow, pendingEscrow);
        escrow        = pendingEscrow;
        pendingEscrow = address(0);
    }

    function setRiskConfig(
        uint16 _min, uint16 _base, uint16 _max, uint16 _step,
        uint8  _reset, uint32 _freezeThreshold,
        uint32 _rewardThreshold, uint32 _decayDays
    ) external onlyAdmin {
        if (_min > _base || _base > _max || _max > 10000) revert InvalidBps();
        if (_step == 0) revert InvalidBps();
        minBondBps               = _min;
        baseBondBps              = _base;
        maxBondBps               = _max;
        stepBps                  = _step;
        resetThreshold           = _reset;
        freezeThreshold          = _freezeThreshold;
        rewardCompletedThreshold = _rewardThreshold;
        decayIntervalDays        = _decayDays;
        emit RiskConfigUpdated(_min, _base, _max, _step);
    }

    // ── Storage warm-up ──────────────────────────────────────────
    // Call initReputation() before placing the first order.
    // Writes initialized=true so the reputation slot is non-zero, turning
    // subsequent onTimeout/onCompleted writes from cold (20,000 gas) to
    // warm (2,900 gas) SSTOREs. Only needs to be called once per user.

    function initReputation(address user) external {
        if (!reps[user].initialized) {
            reps[user].initialized = true;
        }
    }

    function setBlacklist(address user, bool value) external onlyAdmin {
        reps[user].blacklisted = value;
        emit BlacklistUpdated(user, value);
    }

    function manualUnfreeze(address user) external onlyAdmin {
        reps[user].temporarilyFrozen = false;
        reps[user].frozenUntil = 0;
        emit FreezeUpdated(user, false, 0);
    }

    // ── IC2CRiskManager ──────────────────────────────────────────

    function requiredBondBps(address user) external view returns (uint16) {
        Reputation storage r = reps[user];
        if (r.blacklisted) revert UserBlacklisted();
        if (r.temporarilyFrozen && block.timestamp < r.frozenUntil) revert UserTemporarilyFrozen();

        uint8 effectiveRisk = _effectiveRiskLevel(r);

        uint256 raw256 = uint256(baseBondBps) + uint256(effectiveRisk) * uint256(stepBps);
        uint16  raw    = raw256 >= maxBondBps ? maxBondBps : uint16(raw256);

        if (effectiveRisk == 0 && r.completedCount >= rewardCompletedThreshold && raw > minBondBps) {
            raw = minBondBps;
        }
        return raw;
    }

    function getReputation(address user) external view returns (ReputationView memory) {
        Reputation storage r = reps[user];
        return ReputationView({
            completedCount:            r.completedCount,
            timeoutCount:              r.timeoutCount,
            consecutiveTimeouts:       r.consecutiveTimeouts,
            completedSinceLastTimeout: r.completedSinceLastTimeout,
            riskLevel:                 r.riskLevel,
            temporarilyFrozen:         r.temporarilyFrozen,
            blacklisted:               r.blacklisted,
            frozenUntil:               r.frozenUntil,
            lastTimeoutAt:             r.lastTimeoutAt
        });
    }

    function onCompleted(address user) external onlyEscrow {
        Reputation storage r = reps[user];
        _applyDecay(r);

        r.completedCount += 1;
        r.completedSinceLastTimeout += 1;
        if (r.completedSinceLastTimeout >= resetThreshold) r.consecutiveTimeouts = 0;
        if (r.riskLevel > 0) r.riskLevel -= 1;

        emit ReputationUpdated(user, r.riskLevel, r.completedCount, r.timeoutCount, r.temporarilyFrozen, r.blacklisted);
    }

    function onTimeout(address user) external onlyEscrow {
        Reputation storage r = reps[user];
        _applyDecay(r);

        r.timeoutCount += 1;
        r.completedSinceLastTimeout = 0;
        r.lastTimeoutAt = uint64(block.timestamp);

        if (r.consecutiveTimeouts < type(uint8).max) r.consecutiveTimeouts += 1;

        uint8 inc = r.consecutiveTimeouts >= 3 ? 3 : (r.consecutiveTimeouts >= 2 ? 2 : 1);
        uint16 next = uint16(r.riskLevel) + inc;
        r.riskLevel = next > maxRiskLevel ? maxRiskLevel : uint8(next);

        if (r.timeoutCount >= freezeThreshold || r.riskLevel >= maxRiskLevel) {
            r.temporarilyFrozen = true;
            r.frozenUntil = uint64(block.timestamp + uint256(freezeDays) * 1 days);
            emit FreezeUpdated(user, true, r.frozenUntil);
        }

        emit ReputationUpdated(user, r.riskLevel, r.completedCount, r.timeoutCount, r.temporarilyFrozen, r.blacklisted);
    }

    // ── Internal ─────────────────────────────────────────────────

    function _effectiveRiskLevel(Reputation storage r) internal view returns (uint8) {
        if (r.lastTimeoutAt == 0 || r.riskLevel == 0 || decayIntervalDays == 0) return r.riskLevel;
        uint256 daysSince  = (block.timestamp - r.lastTimeoutAt) / 1 days;
        uint256 decaySteps = daysSince / decayIntervalDays;
        return decaySteps >= r.riskLevel ? 0 : r.riskLevel - uint8(decaySteps);
    }

    function _applyDecay(Reputation storage r) internal {
        if (r.lastTimeoutAt == 0 || r.riskLevel == 0 || decayIntervalDays == 0) return;
        uint256 daysSince  = (block.timestamp - r.lastTimeoutAt) / 1 days;
        uint256 decaySteps = daysSince / decayIntervalDays;
        if (decaySteps == 0) return;
        r.riskLevel      = decaySteps >= r.riskLevel ? 0 : r.riskLevel - uint8(decaySteps);
        r.lastTimeoutAt += uint64(decaySteps * uint256(decayIntervalDays) * 1 days);
    }
}
