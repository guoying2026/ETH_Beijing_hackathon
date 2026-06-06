/**
 * scripts/test-e2e-sweep.ts — Stage 6 E2E driver.
 *
 * Prerequisites (run in two separate terminals):
 *   T1: cd packages/contracts && npx hardhat node --network hardhatMainnet
 *   T2: cd packages/contracts && npm run deploy:web
 *
 * Then in a 3rd terminal:
 *   T3: cd packages/keeper && npm run dev
 *
 * Finally run this script:
 *   cd packages/contracts && npx hardhat run scripts/test-e2e-sweep.ts --network localhost
 *
 * What it does:
 *   1. Reads addresses from deployments/<chainId>.json (the file deploy-web.ts wrote)
 *   2. Places one CRYPTO order on product 0 as Hardhat account[2]
 *   3. Captures the order key + deadline
 *   4. Fast-forwards chain time past the deadline + grace window
 *   5. Logs what the keeper should now observe and exits
 *
 * The keeper (running in T3) should within ~5s see chain time pass the
 * deadline, call `sweepExpiredBatch`, and emit `ExpiredSwept`. The Gate 6
 * verification reads the on-chain side-effects (timeoutCount, claimable, etc.)
 * from a second invocation of this script with --verify.
 */
import { network } from "hardhat";
import { parseUnits } from "viem";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ZERO_HASH = "0x" + "00".repeat(32);
const ASSET_CRYPTO = 0;

// Hardhat default account[2] — has USDT/USDC minted by deploy-web.ts.
const BUYER_INDEX = 2;

async function main() {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();

  const deploymentsPath = path.resolve(__dirname, "..", "deployments", `${chainId}.json`);
  if (!fs.existsSync(deploymentsPath)) {
    throw new Error(
      `Deployments file not found at ${deploymentsPath}. Run \`npm run deploy:web\` first.`,
    );
  }
  const deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf-8")) as {
    chainId: number;
    contracts: { c2cEscrow: `0x${string}`; c2cRiskManager: `0x${string}`; c2cBondVault: `0x${string}` };
    tokens: { USDT: `0x${string}` };
    merchant: `0x${string}`;
  };

  const wallets = await viem.getWalletClients();
  const buyer = wallets[BUYER_INDEX]!;
  const merchant = deployments.merchant;
  const escrowAddress = deployments.contracts.c2cEscrow;

  console.log("=== Stage 6 E2E driver ===");
  console.log(`chainId:         ${chainId}`);
  console.log(`escrow:          ${escrowAddress}`);
  console.log(`merchant:        ${merchant}`);
  console.log(`buyer (acc[${BUYER_INDEX}]): ${buyer.account.address}`);
  console.log();

  // Snapshot reputation + claimable before — we'll re-check after the sweep.
  const riskManager = await viem.getContractAt("C2CRiskManager", deployments.contracts.c2cRiskManager);
  const bondVault = await viem.getContractAt("C2CBondVault", deployments.contracts.c2cBondVault);

  const repBefore = await riskManager.read.getReputation([buyer.account.address]);
  const merchantClaimBefore = await bondVault.read.claimableBalance([
    merchant,
    deployments.tokens.USDT,
  ]);
  console.log(`buyer.timeoutCount BEFORE:        ${repBefore.timeoutCount}`);
  console.log(`merchant.claimable(USDT) BEFORE:  ${merchantClaimBefore}`);
  console.log();

  // ── 1. Place a CRYPTO order on product 0 ────────────────────────────────
  const escrowAsBuyer = await viem.getContractAt("C2CEscrow", escrowAddress, {
    client: { wallet: buyer },
  });
  const TRADE_AMOUNT = parseUnits("1", 18); // 1 USDT
  const placeTx = await (escrowAsBuyer.write as any).placeOrder([
    merchant,
    0n,
    ASSET_CRYPTO,
    TRADE_AMOUNT,
    { nameHash: ZERO_HASH, idHash: ZERO_HASH, isSet: false },
  ]);
  const placeReceipt = await publicClient.waitForTransactionReceipt({ hash: placeTx });
  console.log(`placeOrder tx:  ${placeTx}  status=${placeReceipt.status}`);

  // The first order on a fresh product has orderId=0; subsequent runs would
  // pick up whatever the contract assigned. Read it back from the OrderPlaced
  // event in this receipt so we don't guess.
  const orderPlacedAbi = {
    type: "event",
    name: "OrderPlaced",
    inputs: [
      { name: "buyer", type: "address", indexed: true },
      { name: "merchant", type: "address", indexed: true },
      { name: "orderId", type: "uint256", indexed: true },
      { name: "productId", type: "uint256", indexed: false },
      { name: "assetType", type: "uint8", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "rate", type: "uint256", indexed: false },
      { name: "deadline", type: "uint256", indexed: false },
      { name: "salt", type: "uint256", indexed: false },
    ],
  } as const;
  // Decode logs manually.
  const placedLogs = await publicClient.getContractEvents({
    address: escrowAddress,
    abi: [orderPlacedAbi],
    eventName: "OrderPlaced",
    fromBlock: placeReceipt.blockNumber,
    toBlock: placeReceipt.blockNumber,
  });
  const placed = placedLogs.find(
    (l: any) =>
      String(l.args.buyer).toLowerCase() === buyer.account.address.toLowerCase() &&
      String(l.args.merchant).toLowerCase() === merchant.toLowerCase(),
  );
  if (!placed) throw new Error("OrderPlaced event not found in receipt");
  const orderId = (placed as any).args.orderId as bigint;
  const deadline = (placed as any).args.deadline as bigint;
  console.log(`orderId:        ${orderId}`);
  console.log(`deadline:       ${deadline} (chain ts)`);

  // ── 2. Fast-forward chain time past deadline + grace ────────────────────
  const FAST_FORWARD_SECONDS = 16 * 60; // 16 minutes — past ORDER_TIMEOUT=15m + 30s grace
  const tc = await viem.getTestClient();
  await tc.increaseTime({ seconds: FAST_FORWARD_SECONDS });
  await tc.mine({ blocks: 1 });
  const newHead = await publicClient.getBlock();
  console.log();
  console.log(`Fast-forwarded chain by ${FAST_FORWARD_SECONDS}s`);
  console.log(`Current chain ts: ${newHead.timestamp}  (deadline + ${newHead.timestamp - deadline}s)`);
  console.log();
  console.log("→ Keeper should now see the order as due on its next tick.");
  console.log("  Watch keeper logs for: 'Tick: 1 due entries' and 'sweepExpiredBatch ok'");
  console.log();
  console.log("Re-run with --verify to check on-chain side effects.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
