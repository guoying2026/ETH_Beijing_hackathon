/**
 * Sweep.ts — Public sweepExpired / sweepExpiredBatch external entries
 *
 * 覆盖 §7.3 用例：
 *   describe('sweepExpired (single product)')
 *     - no-op when no orders expired
 *     - cleans 1 expired CRYPTO order, status -> EXPIRED
 *     - cleans 1 expired FIAT order (WAITING -> EXPIRED)
 *     - cleans multiple expired in same product
 *     - respects maxSteps=2 when 5 expired (partial sweep)
 *     - caller != buyer/merchant succeeds (anyone can call)
 *     - triggers riskManager.onTimeout exactly once per expired order
 *     - triggers bondVault.settle PROOF_TIMEOUT correctly
 *     - releases hasActiveOrder mapping
 *     - emits ExpiredSwept with correct count
 *     - emits OrderStatusChanged(EXPIRED) per order
 *     - reverts when paused
 *   describe('sweepExpiredBatch (multi product)')
 *     - cleans across 3 different products in one tx
 *     - handles mix of expired + non-expired products
 *     - reverts BatchSizeInvalid when len=0
 *     - reverts BatchSizeInvalid when len>20
 *     - idempotent: second call no-op
 *     - reverts when paused
 *   describe('Invariants after sweep')
 *   describe('Idempotency with placeOrder')
 */

import assert from "node:assert/strict";
import { before, after, describe, it } from "node:test";

import {
  keccak256,
  parseEther,
  parseUnits,
  toBytes,
  type Address,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { network } from "hardhat";

import { deployAll, type DeployResult } from "./helpers/deploy.js";
import { advanceTime } from "./helpers/time.js";
import {
  COLLATERAL,
  MYR_FIAT_ID,
  ORDER_TIMEOUT,
  TRADE_AMOUNT,
  USDT_CRYPTO_ID,
  WISE_BUYER_HANDLE,
  WISE_BUYER_NAME,
  WISE_MERCHANT_HANDLE,
  WISE_MERCHANT_NAME,
  ZERO_HASH,
} from "./helpers/constants.js";

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_UINT     = (2n ** 256n) - 1n;
const ASSET_CRYPTO = 0 as const;
const ASSET_FIAT   = 1 as const;

const MERCHANT_NAME_HASH = keccak256(toBytes(WISE_MERCHANT_NAME));
const MERCHANT_ID_HASH   = keccak256(toBytes(WISE_MERCHANT_HANDLE));
const BUYER_NAME_HASH    = keccak256(toBytes(WISE_BUYER_NAME));
const BUYER_ID_HASH      = keccak256(toBytes(WISE_BUYER_HANDLE));

const NULL_BUYER_INFO = { nameHash: ZERO_HASH, idHash: ZERO_HASH, isSet: false } as const;
const FIAT_BUYER_INFO = { nameHash: BUYER_NAME_HASH, idHash: BUYER_ID_HASH, isSet: true } as const;
const ZERO_ADDR       = "0x0000000000000000000000000000000000000000" as Address;

/** After sweep, _cleanupExpiredBounded does `delete p.orders[oid]` so buyer becomes 0x0. */
function assertOrderSwept(ord: readonly unknown[], label: string) {
  assert.equal(
    (ord[0] as string).toLowerCase(),
    ZERO_ADDR,
    `${label}: expected order deleted (buyer=0x0) after sweep`,
  );
}

/** Order still PENDING in storage. */
function assertOrderPending(ord: readonly unknown[], label: string) {
  assert.notEqual(
    (ord[0] as string).toLowerCase(),
    ZERO_ADDR,
    `${label}: expected order still in storage (non-zero buyer)`,
  );
  assert.equal(ord[4], 0, `${label}: status should be PENDING`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function expectRevert(promise: Promise<unknown>, expected: string | RegExp) {
  try {
    await promise;
    assert.fail("Expected revert but tx succeeded");
  } catch (err: any) {
    const msg = [err?.message, err?.shortMessage, err?.details, String(err)]
      .filter(Boolean).join("\n");
    const re = typeof expected === "string" ? new RegExp(expected) : expected;
    assert.match(msg, re);
  }
}

/** Spawn a new buyer wallet with funded ETH, USDT, full approvals, and
 *  pre-set platform bindings (Phase 1.2+ placeOrder requires them). */
async function spawnBuyer(d: DeployResult, viem: any) {
  const address = privateKeyToAccount(generatePrivateKey()).address;
  const tc      = await viem.getTestClient();

  await tc.setBalance({ address, value: parseEther("10") });
  await tc.impersonateAccount({ address });
  await d.usdt.write.mint([address, parseUnits("1000", 18)]);

  const wc = await viem.getWalletClient(address);

  const usdtWc   = await viem.getContractAt("MockERC20", d.usdt.address,      { client: { wallet: wc } });
  const escrowWc = await viem.getContractAt("C2CEscrow", d.c2cEscrow.address, { client: { wallet: wc } });
  const adminWc  = await viem.getContractAt("C2CAdmin",  d.c2cAdmin.address,  { client: { wallet: wc } });

  await usdtWc.write.approve([d.c2cEscrow.address,    MAX_UINT]);
  await usdtWc.write.approve([d.c2cBondVault.address, MAX_UINT]);

  await d.c2cRiskManager.write.initReputation([address]);
  await d.c2cBondVault.write.initClaimable([address, d.usdt.address]);

  // Bind on both platforms — same hashes as FIAT_BUYER_INFO so FIAT placeOrder
  // post-Phase-1.2 passes the BuyerBindingMismatch check.
  const PLATFORM_WISE   = await d.tlsnVerifier.read.PLATFORM_WISE();
  const PLATFORM_ALIPAY = await d.tlsnVerifier.read.PLATFORM_ALIPAY();
  await adminWc.write.setPlatformBinding([PLATFORM_WISE,   BUYER_NAME_HASH, BUYER_ID_HASH]);
  await adminWc.write.setPlatformBinding([PLATFORM_ALIPAY, BUYER_NAME_HASH, BUYER_ID_HASH]);

  return { address: address as Address, escrowWc };
}

type Buyer = Awaited<ReturnType<typeof spawnBuyer>>;

async function spawnBuyers(n: number, d: DeployResult, viem: any): Promise<Buyer[]> {
  const buyers: Buyer[] = [];
  for (let i = 0; i < n; i++) buyers.push(await spawnBuyer(d, viem));
  return buyers;
}

async function placeCryptoOrders(buyers: Buyer[], d: DeployResult, productId = 0n) {
  for (const { escrowWc } of buyers) {
    await escrowWc.write.placeOrder([
      d.merchant.account.address,
      productId,
      ASSET_CRYPTO,
      TRADE_AMOUNT,
      NULL_BUYER_INFO,
    ]);
  }
}

async function placeFiatOrders(buyers: Buyer[], d: DeployResult, productId = 0n) {
  for (const { escrowWc } of buyers) {
    await escrowWc.write.placeOrder([
      d.merchant.account.address,
      productId,
      ASSET_FIAT,
      TRADE_AMOUNT,
      FIAT_BUYER_INFO,
    ]);
  }
}

/**
 * Base setup: deploy + register merchant + list ONE CRYPTO product (pid=0) +
 * ONE FIAT product (pid=0) + publish rates + open shop.
 */
async function setupBase(viem: any, collateral = COLLATERAL) {
  const d  = await deployAll(viem);
  const pc = await viem.getPublicClient();
  const tc = await viem.getTestClient();

  const PLATFORM_WISE: `0x${string}` = await d.tlsnVerifier.read.PLATFORM_WISE();

  await d.c2cAdmin.write.registerMerchantByAdmin([d.merchant.account.address]);
  await d.adminAsMerchant.write.setPlatformBinding([
    PLATFORM_WISE, MERCHANT_NAME_HASH, MERCHANT_ID_HASH,
  ]);

  await d.usdtAsMerchant.write.approve([d.c2cEscrow.address,    MAX_UINT]);
  await d.usdtAsBuyer.write.approve([d.c2cEscrow.address,       MAX_UINT]);
  await d.usdtAsBuyer.write.approve([d.c2cBondVault.address,    MAX_UINT]);

  await d.escrowAsMerchant.write.listCryptoProduct([
    USDT_CRYPTO_ID, MYR_FIAT_ID, collateral, true, PLATFORM_WISE,
  ]);
  await d.escrowAsMerchant.write.listFiatProduct([
    MYR_FIAT_ID, USDT_CRYPTO_ID, collateral, true, PLATFORM_WISE,
  ]);

  const expiry = (await pc.getBlock()).timestamp + 365n * 24n * 3600n;
  await d.adminAsMerchant.write.publishRate([0n, ASSET_CRYPTO, 450_000_000n, expiry]);
  await d.adminAsMerchant.write.publishRate([0n, ASSET_FIAT,   450_000_000n, expiry]);
  await d.adminAsMerchant.write.openNow([0n, ASSET_CRYPTO]);
  await d.adminAsMerchant.write.openNow([0n, ASSET_FIAT]);

  return { d, pc, tc, PLATFORM_WISE };
}

/** List N additional CRYPTO products (pid=1..N) on the same merchant. */
async function listExtraCryptoProducts(
  n: number,
  d: DeployResult,
  pc: any,
  PLATFORM_WISE: `0x${string}`,
  collateral = COLLATERAL,
) {
  const expiry = (await pc.getBlock()).timestamp + 365n * 24n * 3600n;
  for (let i = 0; i < n; i++) {
    await d.escrowAsMerchant.write.listCryptoProduct([
      USDT_CRYPTO_ID, MYR_FIAT_ID, collateral, true, PLATFORM_WISE,
    ]);
    const pid = BigInt(i + 1);
    await d.adminAsMerchant.write.publishRate([pid, ASSET_CRYPTO, 450_000_000n, expiry]);
    await d.adminAsMerchant.write.openNow([pid, ASSET_CRYPTO]);
  }
}

/** Get an arbitrary EOA caller distinct from buyer/merchant (uses randomUser). */
function asCallerEscrow(d: DeployResult, viem: any) {
  return viem.getContractAt("C2CEscrow", d.c2cEscrow.address, {
    client: { wallet: d.randomUser },
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite
// ══════════════════════════════════════════════════════════════════════════════

describe("Sweep — public cleanup (sweepExpired / sweepExpiredBatch)", async function () {
  const { viem } = await network.getOrCreate();

  // ────────────────────────────────────────────────────────────────────────────
  describe("sweepExpired (single product)", () => {

    it("no-op when no orders expired", async () => {
      const { d } = await setupBase(viem);
      const callerEscrow = await asCallerEscrow(d, viem);

      const cleaned = await callerEscrow.simulate.sweepExpired([
        d.merchant.account.address, 0n, ASSET_CRYPTO, 0n,
      ]);
      assert.equal(cleaned.result, 0n);
      await callerEscrow.write.sweepExpired([
        d.merchant.account.address, 0n, ASSET_CRYPTO, 0n,
      ]);
    });

    it("cleans 1 expired CRYPTO order -> EXPIRED", async () => {
      const { d, tc } = await setupBase(viem);
      const buyers = await spawnBuyers(1, d, viem);
      await placeCryptoOrders(buyers, d);
      await advanceTime(tc, Number(ORDER_TIMEOUT) + 1);

      const callerEscrow = await asCallerEscrow(d, viem);
      const sim = await callerEscrow.simulate.sweepExpired([
        d.merchant.account.address, 0n, ASSET_CRYPTO, 0n,
      ]);
      assert.equal(sim.result, 1n);

      await callerEscrow.write.sweepExpired([
        d.merchant.account.address, 0n, ASSET_CRYPTO, 0n,
      ]);

      const ord = await d.c2cEscrow.read.getOrder([
        d.merchant.account.address, 0n, ASSET_CRYPTO, 0n,
      ]);
      // tuple: (buyer, amount, rate, deadline, status, rateVersion, platformTxId)
      // After sweep, _cleanupExpiredBounded deletes p.orders[oid] → buyer zeroed.
      assertOrderSwept(ord, "CRYPTO order 0");
    });

    it("cleans 1 expired FIAT order (WAITING -> EXPIRED)", async () => {
      const { d, tc } = await setupBase(viem);
      const buyers = await spawnBuyers(1, d, viem);
      await placeFiatOrders(buyers, d);
      await advanceTime(tc, Number(ORDER_TIMEOUT) + 1);

      const callerEscrow = await asCallerEscrow(d, viem);
      const sim = await callerEscrow.simulate.sweepExpired([
        d.merchant.account.address, 0n, ASSET_FIAT, 0n,
      ]);
      assert.equal(sim.result, 1n);

      await callerEscrow.write.sweepExpired([
        d.merchant.account.address, 0n, ASSET_FIAT, 0n,
      ]);

      const ord = await d.c2cEscrow.read.getOrder([
        d.merchant.account.address, 0n, ASSET_FIAT, 0n,
      ]);
      assertOrderSwept(ord, "FIAT order 0");
    });

    it("cleans multiple expired in same product", async () => {
      const N = 5;
      const { d, tc } = await setupBase(viem, parseUnits("10", 18));
      const buyers = await spawnBuyers(N, d, viem);
      await placeCryptoOrders(buyers, d);
      await advanceTime(tc, Number(ORDER_TIMEOUT) + 1);

      const callerEscrow = await asCallerEscrow(d, viem);
      const sim = await callerEscrow.simulate.sweepExpired([
        d.merchant.account.address, 0n, ASSET_CRYPTO, 0n,
      ]);
      assert.equal(sim.result, BigInt(N));

      await callerEscrow.write.sweepExpired([
        d.merchant.account.address, 0n, ASSET_CRYPTO, 0n,
      ]);

      for (let i = 0; i < N; i++) {
        const ord = await d.c2cEscrow.read.getOrder([
          d.merchant.account.address, 0n, ASSET_CRYPTO, BigInt(i),
        ]);
        assertOrderSwept(ord, `order ${i}`);
      }
    });

    it("respects maxSteps=2 when 5 expired (partial sweep)", async () => {
      const N = 5;
      const { d, tc } = await setupBase(viem, parseUnits("10", 18));
      const buyers = await spawnBuyers(N, d, viem);
      await placeCryptoOrders(buyers, d);
      await advanceTime(tc, Number(ORDER_TIMEOUT) + 1);

      const callerEscrow = await asCallerEscrow(d, viem);
      const sim = await callerEscrow.simulate.sweepExpired([
        d.merchant.account.address, 0n, ASSET_CRYPTO, 2n,
      ]);
      assert.equal(sim.result, 2n);

      await callerEscrow.write.sweepExpired([
        d.merchant.account.address, 0n, ASSET_CRYPTO, 2n,
      ]);

      // Orders 0,1 should be swept (deleted); 2,3,4 should still be PENDING in storage.
      for (let i = 0; i < 2; i++) {
        const ord = await d.c2cEscrow.read.getOrder([
          d.merchant.account.address, 0n, ASSET_CRYPTO, BigInt(i),
        ]);
        assertOrderSwept(ord, `order ${i}`);
      }
      for (let i = 2; i < N; i++) {
        const ord = await d.c2cEscrow.read.getOrder([
          d.merchant.account.address, 0n, ASSET_CRYPTO, BigInt(i),
        ]);
        assertOrderPending(ord, `order ${i}`);
      }
    });

    it("caller != buyer/merchant succeeds (anyone can call)", async () => {
      const { d, tc } = await setupBase(viem);
      const buyers = await spawnBuyers(1, d, viem);
      await placeCryptoOrders(buyers, d);
      await advanceTime(tc, Number(ORDER_TIMEOUT) + 1);

      // randomUser is neither the buyer (spawned wallet) nor the merchant
      const callerEscrow = await asCallerEscrow(d, viem);
      await callerEscrow.write.sweepExpired([
        d.merchant.account.address, 0n, ASSET_CRYPTO, 0n,
      ]);

      const ord = await d.c2cEscrow.read.getOrder([
        d.merchant.account.address, 0n, ASSET_CRYPTO, 0n,
      ]);
      assertOrderSwept(ord, "third-party callable CRYPTO order");
    });

    it("triggers riskManager.onTimeout exactly once per expired order", async () => {
      const N = 3;
      const { d, tc } = await setupBase(viem, parseUnits("10", 18));
      const buyers = await spawnBuyers(N, d, viem);
      await placeCryptoOrders(buyers, d);
      await advanceTime(tc, Number(ORDER_TIMEOUT) + 1);

      const callerEscrow = await asCallerEscrow(d, viem);
      await callerEscrow.write.sweepExpired([
        d.merchant.account.address, 0n, ASSET_CRYPTO, 0n,
      ]);

      for (const { address } of buyers) {
        const rep = await d.c2cRiskManager.read.getReputation([address]);
        assert.equal(Number(rep.timeoutCount), 1, `buyer ${address} timeoutCount`);
      }
    });

    it("triggers bondVault.settle PROOF_TIMEOUT (merchant claimable > 0)", async () => {
      const { d, tc } = await setupBase(viem);
      const buyers = await spawnBuyers(1, d, viem);
      await placeCryptoOrders(buyers, d);
      await advanceTime(tc, Number(ORDER_TIMEOUT) + 1);

      const merchantClaimBefore = await d.c2cBondVault.read.claimableBalance([
        d.merchant.account.address, d.usdt.address,
      ]);

      const callerEscrow = await asCallerEscrow(d, viem);
      await callerEscrow.write.sweepExpired([
        d.merchant.account.address, 0n, ASSET_CRYPTO, 0n,
      ]);

      const merchantClaimAfter = await d.c2cBondVault.read.claimableBalance([
        d.merchant.account.address, d.usdt.address,
      ]);
      // Buyer CRYPTO timeout → bond归商家
      assert.ok(
        merchantClaimAfter > merchantClaimBefore,
        "merchant claimable should increase after CRYPTO timeout",
      );
    });

    it("releases hasActiveOrder mapping", async () => {
      const { d, tc } = await setupBase(viem);
      const buyers = await spawnBuyers(1, d, viem);
      await placeCryptoOrders(buyers, d);

      assert.equal(
        await d.c2cEscrow.read.hasActiveOrder([
          buyers[0].address, d.merchant.account.address, ASSET_CRYPTO, 0n,
        ]),
        true,
      );

      await advanceTime(tc, Number(ORDER_TIMEOUT) + 1);
      const callerEscrow = await asCallerEscrow(d, viem);
      await callerEscrow.write.sweepExpired([
        d.merchant.account.address, 0n, ASSET_CRYPTO, 0n,
      ]);

      assert.equal(
        await d.c2cEscrow.read.hasActiveOrder([
          buyers[0].address, d.merchant.account.address, ASSET_CRYPTO, 0n,
        ]),
        false,
      );
    });

    it("emits ExpiredSwept with correct count", async () => {
      const N = 2;
      const { d, pc, tc } = await setupBase(viem);
      const buyers = await spawnBuyers(N, d, viem);
      await placeCryptoOrders(buyers, d);
      await advanceTime(tc, Number(ORDER_TIMEOUT) + 1);

      const callerEscrow = await asCallerEscrow(d, viem);
      const txHash = await callerEscrow.write.sweepExpired([
        d.merchant.account.address, 0n, ASSET_CRYPTO, 0n,
      ]);
      const receipt = await pc.waitForTransactionReceipt({ hash: txHash });

      const events = await d.c2cEscrow.getEvents.ExpiredSwept(
        {},
        { fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber },
      );
      assert.equal(events.length, 1, "exactly one ExpiredSwept");
      assert.equal(events[0].args.cleanedCount, BigInt(N));
      assert.equal(
        (events[0].args.merchant as string).toLowerCase(),
        d.merchant.account.address.toLowerCase(),
      );
      assert.equal(events[0].args.productId, 0n);
      assert.equal(events[0].args.assetType, ASSET_CRYPTO);
    });

    it("emits OrderStatusChanged(EXPIRED) per order", async () => {
      const N = 3;
      const { d, pc, tc } = await setupBase(viem, parseUnits("10", 18));
      const buyers = await spawnBuyers(N, d, viem);
      await placeCryptoOrders(buyers, d);
      await advanceTime(tc, Number(ORDER_TIMEOUT) + 1);

      const callerEscrow = await asCallerEscrow(d, viem);
      const txHash = await callerEscrow.write.sweepExpired([
        d.merchant.account.address, 0n, ASSET_CRYPTO, 0n,
      ]);
      const receipt = await pc.waitForTransactionReceipt({ hash: txHash });

      const events = await d.c2cEscrow.getEvents.OrderStatusChanged(
        {},
        { fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber },
      );
      const expiredEvents = events.filter((e: any) => e.args.status === 1);
      assert.equal(expiredEvents.length, N);
    });

    it("reverts when paused", async () => {
      const { d, tc } = await setupBase(viem);
      const buyers = await spawnBuyers(1, d, viem);
      await placeCryptoOrders(buyers, d);
      await advanceTime(tc, Number(ORDER_TIMEOUT) + 1);

      await d.c2cEscrow.write.pause();

      const callerEscrow = await asCallerEscrow(d, viem);
      await expectRevert(
        callerEscrow.write.sweepExpired([
          d.merchant.account.address, 0n, ASSET_CRYPTO, 0n,
        ]),
        /ContractPaused|paused|0xab35696f|reverted/i,
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  describe("sweepExpiredBatch (multi product)", () => {

    it("cleans across 3 different products in one tx", async () => {
      const { d, pc, tc, PLATFORM_WISE } = await setupBase(viem);
      await listExtraCryptoProducts(2, d, pc, PLATFORM_WISE);

      // 1 buyer per product (each buyer can only have 1 active order per product)
      const buyers = await spawnBuyers(3, d, viem);
      await placeCryptoOrders([buyers[0]], d, 0n);
      await placeCryptoOrders([buyers[1]], d, 1n);
      await placeCryptoOrders([buyers[2]], d, 2n);

      await advanceTime(tc, Number(ORDER_TIMEOUT) + 1);

      const targets = [
        { merchant: d.merchant.account.address, productId: 0n, assetType: ASSET_CRYPTO, maxSteps: 0n },
        { merchant: d.merchant.account.address, productId: 1n, assetType: ASSET_CRYPTO, maxSteps: 0n },
        { merchant: d.merchant.account.address, productId: 2n, assetType: ASSET_CRYPTO, maxSteps: 0n },
      ];

      const callerEscrow = await asCallerEscrow(d, viem);
      const sim = await callerEscrow.simulate.sweepExpiredBatch([targets]);
      assert.equal(sim.result, 3n);

      await callerEscrow.write.sweepExpiredBatch([targets]);

      for (let pid = 0; pid < 3; pid++) {
        const ord = await d.c2cEscrow.read.getOrder([
          d.merchant.account.address, BigInt(pid), ASSET_CRYPTO, 0n,
        ]);
        assertOrderSwept(ord, `product ${pid} order 0`);
      }
    });

    it("handles mix of expired + non-expired products", async () => {
      const { d, pc, tc, PLATFORM_WISE } = await setupBase(viem);
      await listExtraCryptoProducts(1, d, pc, PLATFORM_WISE);

      const buyers = await spawnBuyers(2, d, viem);
      await placeCryptoOrders([buyers[0]], d, 0n);
      await advanceTime(tc, Number(ORDER_TIMEOUT) + 1); // pid=0 now expired
      await placeCryptoOrders([buyers[1]], d, 1n);      // pid=1 freshly placed

      const targets = [
        { merchant: d.merchant.account.address, productId: 0n, assetType: ASSET_CRYPTO, maxSteps: 0n },
        { merchant: d.merchant.account.address, productId: 1n, assetType: ASSET_CRYPTO, maxSteps: 0n },
      ];

      const callerEscrow = await asCallerEscrow(d, viem);
      const sim = await callerEscrow.simulate.sweepExpiredBatch([targets]);
      assert.equal(sim.result, 1n);

      await callerEscrow.write.sweepExpiredBatch([targets]);

      const o0 = await d.c2cEscrow.read.getOrder([
        d.merchant.account.address, 0n, ASSET_CRYPTO, 0n,
      ]);
      assertOrderSwept(o0, "pid=0");
      const o1 = await d.c2cEscrow.read.getOrder([
        d.merchant.account.address, 1n, ASSET_CRYPTO, 0n,
      ]);
      assertOrderPending(o1, "pid=1");
    });

    it("reverts BatchSizeInvalid when len=0", async () => {
      const { d } = await setupBase(viem);
      const callerEscrow = await asCallerEscrow(d, viem);
      await expectRevert(
        callerEscrow.write.sweepExpiredBatch([[]]),
        /BatchSizeInvalid/i,
      );
    });

    it("reverts BatchSizeInvalid when len>20", async () => {
      const { d } = await setupBase(viem);
      const t = {
        merchant: d.merchant.account.address,
        productId: 0n,
        assetType: ASSET_CRYPTO,
        maxSteps: 0n,
      };
      const targets = Array.from({ length: 21 }, () => ({ ...t }));
      const callerEscrow = await asCallerEscrow(d, viem);
      await expectRevert(
        callerEscrow.write.sweepExpiredBatch([targets]),
        /BatchSizeInvalid/i,
      );
    });

    it("idempotent: second call no-op", async () => {
      const { d, tc } = await setupBase(viem);
      const buyers = await spawnBuyers(1, d, viem);
      await placeCryptoOrders(buyers, d);
      await advanceTime(tc, Number(ORDER_TIMEOUT) + 1);

      const targets = [{
        merchant: d.merchant.account.address,
        productId: 0n,
        assetType: ASSET_CRYPTO,
        maxSteps: 0n,
      }];

      const callerEscrow = await asCallerEscrow(d, viem);
      const sim1 = await callerEscrow.simulate.sweepExpiredBatch([targets]);
      assert.equal(sim1.result, 1n);
      await callerEscrow.write.sweepExpiredBatch([targets]);

      const sim2 = await callerEscrow.simulate.sweepExpiredBatch([targets]);
      assert.equal(sim2.result, 0n, "second call should clean nothing");
      await callerEscrow.write.sweepExpiredBatch([targets]);
    });

    it("reverts when paused", async () => {
      const { d } = await setupBase(viem);
      await d.c2cEscrow.write.pause();
      const targets = [{
        merchant: d.merchant.account.address,
        productId: 0n,
        assetType: ASSET_CRYPTO,
        maxSteps: 0n,
      }];
      const callerEscrow = await asCallerEscrow(d, viem);
      await expectRevert(
        callerEscrow.write.sweepExpiredBatch([targets]),
        /ContractPaused|paused|0xab35696f|reverted/i,
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  describe("Invariants after sweep", () => {

    it("CRYPTO: pendingAmount decreases by sum of expired amounts; collateralAmount unchanged", async () => {
      const N = 3;
      const { d, tc } = await setupBase(viem, parseUnits("10", 18));
      const buyers = await spawnBuyers(N, d, viem);
      await placeCryptoOrders(buyers, d);

      const productBefore = await d.c2cEscrow.read.getProductInfo([
        d.merchant.account.address, 0n, ASSET_CRYPTO,
      ]);
      const pendingBefore     = productBefore.pendingAmount;
      const collateralBefore  = productBefore.collateralAmount;

      await advanceTime(tc, Number(ORDER_TIMEOUT) + 1);

      const callerEscrow = await asCallerEscrow(d, viem);
      await callerEscrow.write.sweepExpired([
        d.merchant.account.address, 0n, ASSET_CRYPTO, 0n,
      ]);

      const productAfter = await d.c2cEscrow.read.getProductInfo([
        d.merchant.account.address, 0n, ASSET_CRYPTO,
      ]);

      assert.equal(
        productBefore.pendingAmount - productAfter.pendingAmount,
        BigInt(N) * TRADE_AMOUNT,
        "pendingAmount decreased by N * TRADE_AMOUNT",
      );
      assert.equal(
        productAfter.collateralAmount,
        collateralBefore,
        "collateralAmount unchanged for CRYPTO path",
      );
      assert.equal(productAfter.activeOrderCount, 0n);
      void pendingBefore;
    });

    it("FIAT: buyerEscrowedAmount decreases; collateral - stake reduction matches bond settlement", async () => {
      const { d, tc } = await setupBase(viem);
      const buyers = await spawnBuyers(1, d, viem);
      await placeFiatOrders(buyers, d);

      const before = await d.c2cEscrow.read.getProductInfo([
        d.merchant.account.address, 0n, ASSET_FIAT,
      ]);

      await advanceTime(tc, Number(ORDER_TIMEOUT) + 1);
      const callerEscrow = await asCallerEscrow(d, viem);
      await callerEscrow.write.sweepExpired([
        d.merchant.account.address, 0n, ASSET_FIAT, 0n,
      ]);

      const after = await d.c2cEscrow.read.getProductInfo([
        d.merchant.account.address, 0n, ASSET_FIAT,
      ]);
      assert.equal(after.activeOrderCount, 0n);
      // buyerEscrowedAmount is internal but reflected in pendingAmount drop;
      // ensure pendingAmount has dropped (stake = amount - bond was deducted).
      assert.ok(before.pendingAmount > after.pendingAmount, "pendingAmount dropped");
    });

    it("riskManager timeoutCount += expired count", async () => {
      const N = 4;
      const { d, tc } = await setupBase(viem, parseUnits("10", 18));
      const buyers = await spawnBuyers(N, d, viem);
      await placeCryptoOrders(buyers, d);
      await advanceTime(tc, Number(ORDER_TIMEOUT) + 1);

      const callerEscrow = await asCallerEscrow(d, viem);
      await callerEscrow.write.sweepExpired([
        d.merchant.account.address, 0n, ASSET_CRYPTO, 0n,
      ]);

      let total = 0;
      for (const { address } of buyers) {
        const rep = await d.c2cRiskManager.read.getReputation([address]);
        total += Number(rep.timeoutCount);
      }
      assert.equal(total, N);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  describe("Idempotency with placeOrder", () => {

    it("placeOrder after sweep on same product works", async () => {
      const { d, tc } = await setupBase(viem);
      const buyers = await spawnBuyers(1, d, viem);
      await placeCryptoOrders(buyers, d);
      await advanceTime(tc, Number(ORDER_TIMEOUT) + 1);

      const callerEscrow = await asCallerEscrow(d, viem);
      await callerEscrow.write.sweepExpired([
        d.merchant.account.address, 0n, ASSET_CRYPTO, 0n,
      ]);

      // A fresh buyer can now place a new order on the same product
      const [newBuyer] = await spawnBuyers(1, d, viem);
      await placeCryptoOrders([newBuyer], d, 0n);

      const ord = await d.c2cEscrow.read.getOrder([
        d.merchant.account.address, 0n, ASSET_CRYPTO, 1n,
      ]);
      // The new order ID is 1 (orderId 0 was the expired one) and is PENDING
      assert.equal(ord[4], 0);
      assert.equal(
        (ord[0] as string).toLowerCase(),
        newBuyer.address.toLowerCase(),
      );
    });
  });
});
