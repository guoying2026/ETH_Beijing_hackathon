/**
 * scripts1/deploy-local.ts — V4 双边公平惩罚合约本地部署
 *
 * 运行方式：
 *   hardhat run scripts1/deploy-local.ts \
 *     --config hardhat.config.v2.ts \
 *     --network hardhatMainnet
 *
 * 部署顺序：
 *   1. MockERC20 (USDT)
 *   2. TLSNVerifier
 *   3. C2CAdmin
 *   4. C2CEscrow
 *   5. 平台验证器 (Wise + Alipay)
 *   6. C2CRiskManager (V4 新增)
 *   7. C2CBondVault (V4 新增)
 *   8. 配置互相授权
 */

import { parseUnits, keccak256, toBytes } from "viem";
import hardhat from "hardhat";

const { viem } = hardhat;

const VERIFIER_SIGNER_ADDRESS = "0x5BC034e03584e20a81Aa0c36A2974c338Dd8A368";

async function main() {
  const walletClients = await viem.getWalletClients();
  const [deployer, merchant, buyer] = walletClients;
  console.log("Deployer:", deployer.account.address);

  // 1. MockERC20
  const usdt = await viem.deployContract("MockERC20", ["Tether USD", "USDT", 18]);
  console.log("MockERC20 (USDT):", usdt.address);

  // 2. TLSNVerifier
  const tlsnVerifier = await viem.deployContract("TLSNVerifier");
  console.log("TLSNVerifier:", tlsnVerifier.address);

  // 3. C2CAdmin
  const c2cAdmin = await viem.deployContract("C2CAdmin", [tlsnVerifier.address]);
  console.log("C2CAdmin:", c2cAdmin.address);

  // 4. C2CEscrow
  const c2cEscrow = await viem.deployContract("C2CEscrow", [
    c2cAdmin.address, tlsnVerifier.address,
  ]);
  console.log("C2CEscrow:", c2cEscrow.address);

  // 5. Authorization
  await tlsnVerifier.write.setAuthorizedCaller([c2cAdmin.address, true]);
  await tlsnVerifier.write.setAuthorizedCaller([c2cEscrow.address, true]);
  await c2cAdmin.write.setAuthorizedCaller([c2cEscrow.address, true]);

  // 6. Add assets
  await c2cAdmin.write.addCryptoInfo([usdt.address, true]);
  await c2cAdmin.write.addFiatInfo(["CNY", true]);
  await c2cAdmin.write.addFiatInfo(["MYR", true]);

  // 7. Add trusted verifier + servers
  await tlsnVerifier.write.addTrustedVerifier([VERIFIER_SIGNER_ADDRESS]);
  await tlsnVerifier.write.addTrustedKYBServer(["kyb.example.com"]);
  await tlsnVerifier.write.addTrustedPaymentServer(["wise.com"]);
  await tlsnVerifier.write.addTrustedPaymentServer(["mbillexprod.alipay.com"]);

  // 8. Platform verifiers
  const wisePlatformVerifier = await viem.deployContract("WisePlatformVerifier", [
    tlsnVerifier.address,
  ]);
  const alipayPlatformVerifier = await viem.deployContract("AlipayPlatformVerifier", [
    tlsnVerifier.address,
  ]);
  const PLATFORM_WISE   = await tlsnVerifier.read.PLATFORM_WISE();
  const PLATFORM_ALIPAY = await tlsnVerifier.read.PLATFORM_ALIPAY();
  await tlsnVerifier.write.setPlatformVerifier([PLATFORM_WISE, wisePlatformVerifier.address]);
  await tlsnVerifier.write.setPlatformVerifier([PLATFORM_ALIPAY, alipayPlatformVerifier.address]);
  console.log("WisePlatformVerifier:", wisePlatformVerifier.address);
  console.log("AlipayPlatformVerifier:", alipayPlatformVerifier.address);

  // 9. V4: C2CRiskManager + C2CBondVault
  const c2cRiskManager = await viem.deployContract("C2CRiskManager", [c2cAdmin.address]);
  const c2cBondVault   = await viem.deployContract("C2CBondVault",   [c2cAdmin.address]);
  console.log("C2CRiskManager:", c2cRiskManager.address);
  console.log("C2CBondVault:",   c2cBondVault.address);

  // 10. Wire managers
  await c2cEscrow.write.setManagers([c2cRiskManager.address, c2cBondVault.address]);
  await c2cRiskManager.write.setEscrow([c2cEscrow.address]);
  await c2cBondVault.write.setEscrow([c2cEscrow.address]);

  // 11. Mint test tokens
  const mintAmount = parseUnits("100000", 18);
  await usdt.write.mint([merchant.account.address, mintAmount]);
  await usdt.write.mint([buyer.account.address, mintAmount]);

  console.log("\n# ── .env (copy to packages/demo/.env) ──────────────────");
  console.log(`VITE_USDT_ADDRESS=${usdt.address}`);
  console.log(`VITE_TLSN_VERIFIER_ADDRESS=${tlsnVerifier.address}`);
  console.log(`VITE_C2C_ADMIN_ADDRESS=${c2cAdmin.address}`);
  console.log(`VITE_C2C_ESCROW_ADDRESS=${c2cEscrow.address}`);
  console.log(`VITE_C2C_RISK_MANAGER_ADDRESS=${c2cRiskManager.address}`);
  console.log(`VITE_C2C_BOND_VAULT_ADDRESS=${c2cBondVault.address}`);
  console.log("# ──────────────────────────────────────────────────────────");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
