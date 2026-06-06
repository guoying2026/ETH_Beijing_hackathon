// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

enum SettlementType {
    PROOF_SUCCESS, // 证明成功 → 保证金退回 prover
    PROOF_TIMEOUT  // 证明超时 → 保证金归 counterpart
}

interface IC2CBondVault {
    function createOrderBond(
        bytes32 orderKey,
        address token,
        address prover,
        address counterpart,
        uint256 bond
    ) external;

    function settle(bytes32 orderKey, SettlementType stype) external;
    function settle(bytes32 orderKey, SettlementType stype, uint256 proverExtra, uint256 counterpartExtra) external;
    function claim(address token) external returns (uint256);
    function claimableBalance(address user, address token) external view returns (uint256);
}
