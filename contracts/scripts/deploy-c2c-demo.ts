/**
 * Deploy the C2C Demo contracts (V4 — Bond + Penalty + Reputation) and fully
 * initialise state for 3 merchants × 4 products each.
 *
 * Writes contract addresses to packages/demo/.env after deployment.
 *
 * Account layout (Hardhat deterministic accounts):
 *   accounts[0]   → Admin (deployer)
 *   accounts[1-3] → Merchant 1 / 2 / 3
 *   accounts[4-8] → User 1 / 2 / 3 / 4 / 5
 *   accounts[9]   → VerifierSigner
 *
 * Usage:
 *   npx hardhat run scripts1/deploy-c2c-demo.ts \
 *     --config hardhat.config.v2.ts \
 *     --network hardhatMainnet
 */

import { network } from "hardhat";
import {
  parseUnits,
  keccak256,
  toBytes,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { performance } from "perf_hooks";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Must stay aligned with packages/demo/src/utils/hardhatAccounts.ts
const HARDHAT_PRIVATE_KEYS: Hex[] = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // [0] Admin
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // [1] Merchant_1
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // [2] Merchant_2
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // [3] Merchant_3
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", // [4] User_1
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", // [5] User_2
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e", // [6] User_3
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356", // [7] User_4
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97", // [8] User_5
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6", // [9] verifierSigner
];

const VERIFIER_SIGNER_ADDRESS = privateKeyToAccount(HARDHAT_PRIVATE_KEYS[9]).address;

// ── Rate constants (RATE_PRECISION_EXP = 8, so 4.5 MYR/USDT = 450_000_000) ──
const RATE_WISE_CRYPTO   = 450_000_000n;  // 4.5  MYR / USDT

// ── Product IDs (auto-incremented per merchant per assetType during listing) ──
const WISE_CRYPTO_PRODUCT_ID   = 0n;

// ── Token amounts ──────────────────────────────────────────────────────────────
const MINT_18      = parseUnits("2000", 18);  // USDT / DAI (18 dec)
const MINT_6       = parseUnits("2000",  6);  // USDC (6 dec)
const COLLATERAL   = parseUnits("100",  18);  // 100 USDT collateral per product
const MAX_UINT256  = (2n ** 256n) - 1n;

// ── Merchant identities ────────────────────────────────────────────────────────
const MERCHANT_WISE_NAMES   = ["KAI XU LOOI"];
const MERCHANT_WISE_HANDLES = ["@kaixul1"];

// ── Never-expiring rate ─────────────────────────────────────────────────────────
const RATE_EXPIRY_NEVER = 0n;

function elapsed(label: string, start: number): void {
  const ms = Math.round(performance.now() - start);
  console.log(`  ⏱  ${label}: ${ms}ms`);
}

function updateEnvFile(envPath: string, newVars: Record<string, string>): void {
  let content = "";
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, "utf-8");
  }
  const lines = content.split("\n");
  const updatedKeys = new Set<string>();
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("#") || !line.includes("=")) {
      continue;
    }
    const eqIdx = line.indexOf("=");
    const key = line.substring(0, eqIdx).trim();
    if (key in newVars) {
      lines[i] = `${key}=${newVars[key]}`;
      updatedKeys.add(key);
    }
  }
  
  for (const [key, val] of Object.entries(newVars)) {
    if (!updatedKeys.has(key)) {
      lines.push(`${key}=${val}`);
    }
  }
  
  fs.writeFileSync(envPath, lines.join("\n"), "utf-8");
}

async function main() {
  const tScript = performance.now();

  // ── Hardhat init ─────────────────────────────────────────────────────────────
  const tInit = performance.now();
  const { viem } = await network.connect();
  const nodeWallets = await viem.getWalletClients();
  elapsed("Hardhat init (connect + fetch wallet clients via RPC)", tInit);

  // All accounts are Hardhat's deterministic accounts[0..8] — same addresses as
  // HARDHAT_PRIVATE_KEYS, already pre-funded by Hardhat with 10 000 ETH each.
  const adminWallet   = nodeWallets[0];
  const merchantWallets = nodeWallets.slice(1, 4);
  const userWallets     = nodeWallets.slice(4, 9);

  const adminAddr     = adminWallet.account.address;
  const merchantAddrs = merchantWallets.map((w) => w.account.address);
  const userAddrs     = userWallets.map((w) => w.account.address);

  console.log("=== C2C Demo Deployment ===");
  console.log("Admin:      ", adminAddr);
  merchantAddrs.forEach((a, i) => console.log(`Merchant ${i + 1}: `, a));
  userAddrs.forEach((a, i) => console.log(`User ${i + 1}:     `, a));
  console.log("Verifier Signer:", VERIFIER_SIGNER_ADDRESS);
  console.log("");

  const t0 = performance.now();

  // ── 1. Deploy tokens ─────────────────────────────────────────────────────────
  const usdt = await viem.deployContract("MockERC20", ["Tether USD",     "USDT", 18]);
  const usdc = await viem.deployContract("MockERC20", ["USD Coin",       "USDC",  6]);
  const dai  = await viem.deployContract("MockERC20", ["Dai Stablecoin", "DAI",  18]);
  console.log("MockERC20 USDT:", usdt.address);
  console.log("MockERC20 USDC:", usdc.address);
  console.log("MockERC20 DAI: ", dai.address);
  const t1 = performance.now(); elapsed("Step 1 — Token deploy (3 contracts)", t0);

  // ── 2. Deploy core contracts ──────────────────────────────────────────────────
  const tlsnVerifier = await viem.deployContract("TLSNVerifier");
  console.log("TLSNVerifier:  ", tlsnVerifier.address);

  const c2cAdmin = await viem.deployContract("C2CAdmin", [tlsnVerifier.address]);
  console.log("C2CAdmin:      ", c2cAdmin.address);

  const c2cEscrow = await viem.deployContract("C2CEscrow", [
    c2cAdmin.address,
    tlsnVerifier.address,
  ]);
  console.log("C2CEscrow:     ", c2cEscrow.address);
  // Snapshot block + chainId for the deployments artifact written at the end.
  const publicClient = await viem.getPublicClient();
  const escrowDeploymentBlock = await publicClient.getBlockNumber();
  const escrowChainId = await publicClient.getChainId();

  const bondVault   = await viem.deployContract("C2CBondVault",   [c2cAdmin.address]);
  const riskManager = await viem.deployContract("C2CRiskManager", [c2cAdmin.address]);
  console.log("C2CBondVault:  ", bondVault.address);
  console.log("C2CRiskManager:", riskManager.address);
  console.log("");
  const t2 = performance.now(); elapsed("Step 2 — Core contracts (TLSNVerifier + C2CAdmin + C2CEscrow + BondVault + RiskManager)", t1);

  // ── 3. Cross-contract authorization ──────────────────────────────────────────
  await tlsnVerifier.write.setAuthorizedCaller([c2cAdmin.address,  true]);
  await tlsnVerifier.write.setAuthorizedCaller([c2cEscrow.address, true]);
  await c2cAdmin.write.setAuthorizedCaller([c2cEscrow.address, true]);

  // Wire BondVault + RiskManager to Escrow
  await bondVault.write.setEscrow([c2cEscrow.address]);
  await riskManager.write.setEscrow([c2cEscrow.address]);
  await c2cEscrow.write.setManagers([riskManager.address, bondVault.address]);
  console.log("✅ Cross-contract authorization + BondVault/RiskManager wiring done");

  // ── 4. Register trusted verifier & payment servers ───────────────────────────
  await tlsnVerifier.write.addTrustedVerifier([VERIFIER_SIGNER_ADDRESS]);
  await tlsnVerifier.write.addTrustedPaymentServer(["wise.com"]);
  await tlsnVerifier.write.addTrustedPaymentServer(["mbillexprod.alipay.com"]);
  console.log("✅ Trusted verifier & payment servers registered");

  // ── 5. Deploy & register platform verifiers ───────────────────────────────────
  const wisePlatformVerifier   = await viem.deployContract("WisePlatformVerifier",   [tlsnVerifier.address]);
  const alipayPlatformVerifier = await viem.deployContract("AlipayPlatformVerifier", [tlsnVerifier.address]);
  console.log("WisePlatformVerifier:  ", wisePlatformVerifier.address);
  console.log("AlipayPlatformVerifier:", alipayPlatformVerifier.address);

  const PLATFORM_WISE   = await tlsnVerifier.read.PLATFORM_WISE();
  const PLATFORM_ALIPAY = await tlsnVerifier.read.PLATFORM_ALIPAY();
  await tlsnVerifier.write.setPlatformVerifier([PLATFORM_WISE,   wisePlatformVerifier.address]);
  await tlsnVerifier.write.setPlatformVerifier([PLATFORM_ALIPAY, alipayPlatformVerifier.address]);
  console.log("✅ Platform verifiers registered (Wise + Alipay)");
  const t3 = performance.now(); elapsed("Steps 3-5 — Auth + trusted servers + platform verifiers", t2);

  // ── 6. Register supported assets ─────────────────────────────────────────────
  await c2cAdmin.write.addCryptoInfo([usdt.address, true]);  // cryptoId=0 USDT
  await c2cAdmin.write.addFiatInfo(["MYR", true]);            // fiatId=0 MYR
  console.log("✅ Assets: USDT (cryptoId=0)  Fiat: MYR (fiatId=0)");
  const t4 = performance.now(); elapsed("Step 6 — Asset registration (2 tx)", t3);

  // ── 7. Mint tokens to all merchants and users ─────────────────────────────────
  const allRecipients = [...merchantAddrs, ...userAddrs];
  for (const addr of allRecipients) {
    await usdt.write.mint([addr, MINT_18]);
    await usdc.write.mint([addr, MINT_6]);
    await dai.write.mint( [addr, MINT_18]);
  }
  console.log(`✅ Minted 2000 USDT + 2000 USDC + 2000 DAI to ${allRecipients.length} accounts`);
  const t5 = performance.now(); elapsed(`Step 7 — Mint (${allRecipients.length} addr × 3 tokens, sequential)`, t4);

  // ── 8. Approve escrow for users (MAX_UINT) ─────────────────────────────────
  for (const uWallet of userWallets) {
    const usdtAsU = await viem.getContractAt("MockERC20", usdt.address, { client: { wallet: uWallet } });
    const usdcAsU = await viem.getContractAt("MockERC20", usdc.address, { client: { wallet: uWallet } });
    const daiAsU  = await viem.getContractAt("MockERC20", dai.address,  { client: { wallet: uWallet } });
    await usdtAsU.write.approve([c2cEscrow.address, MAX_UINT256]);
    await usdcAsU.write.approve([c2cEscrow.address, MAX_UINT256]);
    await daiAsU.write.approve( [c2cEscrow.address, MAX_UINT256]);
  }
  console.log("✅ Users approved escrow for USDT + USDC + DAI (MAX_UINT)");
  const t6 = performance.now(); elapsed("Step 8 — User approvals", t5);

  // ── 9. Register 1 merchant, list Wise buy-crypto product, publish rate, openNow ──
  const merchantIndex = 0;
  const mWallet = merchantWallets[merchantIndex];
  const mAddr   = merchantAddrs[merchantIndex];

  // Contract handles connected to this merchant's wallet
  const usdtAsM   = await viem.getContractAt("MockERC20", usdt.address,   { client: { wallet: mWallet } });
    const adminAsM  = await viem.getContractAt("C2CAdmin",  c2cAdmin.address,  { client: { wallet: mWallet } });
    const escrowAsM = await viem.getContractAt("C2CEscrow", c2cEscrow.address, { client: { wallet: mWallet } });

  console.log(`\n── Merchant 1 (${mAddr}) ──`);

  // Approve escrow for USDT only (MAX_UINT)
  await usdtAsM.write.approve([c2cEscrow.address, MAX_UINT256]);

    // Register merchant by admin
    await c2cAdmin.write.registerMerchantByAdmin([mAddr]);
    console.log(`  ✅ Registered`);

  // Set payment info for Wise
  const wNameHash = keccak256(toBytes(MERCHANT_WISE_NAMES[merchantIndex]));
  const wIdHash   = keccak256(toBytes(MERCHANT_WISE_HANDLES[merchantIndex]));
  await (adminAsM.write as any).setPlatformBinding([PLATFORM_WISE, wNameHash, wIdHash]);
  console.log(`  ✅ Payment info set (Wise)`);

  // List Wise buy-crypto product: USDT(0) -> MYR(0), productId=0 for assetType=CRYPTO
    await (escrowAsM.write as any).listCryptoProduct([0n, 0n, COLLATERAL, true, PLATFORM_WISE]);
  console.log(`  ✅ Listed 1 product (Wise CRYPTO)`);

  // Publish never-expiring rate (assetType: 0=CRYPTO)
  await (adminAsM.write as any).publishRate([WISE_CRYPTO_PRODUCT_ID, 0, RATE_WISE_CRYPTO, RATE_EXPIRY_NEVER]);
  console.log(`  ✅ Rate published (4.5 MYR/USDT, never expires)`);

  // Force-open this product (assetType: 0=CRYPTO)
  await (adminAsM.write as any).openNow([WISE_CRYPTO_PRODUCT_ID, 0]);
  console.log(`  ✅ Product opened`);
  const t7 = performance.now(); elapsed("Step 9 — 1 merchant × (1 approve + 1 register + 1 paymentInfo + 1 list + 1 publishRate + 1 openNow)", t6);

  // ── 10. Write .env ─────────────────────────────────────────────────────────
  const envPath = path.resolve(__dirname, "../../.env");
  const newVars: Record<string, string> = {
    VITE_VERIFIER_HOST: "localhost:7047",
    VITE_SSL: "false",
    VITE_CHAIN_ID: "31337",
    VITE_C2C_ADMIN_ADDRESS: c2cAdmin.address,
    VITE_C2C_ESCROW_ADDRESS: c2cEscrow.address,
    VITE_BOND_VAULT_ADDRESS: bondVault.address,
    VITE_RISK_MANAGER_ADDRESS: riskManager.address,
    VITE_C2C_BOND_VAULT_ADDRESS: bondVault.address,
    VITE_C2C_RISK_MANAGER_ADDRESS: riskManager.address,
    VITE_VERIFIER_SIGNER_ADDRESS: VERIFIER_SIGNER_ADDRESS,
    VITE_USDT_ADDRESS: usdt.address,
    VITE_USDC_ADDRESS: usdc.address,
    VITE_DAI_ADDRESS: dai.address,
    VITE_MERCHANT_ADDRESS: merchantAddrs[0],
    VITE_MERCHANT1_ADDRESS: merchantAddrs[0],
    VITE_MERCHANT2_ADDRESS: merchantAddrs[1],
    VITE_MERCHANT3_ADDRESS: merchantAddrs[2],
    VITE_USER1_ADDRESS: userAddrs[0],
    VITE_USER2_ADDRESS: userAddrs[1],
    VITE_USER3_ADDRESS: userAddrs[2],
    VITE_USER4_ADDRESS: userAddrs[3],
    VITE_USER5_ADDRESS: userAddrs[4],
  };

  updateEnvFile(envPath, newVars);

  // ── Write packages/contracts/deployments/demo-<chainId>.json ────────────
  // Sibling artifact to deploy-web.ts's web-<chainId>.json. Consumed by the
  // keeper to auto-discover the demo escrow without hard-coding the address.
  const deploymentsDir = path.resolve(__dirname, "../deployments");
  fs.mkdirSync(deploymentsDir, { recursive: true });
  const deploymentsFile = path.join(deploymentsDir, `demo-${escrowChainId}.json`);
  const deploymentsRecord = {
    chainId: escrowChainId,
    label: "demo",
    deployedAt: new Date().toISOString(),
    deploymentBlock: escrowDeploymentBlock.toString(),
    contracts: {
      c2cAdmin: c2cAdmin.address,
      c2cEscrow: c2cEscrow.address,
      c2cBondVault: bondVault.address,
      c2cRiskManager: riskManager.address,
      tlsnVerifier: tlsnVerifier.address,
      wisePlatformVerifier: wisePlatformVerifier.address,
      alipayPlatformVerifier: alipayPlatformVerifier.address,
    },
    tokens: {
      USDT: usdt.address,
      USDC: usdc.address,
      DAI: dai.address,
    },
    // demo deploys 3 merchants — surface the first one for keeper logs.
    merchant: merchantAddrs[0],
  };
  fs.writeFileSync(deploymentsFile, JSON.stringify(deploymentsRecord, null, 2), "utf-8");
  console.log(`✅ Deployments written to ${path.relative(process.cwd(), deploymentsFile)}`);

  console.log("\n" + "=".repeat(60));
  console.log("✅ .env updated in the root folder");
  console.log("=".repeat(60));
  const envContent = Object.entries(newVars).map(([key, val]) => `${key}=${val}`).join("\n");
  console.log(envContent);

  const expectedUserAddrs = HARDHAT_PRIVATE_KEYS.slice(4, 9).map((key) => privateKeyToAccount(key).address);
  let allMatch = true;
  console.log("Frontend expected users vs .env users:");
  expectedUserAddrs.forEach((expected, i) => {
    const written = userAddrs[i];
    const ok = expected.toLowerCase() === written.toLowerCase();
    if (!ok) allMatch = false;
    console.log(`  User ${i + 1}: expected=${expected} written=${written} ${ok ? "✅" : "❌"}`);
  });
  if (!allMatch) {
    throw new Error("User address mismatch: generated .env does not match frontend fixed signer keys.");
  }
  console.log("✅ User address consistency check passed");

  console.log("─".repeat(60));
  elapsed("TOTAL deployment only (t0 → .env written)", t0);
  elapsed("TOTAL script execution (incl. Hardhat init)", tScript);
  console.log("─".repeat(60));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
