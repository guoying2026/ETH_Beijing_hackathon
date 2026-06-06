/**
 * BindingGating.ts — Phase 1.2 placeOrder gate tests
 *
 * Covers the three new requires added to C2CEscrow.placeOrder:
 *   - SelfTradeNotAllowed  : msg.sender == _merchant
 *   - BuyerBindingNotSet   : buyer not bound on the product's platform
 *   - BuyerBindingMismatch : FIAT _buyerInfo != buyer's on-chain binding
 *
 * Plus the cross-cutting invariants:
 *   - happy path (bound buyer + non-self + matching _buyerInfo) succeeds
 *   - re-binding the merchant after order placement does NOT mutate the
 *     order's frozen merchant hashes (Order.merchantNameHash / IdHash)
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { network } from "hardhat";
import { keccak256, parseEther, parseUnits, toBytes, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { deployAll, type DeployResult } from "./helpers/deploy.js";
import {
  addRecord,
  clearRecords,
  makeCtx,
  printTable,
} from "./helpers/tableReporter.js";
import {
  BUYER_HANDLE,
  BUYER_NAME,
  COLLATERAL,
  MYR_FIAT_ID,
  RATE_WISE_CRYPTO,
  RATE_WISE_FIAT,
  TRADE_AMOUNT,
  USDT_CRYPTO_ID,
  WISE_MERCHANT_HANDLE,
  WISE_MERCHANT_NAME,
  ZERO_HASH,
} from "./helpers/constants.js";

const ASSET_CRYPTO = 0;
const ASSET_FIAT = 1;
const WISE_CRYPTO_PID = 0n;
const WISE_FIAT_PID = 0n;
const MAX_UINT = (2n ** 256n) - 1n;

const MERCHANT_NAME_HASH = keccak256(toBytes(WISE_MERCHANT_NAME));
const MERCHANT_ID_HASH   = keccak256(toBytes(WISE_MERCHANT_HANDLE));
const BUYER_NAME_HASH    = keccak256(toBytes(BUYER_NAME));
const BUYER_ID_HASH      = keccak256(toBytes(BUYER_HANDLE));

const NULL_BUYER_INFO = { nameHash: ZERO_HASH, idHash: ZERO_HASH, isSet: false } as const;
const BUYER_INFO = { nameHash: BUYER_NAME_HASH, idHash: BUYER_ID_HASH, isSet: true } as const;

// A merchant rebind value distinct from the original — used to prove old
// orders keep their frozen hashes after the merchant changes binding.
const MERCHANT_REBIND_NAME_HASH = keccak256(toBytes("REBIND_MERCHANT_NAME"));
const MERCHANT_REBIND_ID_HASH   = keccak256(toBytes("@rebind_merchant"));

async function expectRevert(promise: Promise<unknown>, expected: string | RegExp) {
  try {
    await promise;
    assert.fail("Expected transaction to revert");
  } catch (err: any) {
    const re = typeof expected === "string" ? new RegExp(expected) : expected;
    const text = [err?.message, err?.shortMessage, err?.details, String(err)]
      .filter(Boolean).join("\n");
    assert.match(text, re);
  }
}

async function setupBase(viem: any) {
  const d = await deployAll(viem);
  const pc = await viem.getPublicClient();
  const PLATFORM_WISE: Hex = await d.tlsnVerifier.read.PLATFORM_WISE();

  // Register merchant + set merchant Wise binding.
  // (deployAll has already pre-seeded d.buyer and d.randomUser bindings.)
  await d.c2cAdmin.write.registerMerchantByAdmin([d.merchant.account.address]);
  await d.adminAsMerchant.write.setPlatformBinding([
    PLATFORM_WISE, MERCHANT_NAME_HASH, MERCHANT_ID_HASH,
  ]);

  await d.usdtAsMerchant.write.approve([d.c2cEscrow.address, MAX_UINT]);
  await d.usdtAsBuyer.write.approve([d.c2cEscrow.address, MAX_UINT]);
  await d.usdtAsBuyer.write.approve([d.c2cBondVault.address, MAX_UINT]);

  // Wise: CRYPTO pid=0 + FIAT pid=0
  await d.escrowAsMerchant.write.listCryptoProduct([
    USDT_CRYPTO_ID, MYR_FIAT_ID, COLLATERAL, true, PLATFORM_WISE,
  ]);
  await d.escrowAsMerchant.write.listFiatProduct([
    MYR_FIAT_ID, USDT_CRYPTO_ID, COLLATERAL, true, PLATFORM_WISE,
  ]);

  const expiry = (await pc.getBlock()).timestamp + 365n * 24n * 3600n;
  await d.adminAsMerchant.write.publishRate([WISE_CRYPTO_PID, ASSET_CRYPTO, RATE_WISE_CRYPTO, expiry]);
  await d.adminAsMerchant.write.publishRate([WISE_FIAT_PID,   ASSET_FIAT,   RATE_WISE_FIAT,   expiry]);
  await d.adminAsMerchant.write.openNow([WISE_CRYPTO_PID, ASSET_CRYPTO]);
  await d.adminAsMerchant.write.openNow([WISE_FIAT_PID,   ASSET_FIAT]);

  return { d, pc, PLATFORM_WISE };
}

describe("placeOrder binding gates (Phase 1.2)", function () {
  let viem: any;

  before(async () => {
    clearRecords();
    ({ viem } = await network.getOrCreate());
  });

  after(() => {
    printTable("BindingGating (Phase 1.2)");
  });

  // ── BG-01 ─────────────────────────────────────────────────────────────────
  it("BG-01: merchant placing own order → revert SelfTradeNotAllowed", async () => {
    const ctx = makeCtx();
    const { d } = await setupBase(viem);

    // merchant must approve bondVault for the (hypothetical) bond pull
    await d.usdtAsMerchant.write.approve([d.c2cBondVault.address, MAX_UINT]);

    await expectRevert(
      d.escrowAsMerchant.write.placeOrder([
        d.merchant.account.address, WISE_CRYPTO_PID, ASSET_CRYPTO, TRADE_AMOUNT, NULL_BUYER_INFO,
      ]),
      /SelfTradeNotAllowed/,
    );
    addRecord("BG-01", "self-trade blocked", true, ctx);
  });

  // ── BG-02 ─────────────────────────────────────────────────────────────────
  it("BG-02: unbound buyer placing order → revert BuyerBindingNotSet", async () => {
    const ctx = makeCtx();
    const { d } = await setupBase(viem);

    // deployAll pre-binds every wallet in walletClients, so we spawn a fresh
    // unbound address via impersonation to exercise the BuyerBindingNotSet path.
    const address = privateKeyToAccount(generatePrivateKey()).address;
    const tc = await viem.getTestClient();
    await tc.setBalance({ address, value: parseEther("10") });
    await tc.impersonateAccount({ address });
    await d.usdt.write.mint([address, parseUnits("1000", 18)]);
    const wc = await viem.getWalletClient(address);
    const usdtWc = await viem.getContractAt("MockERC20", d.usdt.address, {
      client: { wallet: wc },
    });
    await usdtWc.write.approve([d.c2cEscrow.address,    MAX_UINT]);
    await usdtWc.write.approve([d.c2cBondVault.address, MAX_UINT]);
    const escrowWc = await viem.getContractAt("C2CEscrow", d.c2cEscrow.address, {
      client: { wallet: wc },
    });

    await expectRevert(
      escrowWc.write.placeOrder([
        d.merchant.account.address, WISE_CRYPTO_PID, ASSET_CRYPTO, TRADE_AMOUNT, NULL_BUYER_INFO,
      ]),
      /BuyerBindingNotSet/,
    );
    addRecord("BG-02", "unbound buyer blocked", true, ctx);
  });

  // ── BG-03 ─────────────────────────────────────────────────────────────────
  it("BG-03: FIAT _buyerInfo mismatch → revert BuyerBindingMismatch", async () => {
    const ctx = makeCtx();
    const { d } = await setupBase(viem);

    const tampered = {
      nameHash: keccak256(toBytes("ATTACKER_NAME")),
      idHash:   keccak256(toBytes("@attacker")),
      isSet:    true,
    } as const;

    await expectRevert(
      d.escrowAsBuyer.write.placeOrder([
        d.merchant.account.address, WISE_FIAT_PID, ASSET_FIAT, TRADE_AMOUNT, tampered,
      ]),
      /BuyerBindingMismatch/,
    );
    addRecord("BG-03", "FIAT buyerInfo mismatch blocked", true, ctx);
  });

  // ── BG-04 ─────────────────────────────────────────────────────────────────
  it("BG-04: happy path — bound buyer with matching FIAT _buyerInfo succeeds", async () => {
    const ctx = makeCtx();
    const { d } = await setupBase(viem);

    // CRYPTO: bound buyer, non-self
    await d.escrowAsBuyer.write.placeOrder([
      d.merchant.account.address, WISE_CRYPTO_PID, ASSET_CRYPTO, TRADE_AMOUNT, NULL_BUYER_INFO,
    ]);
    const cryptoOrder = await d.c2cEscrow.read.getOrder([
      d.merchant.account.address, WISE_CRYPTO_PID, ASSET_CRYPTO, 0n,
    ]);
    assert.equal(cryptoOrder[0].toLowerCase(), d.buyer.account.address.toLowerCase(),
      "CRYPTO order.buyer should be d.buyer");
    assert.equal(cryptoOrder[7], MERCHANT_NAME_HASH, "CRYPTO order.merchantNameHash frozen");
    assert.equal(cryptoOrder[8], MERCHANT_ID_HASH,   "CRYPTO order.merchantIdHash   frozen");

    // FIAT: matching buyerInfo
    await d.escrowAsBuyer.write.placeOrder([
      d.merchant.account.address, WISE_FIAT_PID, ASSET_FIAT, TRADE_AMOUNT, BUYER_INFO,
    ]);
    const fiatOrder = await d.c2cEscrow.read.getOrder([
      d.merchant.account.address, WISE_FIAT_PID, ASSET_FIAT, 0n,
    ]);
    assert.equal(fiatOrder[0].toLowerCase(), d.buyer.account.address.toLowerCase());
    assert.equal(fiatOrder[7], MERCHANT_NAME_HASH, "FIAT  order.merchantNameHash frozen");
    assert.equal(fiatOrder[8], MERCHANT_ID_HASH,   "FIAT  order.merchantIdHash   frozen");

    addRecord("BG-04", "happy path (CRYPTO + FIAT)", true, ctx);
  });

  // ── BG-05 ─────────────────────────────────────────────────────────────────
  it("BG-05: merchant rebind does not mutate frozen hashes on existing order", async () => {
    const ctx = makeCtx();
    const { d, PLATFORM_WISE } = await setupBase(viem);

    // Place order #0 under the ORIGINAL merchant binding.
    await d.escrowAsBuyer.write.placeOrder([
      d.merchant.account.address, WISE_CRYPTO_PID, ASSET_CRYPTO, TRADE_AMOUNT, NULL_BUYER_INFO,
    ]);
    const order0Before = await d.c2cEscrow.read.getOrder([
      d.merchant.account.address, WISE_CRYPTO_PID, ASSET_CRYPTO, 0n,
    ]);
    assert.equal(order0Before[7], MERCHANT_NAME_HASH);
    assert.equal(order0Before[8], MERCHANT_ID_HASH);

    // Merchant rebinds Wise to a NEW commit pair.
    await d.adminAsMerchant.write.setPlatformBinding([
      PLATFORM_WISE, MERCHANT_REBIND_NAME_HASH, MERCHANT_REBIND_ID_HASH,
    ]);
    const liveBinding = await d.c2cAdmin.read.getPlatformBinding([
      d.merchant.account.address, PLATFORM_WISE,
    ]);
    assert.equal(liveBinding.nameHash, MERCHANT_REBIND_NAME_HASH, "live binding refreshed");
    assert.equal(liveBinding.idHash,   MERCHANT_REBIND_ID_HASH);

    // Existing order #0 hashes MUST remain the originals (frozen at placeOrder).
    const order0After = await d.c2cEscrow.read.getOrder([
      d.merchant.account.address, WISE_CRYPTO_PID, ASSET_CRYPTO, 0n,
    ]);
    assert.equal(order0After[7], MERCHANT_NAME_HASH,
      "existing order.merchantNameHash must remain frozen across merchant rebind");
    assert.equal(order0After[8], MERCHANT_ID_HASH,
      "existing order.merchantIdHash   must remain frozen across merchant rebind");

    // A NEW order placed after the rebind uses the NEW commit.
    // (use d.randomUser since d.buyer already has an active order for this product)
    await d.usdt.write.mint([d.randomUser.account.address, 5_000n * 10n ** 18n]);
    const usdtAsRandom = await viem.getContractAt("MockERC20", d.usdt.address, {
      client: { wallet: d.randomUser },
    });
    await usdtAsRandom.write.approve([d.c2cEscrow.address,    MAX_UINT]);
    await usdtAsRandom.write.approve([d.c2cBondVault.address, MAX_UINT]);
    const escrowAsRandom = await viem.getContractAt("C2CEscrow", d.c2cEscrow.address, {
      client: { wallet: d.randomUser },
    });
    await escrowAsRandom.write.placeOrder([
      d.merchant.account.address, WISE_CRYPTO_PID, ASSET_CRYPTO, TRADE_AMOUNT, NULL_BUYER_INFO,
    ]);
    const order1 = await d.c2cEscrow.read.getOrder([
      d.merchant.account.address, WISE_CRYPTO_PID, ASSET_CRYPTO, 1n,
    ]);
    assert.equal(order1[7], MERCHANT_REBIND_NAME_HASH,
      "new order picks up the rebound merchantNameHash");
    assert.equal(order1[8], MERCHANT_REBIND_ID_HASH,
      "new order picks up the rebound merchantIdHash");

    addRecord("BG-05", "merchant rebind preserves old order hashes", true, ctx);
  });
});
