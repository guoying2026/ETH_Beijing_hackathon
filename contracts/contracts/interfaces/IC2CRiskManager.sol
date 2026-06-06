// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IC2CRiskManager {
    struct ReputationView {
        uint32 completedCount;
        uint32 timeoutCount;
        uint8  consecutiveTimeouts;
        uint8  completedSinceLastTimeout;
        uint8  riskLevel;
        bool   temporarilyFrozen;
        bool   blacklisted;
        uint64 frozenUntil;
        uint64 lastTimeoutAt;
    }

    // productKey 参数保留以便将来扩展，当前实现忽略它
    function requiredBondBps(address user) external view returns (uint16);
    function onCompleted(address user) external;
    function onTimeout(address user) external;
    function getReputation(address user) external view returns (ReputationView memory);
}
