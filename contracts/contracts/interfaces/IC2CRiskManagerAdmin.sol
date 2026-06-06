// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IC2CRiskManagerAdmin {
    function setBlacklist(address user, bool value) external;
    function manualUnfreeze(address user) external;
    function setRiskConfig(
        uint16 minBondBps,
        uint16 baseBondBps,
        uint16 maxBondBps,
        uint16 stepBps,
        uint8  resetThreshold,
        uint32 freezeThreshold,
        uint32 rewardCompletedThreshold,
        uint32 decayIntervalDays
    ) external;
    function setEscrow(address escrow) external;
    function proposeMigrateEscrow(address newEscrow) external;
    function acceptMigrateEscrow() external;
}
