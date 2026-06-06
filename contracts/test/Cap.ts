/**
 * Cap.ts
 *
 * Tests for the per-order USD amount cap (MVP, D-3).
 *
 * CAP-01 to CAP-05:
 *   CAP-01: amount == maxOrderAmount (1000 USDT) → succeeds
 *   CAP-02: amount < maxOrderAmount (999 USDT) → succeeds
 *   CAP-03: amount > maxOrderAmount (1001 USDT) → ExceedsUsdCap
 *   CAP-04: admin sets lower cap → new cap enforced immediately
 *   CAP-05: FIAT product also capped at placeOrder
 *
 * The cap is a per-single-order limit (D-3), not cumulative.
 * USD parity: 1 USDT = 1 USD (D-5), so cap is checked directly as amount > maxOrderAmount.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { network } from "hardhat";
import { keccak256, toBytes, type Hex } from "viem";

import { deployAll, type DeployResult } from "./helpers/deploy.js";
import {
  RATE_ALIPAY_CRYPTO,
  RATE_ALIPAY_FIAT,
  CNY_FIAT_ID,
  MYR_FIAT_ID,
  USDT_CRYPTO_ID,
  ALIPAY_MERCHANT_NAME,
  ALIPAY_MERCHANT_HANDLE,
  ALIPAY_BUYER_NAME,
  ALIPAY_BUYER_HANDLE,
  ZERO_HASH,
  MAX_ORDER_AMOUNT,
} from "./helpers/constants.js";

// Cap tests need collateral >= MAX_ORDER_AMOUNT so that InsufficientAvailable is
// not triggered before ExceedsUsdCap. COLLATERAL (10 USDT) is intentionally kept
// small for other suites; use a dedicated constant here.
const CAP_COLLATERAL = MAX_ORDER_AMOUNT * 2n; // 2000 USDT

// ─── Constants ──────────────────────────────────────────────────────────────

const MERCHANT_NAME_HASH = keccak256(toBytes(ALIPAY_MERCHANT_NAME));
const MERCHANT_ID_HASH   = keccak256(toBytes(ALIPAY_MERCHANT_HANDLE));
const BUYER_NAME_HASH    = keccak256(toBytes(ALIPAY_BUYER_NAME));
const BUYER_ID_HASH      = keccak256(toBytes(ALIPAY_BUYER_HANDLE));

const NULL_BUYER_INFO  = { nameHash: ZERO_HASH,       idHash: ZERO_HASH,    isSet: false } as const;
const BUYER_PAYMENT_INFO = { nameHash: BUYER_NAME_HASH, idHash: BUYER_ID_HASH, isSet: true  } as const;

// 1e18 = 1 USDT
const ONE_USDT = 10n ** 18n;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function setupBase(viem: any) {
  const d = await deployAll(viem);
  const pc = await viem.getPublicClient();
  const PLATFORM_ALIPAY: Hex = await d.tlsnVerifier.read.PLATFORM_ALIPAY();

  await d.c2cAdmin.write.registerMerchantByAdmin([d.merchant.account.address]);
  await d.adminAsMerchant.write.setPlatformBinding([
    PLATFORM_ALIPAY,
    MERCHANT_NAME_HASH,
    MERCHANT_ID_HASH,
  ]);

  const MAX = 2n ** 256n - 1n;
  await d.usdtAsMerchant.write.approve([d.c2cEscrow.address, MAX]);
  await d.usdtAsBuyer.write.approve([d.c2cEscrow.address, MAX]);

  // List CRYPTO product (productId = 0)
  await d.escrowAsMerchant.write.listCryptoProduct([
    USDT_CRYPTO_ID, CNY_FIAT_ID, CAP_COLLATERAL, true, PLATFORM_ALIPAY,
  ]);
  await d.adminAsMerchant.write.publishRate([0n, 0, RATE_ALIPAY_CRYPTO, 0n]);
  await d.adminAsMerchant.write.openNow([0n, 0]);

  return { d, pc, PLATFORM_ALIPAY };
}

// ══════════════════════════════════════════════════════════════════════════════

describe("Cap", async function () {
  const { viem }   = await network.getOrCreate();
  const testClient = await viem.getTestClient();

  let d: DeployResult;
  let pc: any;
  let PLATFORM_ALIPAY: Hex;
  let snap: Hex;

  before(async () => {
    const setup = await setupBase(viem);
    d = setup.d;
    pc = setup.pc;
    PLATFORM_ALIPAY = setup.PLATFORM_ALIPAY;
    snap = await testClient.snapshot();
  });
  beforeEach(async () => {
    await testClient.revert({ id: snap });
    snap = await testClient.snapshot();
  });

  // ── CRYPTO product cap ───────────────────────────────────────────────────

  it("CAP-01: amount == maxOrderAmount (1000 USDT) → placeOrder succeeds", async () => {
    await d.escrowAsBuyer.write.placeOrder([
      d.merchant.account.address, 0n, 0, MAX_ORDER_AMOUNT, NULL_BUYER_INFO,
    ]);
    const [buyer] = await d.c2cEscrow.read.getOrder([d.merchant.account.address, 0n, 0, 0n]);
    assert.equal(buyer.toLowerCase(), d.buyer.account.address.toLowerCase());
  });

  it("CAP-02: amount < maxOrderAmount (999 USDT) → placeOrder succeeds", async () => {
    const amount = MAX_ORDER_AMOUNT - ONE_USDT; // 999 USDT
    await d.escrowAsBuyer.write.placeOrder([
      d.merchant.account.address, 0n, 0, amount, NULL_BUYER_INFO,
    ]);
    const [buyer] = await d.c2cEscrow.read.getOrder([d.merchant.account.address, 0n, 0, 0n]);
    assert.equal(buyer.toLowerCase(), d.buyer.account.address.toLowerCase());
  });

  it("CAP-03: amount > maxOrderAmount (1001 USDT) → ExceedsUsdCap", async () => {
    const amount = MAX_ORDER_AMOUNT + ONE_USDT; // 1001 USDT
    await viem.assertions.revertWithCustomError(
      d.escrowAsBuyer.write.placeOrder([
        d.merchant.account.address, 0n, 0, amount, NULL_BUYER_INFO,
      ]),
      d.c2cEscrow,
      "ExceedsUsdCap",
    );
  });

  // ── Admin lowers cap ──────────────────────────────────────────────────────

  it("CAP-04: admin lowers maxOrderAmount to 500 USDT → 600 USDT order → ExceedsUsdCap", async () => {
    const newCap = 500n * ONE_USDT;
    await d.c2cAdmin.write.setMaxOrderAmount([newCap]);
    assert.equal(await d.c2cAdmin.read.maxOrderAmount(), newCap, "cap should be updated");

    // 600 USDT should now exceed the new cap
    const amount = 600n * ONE_USDT;
    await viem.assertions.revertWithCustomError(
      d.escrowAsBuyer.write.placeOrder([
        d.merchant.account.address, 0n, 0, amount, NULL_BUYER_INFO,
      ]),
      d.c2cEscrow,
      "ExceedsUsdCap",
    );

    // 500 USDT should succeed
    await d.escrowAsBuyer.write.placeOrder([
      d.merchant.account.address, 0n, 0, newCap, NULL_BUYER_INFO,
    ]);
    const [buyer] = await d.c2cEscrow.read.getOrder([d.merchant.account.address, 0n, 0, 0n]);
    assert.equal(buyer.toLowerCase(), d.buyer.account.address.toLowerCase());
  });

  // ── FIAT product cap ──────────────────────────────────────────────────────

  it("CAP-05: FIAT product — amount > maxOrderAmount → ExceedsUsdCap", async () => {
    // List FIAT product (productId = 0 for FIAT type)
    await d.escrowAsMerchant.write.listFiatProduct([
      CNY_FIAT_ID, USDT_CRYPTO_ID, CAP_COLLATERAL, true, PLATFORM_ALIPAY,
    ]);
    await d.adminAsMerchant.write.publishRate([0n, 1, RATE_ALIPAY_FIAT, 0n]);
    await d.adminAsMerchant.write.openNow([0n, 1]);

    const overCap = MAX_ORDER_AMOUNT + ONE_USDT;
    await viem.assertions.revertWithCustomError(
      d.escrowAsBuyer.write.placeOrder([
        d.merchant.account.address, 0n, 1, overCap, BUYER_PAYMENT_INFO,
      ]),
      d.c2cEscrow,
      "ExceedsUsdCap",
    );
  });

  it("CAP-06: D-3 — cap is per-order, not cumulative (two 600 USDT orders after admin raises cap)", async () => {
    // Raise cap to 1500 USDT so two 600 USDT orders can each be placed
    const raisedCap = 1500n * ONE_USDT;
    await d.c2cAdmin.write.setMaxOrderAmount([raisedCap]);

    const amount = 600n * ONE_USDT;
    const MAX = 2n ** 256n - 1n;

    // First order by buyer
    await d.escrowAsBuyer.write.placeOrder([
      d.merchant.account.address, 0n, 0, amount, NULL_BUYER_INFO,
    ]);
    const [b1] = await d.c2cEscrow.read.getOrder([d.merchant.account.address, 0n, 0, 0n]);
    assert.equal(b1.toLowerCase(), d.buyer.account.address.toLowerCase(), "first order should succeed");

    // V4: cancelOrder is disabled; use a second buyer for the second order
    await d.usdt.write.mint([d.randomUser.account.address, amount * 2n]);
    const escrowAsRandom = await viem.getContractAt("C2CEscrow", d.c2cEscrow.address, { client: { wallet: d.randomUser } });
    const usdtAsRandom   = await viem.getContractAt("MockERC20",  d.usdt.address,      { client: { wallet: d.randomUser } });
    await usdtAsRandom.write.approve([d.c2cEscrow.address,  MAX]);
    await usdtAsRandom.write.approve([d.c2cBondVault.address, MAX]);

    // Second order of same amount — should also succeed (cap is per-order, not sum)
    await escrowAsRandom.write.placeOrder([
      d.merchant.account.address, 0n, 0, amount, NULL_BUYER_INFO,
    ]);
    const [b2] = await d.c2cEscrow.read.getOrder([d.merchant.account.address, 0n, 0, 1n]);
    assert.equal(b2.toLowerCase(), d.randomUser.account.address.toLowerCase(), "second order should also succeed");
  });
});
