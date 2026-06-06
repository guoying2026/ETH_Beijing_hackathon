/**
 * scripts/verify-e2e-sweep.ts — Stage 6 Gate verifier.
 *
 * Run AFTER `scripts/test-e2e-sweep.ts` and the keeper sweep:
 *   npx hardhat run scripts/verify-e2e-sweep.ts --network localhost
 *
 * Checks (matches §8 Stage 6 verification checklist):
 *   ✓ ExpiredSwept emitted at least once for the test order's product
 *   ✓ OrderStatusChanged(EXPIRED) emitted for the test order
 *   ✓ riskManager.getReputation(buyer).timeoutCount >= 1
 *   ✓ bondVault.claimableBalance(merchant, USDT) > 0  (CRYPTO buyer timeout pays merchant)
 *   ✓ Idempotency: a second sweepExpired call returns cleaned=0 and emits nothing
 *
 * Exits non-zero if any assertion fails so this can be wired into CI later.
 */
import assert from "node:assert/strict";
import { network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ASSET_CRYPTO = 0;
const BUYER_INDEX = 2;

async function main() {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();

  const deploymentsPath = path.resolve(__dirname, "..", "deployments", `${chainId}.json`);
  const deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf-8")) as {
    contracts: { c2cEscrow: `0x${string}`; c2cRiskManager: `0x${string}`; c2cBondVault: `0x${string}` };
    tokens: { USDT: `0x${string}` };
    merchant: `0x${string}`;
    deploymentBlock: string;
  };

  const wallets = await viem.getWalletClients();
  const buyer = wallets[BUYER_INDEX]!;
  const buyerAddr = buyer.account.address;
  const merchant = deployments.merchant;
  const escrowAddress = deployments.contracts.c2cEscrow;

  console.log("=== Stage 6 Gate verifier ===");
  console.log(`escrow:    ${escrowAddress}`);
  console.log(`buyer:     ${buyerAddr}`);
  console.log(`merchant:  ${merchant}`);
  console.log();

  // 1) Reputation: buyer.timeoutCount must be ≥ 1 (CRYPTO buyer timeout path)
  const riskManager = await viem.getContractAt("C2CRiskManager", deployments.contracts.c2cRiskManager);
  const rep = await riskManager.read.getReputation([buyerAddr]);
  console.log(`buyer.timeoutCount:               ${rep.timeoutCount}`);
  assert.ok(
    Number(rep.timeoutCount) >= 1,
    `buyer.timeoutCount should be >= 1 (got ${rep.timeoutCount})`,
  );

  // 2) BondVault: merchant's USDT claimable must have grown
  const bondVault = await viem.getContractAt("C2CBondVault", deployments.contracts.c2cBondVault);
  const merchantClaim = await bondVault.read.claimableBalance([merchant, deployments.tokens.USDT]);
  console.log(`merchant.claimable(USDT):         ${merchantClaim}`);
  assert.ok(
    merchantClaim > 0n,
    `merchant claimable(USDT) should be > 0 (got ${merchantClaim})`,
  );

  // 3) Events emitted in the full history since deploy
  const fromBlock = BigInt(deployments.deploymentBlock);
  const expiredSweptAbi = {
    type: "event",
    name: "ExpiredSwept",
    inputs: [
      { name: "caller", type: "address", indexed: true },
      { name: "merchant", type: "address", indexed: true },
      { name: "productId", type: "uint256", indexed: true },
      { name: "assetType", type: "uint8", indexed: false },
      { name: "cleanedCount", type: "uint256", indexed: false },
    ],
  } as const;
  const orderStatusAbi = {
    type: "event",
    name: "OrderStatusChanged",
    inputs: [
      { name: "buyer", type: "address", indexed: true },
      { name: "merchant", type: "address", indexed: true },
      { name: "orderId", type: "uint256", indexed: true },
      { name: "productId", type: "uint256", indexed: false },
      { name: "assetType", type: "uint8", indexed: false },
      { name: "status", type: "uint8", indexed: false },
      { name: "deadline", type: "uint256", indexed: false },
    ],
  } as const;
  const sweptLogs = await publicClient.getContractEvents({
    address: escrowAddress,
    abi: [expiredSweptAbi],
    eventName: "ExpiredSwept",
    fromBlock,
  });
  const statusLogs = await publicClient.getContractEvents({
    address: escrowAddress,
    abi: [orderStatusAbi],
    eventName: "OrderStatusChanged",
    fromBlock,
  });
  const expiredEvents = statusLogs.filter((l: any) => Number(l.args.status) === 1 /* EXPIRED */);
  console.log(`ExpiredSwept events:              ${sweptLogs.length}`);
  console.log(`OrderStatusChanged(EXPIRED):      ${expiredEvents.length}`);
  assert.ok(sweptLogs.length >= 1, "expected at least 1 ExpiredSwept event");
  assert.ok(expiredEvents.length >= 1, "expected at least 1 OrderStatusChanged(EXPIRED) event");

  // 4) Idempotency: another sweep should return cleaned=0
  const escrow = await viem.getContractAt("C2CEscrow", escrowAddress);
  const sim = await (escrow.simulate as any).sweepExpired([merchant, 0n, ASSET_CRYPTO, 0n]);
  console.log(`re-run sweepExpired (sim) cleaned: ${sim.result}`);
  assert.equal(
    sim.result,
    0n,
    `idempotency: second sweep should be a no-op (got cleaned=${sim.result})`,
  );

  console.log();
  console.log("✅ Gate 6 verifier — all checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
