import type { Address } from "viem";
import { keccak256, parseUnits, toBytes } from "viem";

import {
  ALIPAY_BUYER_HANDLE,
  ALIPAY_BUYER_NAME,
  BUYER_HANDLE,
  BUYER_NAME,
} from "./constants.js";

/**
 * Deploy the full C2C V4 platform stack (with RiskManager + BondVault).
 *
 * Returns all contract instances and wallet clients needed for testing.
 */
export async function deployAll(viem: any) {
  const walletClients = await viem.getWalletClients();
  const [deployer, verifierSigner, merchant, buyer, randomUser, newAdmin] =
    walletClients;

  // 1. Deploy MockERC20
  const usdt = await viem.deployContract("MockERC20", ["Tether USD", "USDT", 18]);

  // 2. Deploy TLSNVerifier
  const tlsnVerifier = await viem.deployContract("TLSNVerifier");

  // 3. Deploy C2CAdmin(verifierAddress)
  const c2cAdmin = await viem.deployContract("C2CAdmin", [tlsnVerifier.address]);

  // 4. Deploy C2CEscrow(adminAddress, verifierAddress)
  const c2cEscrow = await viem.deployContract("C2CEscrow", [
    c2cAdmin.address,
    tlsnVerifier.address,
  ]);

  // 5. Configure authorization: TLSNVerifier authorizes C2CAdmin and C2CEscrow
  await tlsnVerifier.write.setAuthorizedCaller([c2cAdmin.address, true]);
  await tlsnVerifier.write.setAuthorizedCaller([c2cEscrow.address, true]);

  // 6. C2CAdmin authorizes C2CEscrow
  await c2cAdmin.write.setAuthorizedCaller([c2cEscrow.address, true]);

  // 7. Add supported crypto (USDT) and fiat (CNY, MYR)
  await c2cAdmin.write.addCryptoInfo([usdt.address, true]);
  await c2cAdmin.write.addFiatInfo(["CNY", true]); // id=0
  await c2cAdmin.write.addFiatInfo(["MYR", true]); // id=1

  // 8. Add trusted verifier
  await tlsnVerifier.write.addTrustedVerifier([verifierSigner.account.address]);

  // 9. Add trusted KYB server
  await tlsnVerifier.write.addTrustedKYBServer(["kyb.example.com"]);

  // 10. Add trusted payment servers
  await tlsnVerifier.write.addTrustedPaymentServer(["wise.com"]);
  await tlsnVerifier.write.addTrustedPaymentServer(["mbillexprod.alipay.com"]);

  // 11. Deploy platform verifiers and register them
  const wisePlatformVerifier = await viem.deployContract("WisePlatformVerifier", [
    tlsnVerifier.address,
  ]);
  const alipayPlatformVerifier = await viem.deployContract("AlipayPlatformVerifier", [
    tlsnVerifier.address,
  ]);

  const PLATFORM_WISE = await tlsnVerifier.read.PLATFORM_WISE();
  const PLATFORM_ALIPAY = await tlsnVerifier.read.PLATFORM_ALIPAY();
  await tlsnVerifier.write.setPlatformVerifier([PLATFORM_WISE, wisePlatformVerifier.address]);
  await tlsnVerifier.write.setPlatformVerifier([PLATFORM_ALIPAY, alipayPlatformVerifier.address]);

  // 12. Deploy V4: C2CRiskManager + C2CBondVault
  const c2cRiskManager = await viem.deployContract("C2CRiskManager", [c2cAdmin.address]);
  const c2cBondVault   = await viem.deployContract("C2CBondVault",   [c2cAdmin.address]);

  // 13. Wire managers into escrow
  await c2cEscrow.write.setManagers([
    c2cRiskManager.address,
    c2cBondVault.address,
  ]);

  // 14. Grant escrow permission to call riskManager and bondVault
  await c2cRiskManager.write.setEscrow([c2cEscrow.address]);
  await c2cBondVault.write.setEscrow([c2cEscrow.address]);

  // 15. Mint USDT to merchant and buyer
  const mintAmount = parseUnits("100000", 18);
  await usdt.write.mint([merchant.account.address, mintAmount]);
  await usdt.write.mint([buyer.account.address, mintAmount]);

  // Contract instances connected to specific wallets
  const usdtAsMerchant = await viem.getContractAt("MockERC20", usdt.address, {
    client: { wallet: merchant },
  });
  const usdtAsBuyer = await viem.getContractAt("MockERC20", usdt.address, {
    client: { wallet: buyer },
  });
  const escrowAsMerchant = await viem.getContractAt("C2CEscrow", c2cEscrow.address, {
    client: { wallet: merchant },
  });
  const escrowAsBuyer = await viem.getContractAt("C2CEscrow", c2cEscrow.address, {
    client: { wallet: buyer },
  });
  const adminAsMerchant = await viem.getContractAt("C2CAdmin", c2cAdmin.address, {
    client: { wallet: merchant },
  });
  const riskManagerAsDeployer = await viem.getContractAt(
    "C2CRiskManager", c2cRiskManager.address,
    { client: { wallet: deployer } },
  );
  const bondVaultAsBuyer = await viem.getContractAt(
    "C2CBondVault", c2cBondVault.address,
    { client: { wallet: buyer } },
  );
  const bondVaultAsMerchant = await viem.getContractAt(
    "C2CBondVault", c2cBondVault.address,
    { client: { wallet: merchant } },
  );

  // 16. Pre-warm storage for default buyer and merchant.
  // Turns cold SSTORE (20,000 gas) → warm SSTORE (2,900 gas) for reps and
  // _claimable slots. Must be called before any order flow. initReputation /
  // initClaimable have no access control so the deployer wallet can call them
  // on behalf of any address.
  await c2cRiskManager.write.initReputation([merchant.account.address]);
  await c2cRiskManager.write.initReputation([buyer.account.address]);
  await c2cBondVault.write.initClaimable([merchant.account.address, usdt.address]);
  await c2cBondVault.write.initClaimable([buyer.account.address, usdt.address]);

  // 17. Default buyer bindings — Phase 1.2+ placeOrder requires buyers to be
  // bound on the platform. Pre-seed both Wise and Alipay for every wallet
  // EXCEPT the merchant, using the per-platform BUYER_* constants the
  // existing FIAT tests already use, so the default BUYER_INFO /
  // ALIPAY_BUYER_INFO in each test file lines up with the on-chain binding
  // for any wallet that might end up placing orders (including
  // walletClients[6..9] which Bond.ts uses for forced-timeout sequences).
  // Merchant is intentionally LEFT UNBOUND here — each test's setupBase
  // sets merchant binding explicitly, and C2CAdmin.ts ADM-FLOW-07C asserts
  // a merchant whose Alipay binding has never been written reads back as
  // isSet=false.
  // Tests that need an "unbound buyer" must spawn a fresh wallet themselves.
  const wiseBuyerNameHash    = keccak256(toBytes(BUYER_NAME));
  const wiseBuyerIdHash      = keccak256(toBytes(BUYER_HANDLE));
  const alipayBuyerNameHash  = keccak256(toBytes(ALIPAY_BUYER_NAME));
  const alipayBuyerIdHash    = keccak256(toBytes(ALIPAY_BUYER_HANDLE));
  const merchantAddr = merchant.account.address.toLowerCase();
  for (const wallet of walletClients) {
    if (wallet.account.address.toLowerCase() === merchantAddr) continue;
    const adminWc = await viem.getContractAt("C2CAdmin", c2cAdmin.address, { client: { wallet } });
    await adminWc.write.setPlatformBinding([PLATFORM_WISE,   wiseBuyerNameHash,   wiseBuyerIdHash]);
    await adminWc.write.setPlatformBinding([PLATFORM_ALIPAY, alipayBuyerNameHash, alipayBuyerIdHash]);
  }

  return {
    // Core contracts
    usdt,
    tlsnVerifier,
    c2cAdmin,
    c2cEscrow,
    wisePlatformVerifier,
    alipayPlatformVerifier,
    // V4 contracts
    c2cRiskManager,
    c2cBondVault,
    // Wallet-connected contracts
    usdtAsMerchant,
    usdtAsBuyer,
    escrowAsMerchant,
    escrowAsBuyer,
    adminAsMerchant,
    riskManagerAsDeployer,
    bondVaultAsBuyer,
    bondVaultAsMerchant,
    // Wallet clients
    deployer,
    verifierSigner,
    merchant,
    buyer,
    randomUser,
    newAdmin,
  };
}

export type DeployResult = Awaited<ReturnType<typeof deployAll>>;
