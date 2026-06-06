/**
 * deploy-v4.ts — Production-ready V4 deployment script for the web frontend.
 *
 * Deploys all contracts, wires managers, initializes risk params from chapter4.md §4.5.1,
 * then prints NEXT_PUBLIC_* env vars for packages/web/.env.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-v4.ts --network <network>
 */

import { parseUnits, keccak256, toBytes } from "viem";
import hardhat from "hardhat";

const { viem } = hardhat;

// ── chapter4.md §4.5.1 default risk parameters ──────────────────────────────
const RISK_PARAMS = {
    baseBps:        1_000,     // 10%  base bond rate
    stepBps:        300,       // 3%   increment per risk level
    minBps:         500,       // 5%   floor
    maxBps:         10_000,    // 100% ceiling
    resetThreshold: 3,         // consecutive completions to step down 1 level
    banThreshold:   15,        // cumulative timeouts to trigger temp ban
    banDuration:    2_592_000, // 30 days in seconds
} as const;

async function main() {
    const walletClients = await viem.getWalletClients();
    const [deployer] = walletClients;
    console.log("Deployer:", deployer.account.address);

    // 1. Deploy TLSNVerifier
    const tlsnVerifier = await viem.deployContract("TLSNVerifier");
    console.log("TLSNVerifier:", tlsnVerifier.address);

    // 2. Deploy C2CAdmin
    const c2cAdmin = await viem.deployContract("C2CAdmin", [tlsnVerifier.address]);
    console.log("C2CAdmin:", c2cAdmin.address);

    // 3. Deploy C2CEscrow
    const c2cEscrow = await viem.deployContract("C2CEscrow", [
        c2cAdmin.address,
        tlsnVerifier.address,
    ]);
    console.log("C2CEscrow:", c2cEscrow.address);

    // 4. Deploy C2CRiskManager
    const c2cRiskManager = await viem.deployContract("C2CRiskManager", [c2cAdmin.address]);
    console.log("C2CRiskManager:", c2cRiskManager.address);

    // 5. Deploy C2CBondVault
    const c2cBondVault = await viem.deployContract("C2CBondVault", [c2cAdmin.address]);
    console.log("C2CBondVault:", c2cBondVault.address);

    // 6–8. Set authorized callers
    await tlsnVerifier.write.setAuthorizedCaller([c2cAdmin.address, true]);
    await tlsnVerifier.write.setAuthorizedCaller([c2cEscrow.address, true]);
    await c2cAdmin.write.setAuthorizedCaller([c2cEscrow.address, true]);

    // 9. Wire managers into escrow; wire escrow into sub-contracts
    await c2cEscrow.write.setManagers([c2cRiskManager.address, c2cBondVault.address]);
    await c2cRiskManager.write.setEscrow([c2cEscrow.address]);
    await c2cBondVault.write.setEscrow([c2cEscrow.address]);

    // 10. Deploy and register WisePlatformVerifier
    const wisePlatformVerifier = await viem.deployContract("WisePlatformVerifier", [
        tlsnVerifier.address,
    ]);
    const PLATFORM_WISE = await tlsnVerifier.read.PLATFORM_WISE();
    await tlsnVerifier.write.setPlatformVerifier([PLATFORM_WISE, wisePlatformVerifier.address]);
    console.log("WisePlatformVerifier:", wisePlatformVerifier.address);

    // 11. Deploy and register AlipayPlatformVerifier
    const alipayPlatformVerifier = await viem.deployContract("AlipayPlatformVerifier", [
        tlsnVerifier.address,
    ]);
    const PLATFORM_ALIPAY = await tlsnVerifier.read.PLATFORM_ALIPAY();
    await tlsnVerifier.write.setPlatformVerifier([PLATFORM_ALIPAY, alipayPlatformVerifier.address]);
    console.log("AlipayPlatformVerifier:", alipayPlatformVerifier.address);

    // ── Initialize risk parameters (chapter4.md §4.5.1) ─────────────────────
    await c2cRiskManager.write.setParams([
        RISK_PARAMS.baseBps,
        RISK_PARAMS.stepBps,
        RISK_PARAMS.minBps,
        RISK_PARAMS.maxBps,
        RISK_PARAMS.resetThreshold,
        RISK_PARAMS.banThreshold,
        RISK_PARAMS.banDuration,
    ]);
    console.log("Risk params initialized:", RISK_PARAMS);

    // ── Print .env for packages/web ──────────────────────────────────────────
    const chainId = await viem.getPublicClient().then((c) => c.getChainId());
    console.log("\n# ── packages/web/.env (copy these lines) ──────────────────");
    console.log(`NEXT_PUBLIC_C2C_ADMIN_ADDRESS=${c2cAdmin.address}`);
    console.log(`NEXT_PUBLIC_C2C_ESCROW_ADDRESS=${c2cEscrow.address}`);
    console.log(`NEXT_PUBLIC_C2C_BOND_VAULT_ADDRESS=${c2cBondVault.address}`);
    console.log(`NEXT_PUBLIC_C2C_RISK_MANAGER_ADDRESS=${c2cRiskManager.address}`);
    console.log(`NEXT_PUBLIC_CHAIN_ID=${chainId}`);
    console.log("# ────────────────────────────────────────────────────────────");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
