/**
 * Rate.ts
 *
 * Tests for the on-chain rate publishing system (MVP).
 *
 * RATE-01 to RATE-10: rate publishing, expiry, rateVersion snapshot, D-1 proof.
 *
 * Key invariants:
 *   - publishedAt == 0  → "never published" sentinel  (placeOrder → RateNotPublished)
 *   - expiresAt != 0 && expiresAt <= now → RateExpired at placeOrder time
 *   - rateVersion is snapshoted at order placement; subsequent publishRate does not affect existing orders (D-1)
 *   - Version increments monotonically: first publish → v1, second → v2
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { network } from "hardhat";
import { keccak256, toBytes, type Hex } from "viem";

import { deployAll, type DeployResult } from "./helpers/deploy.js";
import { buildAlipayProof, toAlipayGmtSuccess } from "./helpers/proofBuilder.js";
import { computeOrderBindingHash } from "./helpers/orderBindingHash.js";
import { advanceTime } from "./helpers/time.js";
import {
  TRADE_AMOUNT,
  COLLATERAL,
  RATE_ALIPAY_CRYPTO,
  ALIPAY_AMOUNT_STR,
  ALIPAY_SERVER,
  CNY_FIAT_ID,
  USDT_CRYPTO_ID,
  ALIPAY_MERCHANT_NAME,
  ALIPAY_MERCHANT_HANDLE,
  ALIPAY_BUYER_NAME,
  ALIPAY_BUYER_HANDLE,
  ZERO_HASH,
  RATE_VERSION_INITIAL,
} from "./helpers/constants.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const CHAIN_ID = 31337n;

const MERCHANT_NAME_HASH = keccak256(toBytes(ALIPAY_MERCHANT_NAME));
const MERCHANT_ID_HASH   = keccak256(toBytes(ALIPAY_MERCHANT_HANDLE));
const BUYER_NAME_HASH    = keccak256(toBytes(ALIPAY_BUYER_NAME));
const BUYER_ID_HASH      = keccak256(toBytes(ALIPAY_BUYER_HANDLE));

const NULL_BUYER_INFO = { nameHash: ZERO_HASH, idHash: ZERO_HASH, isSet: false } as const;

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

  return { d, pc, PLATFORM_ALIPAY };
}

async function nowTs(pc: any): Promise<bigint> {
  return (await pc.getBlock()).timestamp;
}

/** Place a CRYPTO order and return orderId + deadline + rateVersion. */
async function placeCryptoOrder(d: DeployResult): Promise<{ deadline: bigint; rateVersion: bigint }> {
  await d.escrowAsBuyer.write.placeOrder([
    d.merchant.account.address, 0n, 0, TRADE_AMOUNT, NULL_BUYER_INFO,
  ]);
  const [, , , deadline, , rateVersion] = await d.c2cEscrow.read.getOrder([
    d.merchant.account.address, 0n, 0, 0n,
  ]);
  return { deadline, rateVersion: BigInt(rateVersion) };
}

/** Build an Alipay CRYPTO proof for the given order. */
async function buildCryptoProof(
  d: DeployResult,
  deadline: bigint,
  orderId: bigint,
  rateVersion: bigint,
  rate: bigint = RATE_ALIPAY_CRYPTO,
) {
  const platformAlipay: Hex = await d.tlsnVerifier.read.PLATFORM_ALIPAY();
  const merchantInfo = await d.c2cAdmin.read.getPlatformBinding([
    d.merchant.account.address,
    platformAlipay,
  ]);
  const obh = computeOrderBindingHash({
    escrow:           d.c2cEscrow.address,
    chainId:          CHAIN_ID,
    merchant:         d.merchant.account.address,
    buyer:            d.buyer.account.address,
    productId:        0n,
    orderId,
    assetType:        0,
    amount:           TRADE_AMOUNT,
    rate,
    rateVersion,
    deadline,
    merchantNameHash: merchantInfo.nameHash,
    merchantIdHash:   merchantInfo.idHash,
    payeeNameHash:    merchantInfo.nameHash,
    payeeIdHash:      merchantInfo.idHash,
  });
  return buildAlipayProof({
    fields: {
      payAmount:  ALIPAY_AMOUNT_STR,
      status:     "SUCCESS",
      bizType:    "TRANSFER",
      orderId:    `RATE-TEST-${orderId}`,
      gmtSuccess: toAlipayGmtSuccess(deadline - 60n),
    },
    verifierWallet:   d.verifierSigner,
    orderBindingHash: obh,
    chainId:          CHAIN_ID,
    serverName:       ALIPAY_SERVER,
  });
}

// ══════════════════════════════════════════════════════════════════════════════

describe("Rate", async function () {
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

    await d.escrowAsMerchant.write.listCryptoProduct([
      USDT_CRYPTO_ID, CNY_FIAT_ID, COLLATERAL, true, PLATFORM_ALIPAY,
    ]);
    snap = await testClient.snapshot();
  });
  beforeEach(async () => {
    await testClient.revert({ id: snap });
    snap = await testClient.snapshot();
  });

  // ── Rate not published ──────────────────────────────────────────────────────

  it("RATE-01: placeOrder before publishRate → RateNotPublished", async () => {
    // No publishRate called → publishedAt == 0
    await d.adminAsMerchant.write.openNow([0n, 0]); // open but no rate
    await viem.assertions.revertWithCustomError(
      d.escrowAsBuyer.write.placeOrder([
        d.merchant.account.address, 0n, 0, TRADE_AMOUNT, NULL_BUYER_INFO,
      ]),
      d.c2cEscrow,
      "RateNotPublished",
    );
  });

  // ── Rate published, version increments ─────────────────────────────────────

  it("RATE-02: first publishRate → version == 1", async () => {
    await d.adminAsMerchant.write.publishRate([0n, 0, RATE_ALIPAY_CRYPTO, 0n]);
    const mr = await d.c2cAdmin.read.getMerchantRate([d.merchant.account.address, 0n, 0]);
    assert.equal(BigInt(mr.version), RATE_VERSION_INITIAL, "first publish should yield version 1");
  });

  it("RATE-03: second publishRate → version == 2", async () => {
    await d.adminAsMerchant.write.publishRate([0n, 0, RATE_ALIPAY_CRYPTO, 0n]);
    await d.adminAsMerchant.write.publishRate([0n, 0, RATE_ALIPAY_CRYPTO * 2n, 0n]);
    const mr = await d.c2cAdmin.read.getMerchantRate([d.merchant.account.address, 0n, 0]);
    assert.equal(BigInt(mr.version), 2n, "second publish should yield version 2");
    assert.equal(mr.rate, RATE_ALIPAY_CRYPTO * 2n);
  });

  // ── rateVersion snapshotted at order placement ──────────────────────────────

  it("RATE-04: placeOrder snapshots rateVersion in Order struct", async () => {
    await d.adminAsMerchant.write.publishRate([0n, 0, RATE_ALIPAY_CRYPTO, 0n]);
    await d.adminAsMerchant.write.openNow([0n, 0]);

    const { rateVersion } = await placeCryptoOrder(d);
    assert.equal(rateVersion, RATE_VERSION_INITIAL, "rateVersion should be 1 at time of placeOrder");
  });

  it("RATE-05: placeOrder after second publishRate snapshots version 2", async () => {
    await d.adminAsMerchant.write.publishRate([0n, 0, RATE_ALIPAY_CRYPTO, 0n]);
    await d.adminAsMerchant.write.publishRate([0n, 0, RATE_ALIPAY_CRYPTO * 2n, 0n]);
    await d.adminAsMerchant.write.openNow([0n, 0]);

    const { rateVersion } = await placeCryptoOrder(d);
    assert.equal(rateVersion, 2n, "rateVersion should reflect version at placeOrder time");
  });

  // ── D-1: rate snapshot isolates existing orders ─────────────────────────────

  it("RATE-06 (D-1): publishRate after placeOrder does not affect existing order proof", async () => {
    await d.adminAsMerchant.write.publishRate([0n, 0, RATE_ALIPAY_CRYPTO, 0n]);
    await d.adminAsMerchant.write.openNow([0n, 0]);

    const { deadline, rateVersion } = await placeCryptoOrder(d);
    assert.equal(rateVersion, RATE_VERSION_INITIAL);

    // Merchant updates rate after order placed
    await d.adminAsMerchant.write.publishRate([0n, 0, RATE_ALIPAY_CRYPTO * 3n, 0n]);

    // Build proof with OLD rate and OLD rateVersion (as captured at order time)
    const proof = await buildCryptoProof(d, deadline, 0n, rateVersion, RATE_ALIPAY_CRYPTO);
    const buyerBefore = await d.usdt.read.balanceOf([d.buyer.account.address]);
    await d.escrowAsBuyer.write.payOrderByPlatform([d.merchant.account.address, 0n, 0n, [proof]]);
    const buyerAfter = await d.usdt.read.balanceOf([d.buyer.account.address]);
    assert.equal(buyerAfter - buyerBefore, TRADE_AMOUNT, "D-1: old rateVersion proof should complete successfully");
  });

  it("RATE-07 (D-1): proof built with new rateVersion fails for old order → OrderBindingHashMismatch", async () => {
    await d.adminAsMerchant.write.publishRate([0n, 0, RATE_ALIPAY_CRYPTO, 0n]);
    await d.adminAsMerchant.write.openNow([0n, 0]);

    const { deadline } = await placeCryptoOrder(d); // order uses rateVersion=1
    await d.adminAsMerchant.write.publishRate([0n, 0, RATE_ALIPAY_CRYPTO * 2n, 0n]); // now v2

    // Build proof with rateVersion=2 but order is bound to rateVersion=1 → mismatch
    const wrongRv = 2n;
    const proof = await buildCryptoProof(d, deadline, 0n, wrongRv, RATE_ALIPAY_CRYPTO);
    await viem.assertions.revertWithCustomError(
      d.escrowAsBuyer.write.payOrderByPlatform([d.merchant.account.address, 0n, 0n, [proof]]),
      d.c2cEscrow,
      "OrderBindingHashMismatch",
    );
  });

  // ── Rate expiry ─────────────────────────────────────────────────────────────

  it("RATE-08: expired rate at placeOrder time → RateExpired", async () => {
    const ts = await nowTs(pc);
    // Publish rate that expires in 60 seconds
    await d.adminAsMerchant.write.publishRate([0n, 0, RATE_ALIPAY_CRYPTO, ts + 60n]);
    await d.adminAsMerchant.write.openNow([0n, 0]);

    // Advance past expiry
    await advanceTime(testClient, 65);

    await viem.assertions.revertWithCustomError(
      d.escrowAsBuyer.write.placeOrder([
        d.merchant.account.address, 0n, 0, TRADE_AMOUNT, NULL_BUYER_INFO,
      ]),
      d.c2cEscrow,
      "RateExpired",
    );
  });

  it("RATE-09: expiresAt == 0 means no expiry → placeOrder succeeds", async () => {
    await d.adminAsMerchant.write.publishRate([0n, 0, RATE_ALIPAY_CRYPTO, 0n]); // 0 = no expiry
    await d.adminAsMerchant.write.openNow([0n, 0]);
    await advanceTime(testClient, 86400); // advance 1 day

    // Should still succeed — rate never expires
    const { rateVersion } = await placeCryptoOrder(d);
    assert.equal(rateVersion, RATE_VERSION_INITIAL, "order should be placed with non-expiring rate");
  });
});
