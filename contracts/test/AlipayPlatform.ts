/**
 * AlipayPlatform.ts
 *
 * Test suite for Alipay platform verifier flow through C2CEscrow entrypoints.
 * Covers: ALI-FLOW-01~05, ALI-ERR-01~14, ALI-ATT-01~08, ALI-TAMPER-01~10
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { network } from "hardhat";
import { decodeEventLog, keccak256, toBytes, type Address, type Hex } from "viem";

import { deployAll, type DeployResult } from "./helpers/deploy.js";
import {
  addRecord,
  clearRecords,
  makeCtx,
  printTable,
} from "./helpers/tableReporter.js";
import {
  buildAlipayProof,
  buildAlipayProofMissingField,
  toAlipayGmtSuccess,
  type TLSNProof,
} from "./helpers/proofBuilder.js";
import { computeOrderBindingHash } from "./helpers/orderBindingHash.js";
import {
  ALIPAY_BUYER_HANDLE,
  ALIPAY_BUYER_NAME,
  ALIPAY_MERCHANT_HANDLE,
  ALIPAY_MERCHANT_NAME,
  ALIPAY_SERVER,
  CNY_FIAT_ID,
  CNY_NAME,
  COLLATERAL,
  ORDER_TIMEOUT,
  RATE_ALIPAY_CRYPTO,
  RATE_ALIPAY_FIAT,
  TRADE_AMOUNT,
  USDT_CRYPTO_ID,
  ZERO_HASH,
} from "./helpers/constants.js";

const CHAIN_ID = 31337n;
const ASSET_CRYPTO = 0;
const ASSET_FIAT = 1;

const ALIPAY_CRYPTO_PID = 0n;
const ALIPAY_FIAT_PID = 0n;

const MAX_UINT = (2n ** 256n) - 1n;

const MERCHANT_NAME_HASH = keccak256(toBytes(ALIPAY_MERCHANT_NAME));
const MERCHANT_ID_HASH = keccak256(toBytes(ALIPAY_MERCHANT_HANDLE));
const BUYER_NAME_HASH = keccak256(toBytes(ALIPAY_BUYER_NAME));
const BUYER_ID_HASH = keccak256(toBytes(ALIPAY_BUYER_HANDLE));

const ALT_MERCHANT_NAME_HASH = keccak256(toBytes("ALT-ALIPAY-MERCHANT"));
const ALT_MERCHANT_ID_HASH = keccak256(toBytes("alt-merchant@alipay.test"));
const ATTACKER_NAME_HASH = keccak256(toBytes("ATTACKER-NAME"));
const ATTACKER_ID_HASH = keccak256(toBytes("attacker@evil.test"));

const NULL_BUYER_INFO = {
  nameHash: ZERO_HASH,
  idHash: ZERO_HASH,
  isSet: false,
} as const;

const BUYER_INFO = {
  nameHash: BUYER_NAME_HASH,
  idHash: BUYER_ID_HASH,
  isSet: true,
} as const;

let _alipayOrderCounter = 0;
function nextAlipayOrderId(prefix: string): string {
  _alipayOrderCounter += 1;
  return `${prefix}-${Date.now()}-${_alipayOrderCounter}`;
}

function calcFiatX1000(amount: bigint, rate: bigint, _assetType?: number): bigint {
  // Unified formula: rate = fiatPrice × 10^8; tokenDecimals = 18 (USDT)
  return (amount * 1000n * rate) / (10n ** 26n);
}

function toAmountX1000String(v: bigint): string {
  const intPart = v / 1000n;
  const fracPart = (v % 1000n).toString().padStart(3, "0");
  return `${intPart}.${fracPart}`;
}

async function expectRevert(
  promise: Promise<unknown>,
  expected?: string | RegExp,
) {
  try {
    await promise;
    assert.fail("Expected transaction to revert");
  } catch (err: any) {
    if (expected === undefined) return;
    const re = typeof expected === "string" ? new RegExp(expected) : expected;
    const text = [
      err?.message,
      err?.shortMessage,
      err?.details,
      String(err),
    ].filter(Boolean).join("\n");
    assert.match(text, re);
  }
}

async function escrowAs(viem: any, d: DeployResult, wallet: any) {
  return viem.getContractAt("C2CEscrow", d.c2cEscrow.address, {
    client: { wallet },
  });
}

async function adminAs(viem: any, d: DeployResult, wallet: any) {
  return viem.getContractAt("C2CAdmin", d.c2cAdmin.address, {
    client: { wallet },
  });
}

async function usdtAs(viem: any, d: DeployResult, wallet: any) {
  return viem.getContractAt("MockERC20", d.usdt.address, {
    client: { wallet },
  });
}

async function alipayVerifierAs(viem: any, d: DeployResult, wallet: any) {
  return viem.getContractAt("AlipayPlatformVerifier", d.alipayPlatformVerifier.address, {
    client: { wallet },
  });
}

async function fundAndApproveWallet(
  viem: any,
  d: DeployResult,
  wallet: any,
  amount = 50n * 10n ** 18n,
) {
  await d.usdt.write.mint([wallet.account.address, amount]);
  const token = await usdtAs(viem, d, wallet);
  await token.write.approve([d.c2cEscrow.address, MAX_UINT]);
}

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

  await d.usdtAsMerchant.write.approve([d.c2cEscrow.address, MAX_UINT]);
  await d.usdtAsBuyer.write.approve([d.c2cEscrow.address, MAX_UINT]);

  await d.escrowAsMerchant.write.listCryptoProduct([
    USDT_CRYPTO_ID, CNY_FIAT_ID, COLLATERAL, true, PLATFORM_ALIPAY,
  ]);
  await d.escrowAsMerchant.write.listFiatProduct([
    CNY_FIAT_ID, USDT_CRYPTO_ID, COLLATERAL, true, PLATFORM_ALIPAY,
  ]);

  const expiry = (await pc.getBlock()).timestamp + 365n * 24n * 3600n;
  await d.adminAsMerchant.write.publishRate([ALIPAY_CRYPTO_PID, ASSET_CRYPTO, RATE_ALIPAY_CRYPTO, expiry]);
  await d.adminAsMerchant.write.publishRate([ALIPAY_FIAT_PID, ASSET_FIAT, RATE_ALIPAY_FIAT, expiry]);

  await d.adminAsMerchant.write.openNow([ALIPAY_CRYPTO_PID, ASSET_CRYPTO]);
  await d.adminAsMerchant.write.openNow([ALIPAY_FIAT_PID, ASSET_FIAT]);

  return { d, pc, PLATFORM_ALIPAY };
}

async function placeCryptoOrder(
  viem: any,
  d: DeployResult,
  p: {
    buyerWallet?: any;
    merchant?: Address;
    productId?: bigint;
    amount?: bigint;
  } = {},
) {
  const buyerWallet = p.buyerWallet ?? d.buyer;
  const merchant = p.merchant ?? d.merchant.account.address;
  const productId = p.productId ?? ALIPAY_CRYPTO_PID;
  const amount = p.amount ?? TRADE_AMOUNT;

  const esc =
    buyerWallet.account.address.toLowerCase() === d.buyer.account.address.toLowerCase()
      ? d.escrowAsBuyer
      : await escrowAs(viem, d, buyerWallet);

  return esc.write.placeOrder([merchant, productId, ASSET_CRYPTO, amount, NULL_BUYER_INFO]);
}

async function placeFiatOrder(
  viem: any,
  d: DeployResult,
  p: {
    buyerWallet?: any;
    merchant?: Address;
    productId?: bigint;
    amount?: bigint;
    buyerInfo?: { nameHash: Hex; idHash: Hex; isSet: boolean };
  } = {},
) {
  const buyerWallet = p.buyerWallet ?? d.buyer;
  const merchant = p.merchant ?? d.merchant.account.address;
  const productId = p.productId ?? ALIPAY_FIAT_PID;
  const amount = p.amount ?? TRADE_AMOUNT;
  const buyerInfo = p.buyerInfo ?? BUYER_INFO;

  const esc =
    buyerWallet.account.address.toLowerCase() === d.buyer.account.address.toLowerCase()
      ? d.escrowAsBuyer
      : await escrowAs(viem, d, buyerWallet);

  return esc.write.placeOrder([merchant, productId, ASSET_FIAT, amount, buyerInfo]);
}

async function getOrderSnapshot(
  d: DeployResult,
  merchant: Address,
  productId: bigint,
  assetType: number,
  orderId: bigint,
) {
  const [buyer, amount, rate, deadline, status, rateVersion] = await d.c2cEscrow.read.getOrder([
    merchant, productId, assetType, orderId,
  ]);
  return {
    buyer,
    amount,
    rate,
    deadline,
    status: Number(status),
    rateVersion: BigInt(rateVersion),
  };
}

async function buildAlipayProofForCrypto(
  d: DeployResult,
  p: {
    merchant?: Address;
    productId?: bigint;
    orderId?: bigint;
    chainId?: bigint;
    serverName?: string;
    orderBindingHash?: Hex;
    orderIdField?: string;
    payAmount?: string;
    status?: string;
    bizType?: string;
    gmtSuccess?: string;
    merchantNameHash?: Hex;
    merchantIdHash?: Hex;
    payeeNameHash?: Hex;
    payeeIdHash?: Hex;
    buyer?: Address;
    verifierWallet?: any;
    overrideCommitmentsHash?: Hex;
    overrideSignature?: Hex;
  } = {},
) {
  const merchant = p.merchant ?? d.merchant.account.address;
  const productId = p.productId ?? ALIPAY_CRYPTO_PID;
  const orderId = p.orderId ?? 0n;
  const order = await getOrderSnapshot(d, merchant, productId, ASSET_CRYPTO, orderId);

  const merchantNameHash = p.merchantNameHash ?? MERCHANT_NAME_HASH;
  const merchantIdHash = p.merchantIdHash ?? MERCHANT_ID_HASH;
  const payeeNameHash = p.payeeNameHash ?? merchantNameHash;
  const payeeIdHash = p.payeeIdHash ?? merchantIdHash;

  const obh = p.orderBindingHash ?? computeOrderBindingHash({
    escrow: d.c2cEscrow.address,
    chainId: p.chainId ?? CHAIN_ID,
    merchant,
    buyer: p.buyer ?? order.buyer,
    productId,
    orderId,
    assetType: ASSET_CRYPTO,
    amount: order.amount,
    rate: order.rate,
    rateVersion: order.rateVersion,
    deadline: order.deadline,
    merchantNameHash,
    merchantIdHash,
    payeeNameHash,
    payeeIdHash,
  });

  const fiatX1000 = calcFiatX1000(order.amount, order.rate, ASSET_CRYPTO);
  const payAmount = p.payAmount ?? toAmountX1000String(fiatX1000);
  const orderIdField = p.orderIdField ?? nextAlipayOrderId("ALI-C");

  const proof = await buildAlipayProof({
    fields: {
      payAmount,
      status: p.status ?? "SUCCESS",
      bizType: p.bizType ?? "TRANSFER",
      orderId: orderIdField,
      gmtSuccess: p.gmtSuccess ?? toAlipayGmtSuccess(order.deadline - 60n),
    },
    verifierWallet: p.verifierWallet ?? d.verifierSigner,
    orderBindingHash: obh,
    chainId: p.chainId ?? CHAIN_ID,
    serverName: p.serverName ?? ALIPAY_SERVER,
    overrideCommitmentsHash: p.overrideCommitmentsHash,
    overrideSignature: p.overrideSignature,
  });

  return { proofs: [proof] as TLSNProof[], order, orderBindingHash: obh, orderIdField };
}

async function buildAlipayProofForFiat(
  d: DeployResult,
  p: {
    merchant?: Address;
    productId?: bigint;
    orderId?: bigint;
    chainId?: bigint;
    serverName?: string;
    orderBindingHash?: Hex;
    orderIdField?: string;
    payAmount?: string;
    status?: string;
    bizType?: string;
    gmtSuccess?: string;
    merchantNameHash?: Hex;
    merchantIdHash?: Hex;
    payeeNameHash?: Hex;
    payeeIdHash?: Hex;
    verifierWallet?: any;
    overrideCommitmentsHash?: Hex;
    overrideSignature?: Hex;
  } = {},
) {
  const merchant = p.merchant ?? d.merchant.account.address;
  const productId = p.productId ?? ALIPAY_FIAT_PID;
  const orderId = p.orderId ?? 0n;
  const order = await getOrderSnapshot(d, merchant, productId, ASSET_FIAT, orderId);
  const buyerInfo = await d.c2cEscrow.read.getBuyerPaymentInfo([merchant, productId, orderId]);

  const merchantNameHash = p.merchantNameHash ?? MERCHANT_NAME_HASH;
  const merchantIdHash = p.merchantIdHash ?? MERCHANT_ID_HASH;
  const payeeNameHash = p.payeeNameHash ?? buyerInfo.nameHash;
  const payeeIdHash = p.payeeIdHash ?? buyerInfo.idHash;

  const obh = p.orderBindingHash ?? computeOrderBindingHash({
    escrow: d.c2cEscrow.address,
    chainId: p.chainId ?? CHAIN_ID,
    merchant,
    buyer: order.buyer,
    productId,
    orderId,
    assetType: ASSET_FIAT,
    amount: order.amount,
    rate: order.rate,
    rateVersion: order.rateVersion,
    deadline: order.deadline,
    merchantNameHash,
    merchantIdHash,
    payeeNameHash,
    payeeIdHash,
  });

  const fiatX1000 = calcFiatX1000(order.amount, order.rate, ASSET_FIAT);
  const payAmount = p.payAmount ?? toAmountX1000String(fiatX1000);
  const orderIdField = p.orderIdField ?? nextAlipayOrderId("ALI-F");

  const proof = await buildAlipayProof({
    fields: {
      payAmount,
      status: p.status ?? "SUCCESS",
      bizType: p.bizType ?? "TRANSFER",
      orderId: orderIdField,
      gmtSuccess: p.gmtSuccess ?? toAlipayGmtSuccess(order.deadline - 60n),
    },
    verifierWallet: p.verifierWallet ?? d.verifierSigner,
    orderBindingHash: obh,
    chainId: p.chainId ?? CHAIN_ID,
    serverName: p.serverName ?? ALIPAY_SERVER,
    overrideCommitmentsHash: p.overrideCommitmentsHash,
    overrideSignature: p.overrideSignature,
  });

  return { proofs: [proof] as TLSNProof[], order, orderBindingHash: obh, orderIdField };
}

async function assertPlatformPaymentEvent(
  d: DeployResult,
  receipt: any,
  platformId: Hex,
  isMerchantSent: boolean,
  orderId: string,
) {
  const expectedTxId = keccak256(toBytes(orderId)).toLowerCase();
  let found = false;

  for (const log of receipt.logs ?? []) {
    if ((log.address as string).toLowerCase() !== d.tlsnVerifier.address.toLowerCase()) continue;

    try {
      const decoded = decodeEventLog({
        abi: (d.tlsnVerifier as any).abi,
        data: log.data,
        topics: log.topics,
        eventName: "PlatformPaymentVerified",
      }) as any;

      const args = decoded.args as any;
      const pid = String(Array.isArray(args) ? args[0] : args.platformId).toLowerCase();
      const sent = Boolean(Array.isArray(args) ? args[1] : args.isMerchantSent);
      const txId = String(Array.isArray(args) ? args[2] : args.txId).toLowerCase();

      if (pid === platformId.toLowerCase() && sent === isMerchantSent && txId === expectedTxId) {
        found = true;
        break;
      }
    } catch {
      // ignore unrelated logs
    }
  }

  assert.equal(found, true, "PlatformPaymentVerified(txId) not found/mismatched");
}

describe("AlipayPlatformVerifier", async function () {
  const { viem } = await network.getOrCreate();
  const testClient = await viem.getTestClient();

  let d: DeployResult;
  let pc: any;
  let PLATFORM_ALIPAY: Hex;
  let snap: Hex;

  async function sendTx(ctx: ReturnType<typeof makeCtx>, txPromise: Promise<Hex>) {
    ctx.markVerifyStart();
    const hash = await txPromise;
    const receipt = await pc.getTransactionReceipt({ hash });
    ctx.markVerifyEnd();
    ctx.setGas(receipt.gasUsed);
    return receipt;
  }

  async function expectRevertTracked(
    ctx: ReturnType<typeof makeCtx>,
    txPromise: Promise<unknown>,
    expected?: string | RegExp,
  ) {
    ctx.markVerifyStart();
    await expectRevert(txPromise, expected);
    ctx.markVerifyEnd();
  }

  async function runCase(
    id: string,
    desc: string,
    fn: (ctx: ReturnType<typeof makeCtx>) => Promise<void>,
  ) {
    const t0 = Date.now();
    const ctx = makeCtx();
    let pass = false;
    try {
      await fn(ctx);
      pass = true;
    } finally {
      addRecord({
        id,
        desc,
        pass,
        totalMs: Date.now() - t0,
        verifyMs: ctx.verifyMs(),
        gasUsed: ctx.gasUsed,
      });
    }
  }

  function T(
    id: string,
    desc: string,
    fn: (ctx: ReturnType<typeof makeCtx>) => Promise<void>,
  ) {
    it(`${id}: ${desc}`, async () => {
      await runCase(id, desc, fn);
    });
  }

  before(async () => {
    clearRecords();
    const base = await setupBase(viem);
    d = base.d;
    pc = base.pc;
    PLATFORM_ALIPAY = base.PLATFORM_ALIPAY;
    snap = await testClient.snapshot();
  });

  beforeEach(async () => {
    await testClient.revert({ id: snap });
    snap = await testClient.snapshot();
  });

  after(() => {
    printTable("AlipayPlatform 测试报告");
  });

  describe("FLOW", () => {
    T("ALI-FLOW-01", "买家支付验证成功，txId=keccak(orderId)", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const built = await buildAlipayProofForCrypto(d);

      const buyerBefore = await d.usdt.read.balanceOf([d.buyer.account.address]);
      const receipt = await sendTx(ctx, d.escrowAsBuyer.write.payOrderByPlatform([
        d.merchant.account.address, ALIPAY_CRYPTO_PID, 0n, built.proofs,
      ]));
      const buyerAfter = await d.usdt.read.balanceOf([d.buyer.account.address]);

      assert.equal(buyerAfter - buyerBefore, TRADE_AMOUNT);
      await assertPlatformPaymentEvent(d, receipt, PLATFORM_ALIPAY, false, built.orderIdField);
    });

    T("ALI-FLOW-02", "商家收款验证成功，txId=keccak(orderId)", async (ctx) => {
      await placeFiatOrder(viem, d);
      const built = await buildAlipayProofForFiat(d);

      const merchantBefore = await d.usdt.read.balanceOf([d.merchant.account.address]);
      const receipt = await sendTx(ctx, d.escrowAsMerchant.write.receiveCryptoWithPlatformPayment([
        ALIPAY_FIAT_PID, 0n, built.proofs,
      ]));
      const merchantAfter = await d.usdt.read.balanceOf([d.merchant.account.address]);

      assert.equal(merchantAfter - merchantBefore, TRADE_AMOUNT);
      await assertPlatformPaymentEvent(d, receipt, PLATFORM_ALIPAY, true, built.orderIdField);
    });

    T("ALI-FLOW-03", "边界 gmtSuccess == creation 允许通过", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const order = await getOrderSnapshot(d, d.merchant.account.address, ALIPAY_CRYPTO_PID, ASSET_CRYPTO, 0n);
      const creation = order.deadline - ORDER_TIMEOUT;
      const built = await buildAlipayProofForCrypto(d, {
        gmtSuccess: toAlipayGmtSuccess(creation),
      });

      await sendTx(ctx, d.escrowAsBuyer.write.payOrderByPlatform([
        d.merchant.account.address, ALIPAY_CRYPTO_PID, 0n, built.proofs,
      ]));
    });

    T("ALI-FLOW-04", "边界 gmtSuccess == deadline 允许通过", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const order = await getOrderSnapshot(d, d.merchant.account.address, ALIPAY_CRYPTO_PID, ASSET_CRYPTO, 0n);
      const built = await buildAlipayProofForCrypto(d, {
        gmtSuccess: toAlipayGmtSuccess(order.deadline),
      });

      await sendTx(ctx, d.escrowAsBuyer.write.payOrderByPlatform([
        d.merchant.account.address, ALIPAY_CRYPTO_PID, 0n, built.proofs,
      ]));
    });

    T("ALI-FLOW-05", "orderId 成功后落库 usedAlipayOrderIds=true", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const built = await buildAlipayProofForCrypto(d);

      await sendTx(ctx, d.escrowAsBuyer.write.payOrderByPlatform([
        d.merchant.account.address, ALIPAY_CRYPTO_PID, 0n, built.proofs,
      ]));

      const txId = keccak256(toBytes(built.orderIdField));
      const used = await d.alipayPlatformVerifier.read.usedAlipayOrderIds([txId]);
      assert.equal(used, true);
    });
  });

  describe("ERR", () => {
    T("ALI-ERR-01", "非 TLSNVerifier（普通地址）调用 verify* -> only TLSNVerifier", async (ctx) => {
      const alipayRandom = await alipayVerifierAs(viem, d, d.randomUser);
      await expectRevertTracked(
        ctx,
        alipayRandom.write.verifyBuyerPayment(["0x1234", "0x5678"]),
        /only TLSNVerifier/,
      );
    });

    T("ALI-ERR-02", "status 非 SUCCESS -> AlipayPaymentNotCompleted", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const built = await buildAlipayProofForCrypto(d, { status: "FAILED" });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, ALIPAY_CRYPTO_PID, 0n, built.proofs,
        ]),
        "AlipayPaymentNotCompleted",
      );
    });

    T("ALI-ERR-03", "bizType 非 TRANSFER -> InvalidAlipayBizType", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const built = await buildAlipayProofForCrypto(d, { bizType: "REFUND" });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, ALIPAY_CRYPTO_PID, 0n, built.proofs,
        ]),
        "InvalidAlipayBizType",
      );
    });

    T("ALI-ERR-04", "买家流金额不匹配 -> PaymentAmountMismatch", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const built = await buildAlipayProofForCrypto(d, { payAmount: "999.999" });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, ALIPAY_CRYPTO_PID, 0n, built.proofs,
        ]),
        "PaymentAmountMismatch",
      );
    });

    T("ALI-ERR-05", "商家流金额不匹配 -> ReceivedAmountMismatch", async (ctx) => {
      await placeFiatOrder(viem, d);
      const built = await buildAlipayProofForFiat(d, { payAmount: "999.999" });

      await expectRevertTracked(
        ctx,
        d.escrowAsMerchant.write.receiveCryptoWithPlatformPayment([
          ALIPAY_FIAT_PID, 0n, built.proofs,
        ]),
        "ReceivedAmountMismatch",
      );
    });

    T("ALI-ERR-06", "orderId 重放 -> DuplicateAlipayOrderId", async (ctx) => {
      const replayOrderId = "ALI-REPLAY-ERR-06";

      await placeCryptoOrder(viem, d);
      const first = await buildAlipayProofForCrypto(d, { orderIdField: replayOrderId });
      await d.escrowAsBuyer.write.payOrderByPlatform([
        d.merchant.account.address, ALIPAY_CRYPTO_PID, 0n, first.proofs,
      ]);

      await placeCryptoOrder(viem, d);
      const second = await buildAlipayProofForCrypto(d, {
        orderId: 1n,
        orderIdField: replayOrderId,
      });
      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, ALIPAY_CRYPTO_PID, 1n, second.proofs,
        ]),
        "DuplicateAlipayOrderId",
      );
    });

    T("ALI-ERR-07", "付款早于下单 -> AlipayTransferTooOld", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const order = await getOrderSnapshot(d, d.merchant.account.address, ALIPAY_CRYPTO_PID, ASSET_CRYPTO, 0n);
      const creation = order.deadline - ORDER_TIMEOUT;
      const built = await buildAlipayProofForCrypto(d, {
        gmtSuccess: toAlipayGmtSuccess(creation - 1n),
      });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, ALIPAY_CRYPTO_PID, 0n, built.proofs,
        ]),
        "AlipayTransferTooOld",
      );
    });

    T("ALI-ERR-08", "付款晚于截止 -> AlipayTransferDateExpired", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const order = await getOrderSnapshot(d, d.merchant.account.address, ALIPAY_CRYPTO_PID, ASSET_CRYPTO, 0n);
      const built = await buildAlipayProofForCrypto(d, {
        gmtSuccess: toAlipayGmtSuccess(order.deadline + 1n),
      });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, ALIPAY_CRYPTO_PID, 0n, built.proofs,
        ]),
        "AlipayTransferDateExpired",
      );
    });

    T("ALI-ERR-09", "缺 payAmount 字段 -> MissingAlipayField", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const base = await buildAlipayProofForCrypto(d);
      const amount = toAmountX1000String(calcFiatX1000(base.order.amount, base.order.rate, ASSET_CRYPTO));
      const proof = await buildAlipayProofMissingField({
        omit: "payAmount",
        verifierWallet: d.verifierSigner,
        orderBindingHash: base.orderBindingHash,
        chainId: CHAIN_ID,
        serverName: ALIPAY_SERVER,
        paymentTime: base.order.deadline - 60n,
        payAmount: amount,
      });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, ALIPAY_CRYPTO_PID, 0n, [proof],
        ]),
        "MissingAlipayField",
      );
    });

    T("ALI-ERR-10", "缺 status 字段 -> MissingAlipayField", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const base = await buildAlipayProofForCrypto(d);
      const amount = toAmountX1000String(calcFiatX1000(base.order.amount, base.order.rate, ASSET_CRYPTO));
      const proof = await buildAlipayProofMissingField({
        omit: "status",
        verifierWallet: d.verifierSigner,
        orderBindingHash: base.orderBindingHash,
        chainId: CHAIN_ID,
        serverName: ALIPAY_SERVER,
        paymentTime: base.order.deadline - 60n,
        payAmount: amount,
      });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, ALIPAY_CRYPTO_PID, 0n, [proof],
        ]),
        "MissingAlipayField",
      );
    });

    T("ALI-ERR-11", "缺 bizType 字段 -> MissingAlipayField", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const base = await buildAlipayProofForCrypto(d);
      const amount = toAmountX1000String(calcFiatX1000(base.order.amount, base.order.rate, ASSET_CRYPTO));
      const proof = await buildAlipayProofMissingField({
        omit: "bizType",
        verifierWallet: d.verifierSigner,
        orderBindingHash: base.orderBindingHash,
        chainId: CHAIN_ID,
        serverName: ALIPAY_SERVER,
        paymentTime: base.order.deadline - 60n,
        payAmount: amount,
      });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, ALIPAY_CRYPTO_PID, 0n, [proof],
        ]),
        "MissingAlipayField",
      );
    });

    T("ALI-ERR-12", "缺 orderId 字段 -> MissingAlipayField", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const base = await buildAlipayProofForCrypto(d);
      const amount = toAmountX1000String(calcFiatX1000(base.order.amount, base.order.rate, ASSET_CRYPTO));
      const proof = await buildAlipayProofMissingField({
        omit: "orderId",
        verifierWallet: d.verifierSigner,
        orderBindingHash: base.orderBindingHash,
        chainId: CHAIN_ID,
        serverName: ALIPAY_SERVER,
        paymentTime: base.order.deadline - 60n,
        payAmount: amount,
      });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, ALIPAY_CRYPTO_PID, 0n, [proof],
        ]),
        "MissingAlipayField",
      );
    });

    T("ALI-ERR-13", "缺 gmtSuccess 字段 -> MissingAlipayField", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const base = await buildAlipayProofForCrypto(d);
      const amount = toAmountX1000String(calcFiatX1000(base.order.amount, base.order.rate, ASSET_CRYPTO));
      const proof = await buildAlipayProofMissingField({
        omit: "gmtSuccess",
        verifierWallet: d.verifierSigner,
        orderBindingHash: base.orderBindingHash,
        chainId: CHAIN_ID,
        serverName: ALIPAY_SERVER,
        paymentTime: base.order.deadline - 60n,
        payAmount: amount,
      });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, ALIPAY_CRYPTO_PID, 0n, [proof],
        ]),
        "MissingAlipayField",
      );
    });

    T("ALI-ERR-14", "时间格式异常 -> InvalidDatetimeFormat", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const built = await buildAlipayProofForCrypto(d, {
        gmtSuccess: "2026-01-01 00:00",
      });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, ALIPAY_CRYPTO_PID, 0n, built.proofs,
        ]),
        /InvalidDatetimeFormat/,
      );
    });
  });

  describe("ATTACK", () => {
    T("ALI-ATT-01", "跨订单 orderId replay -> DuplicateAlipayOrderId", async (ctx) => {
      await fundAndApproveWallet(viem, d, d.newAdmin);
      const replayOrderId = "ALI-REPLAY-ATT-01";

      await placeCryptoOrder(viem, d, { buyerWallet: d.buyer });
      const p1 = await buildAlipayProofForCrypto(d, {
        orderId: 0n,
        orderIdField: replayOrderId,
      });
      await d.escrowAsBuyer.write.payOrderByPlatform([
        d.merchant.account.address, ALIPAY_CRYPTO_PID, 0n, p1.proofs,
      ]);

      await placeCryptoOrder(viem, d, { buyerWallet: d.newAdmin });
      const escNewAdmin = await escrowAs(viem, d, d.newAdmin);
      const p2 = await buildAlipayProofForCrypto(d, {
        orderId: 1n,
        buyer: d.newAdmin.account.address,
        orderIdField: replayOrderId,
      });

      await expectRevertTracked(
        ctx,
        escNewAdmin.write.payOrderByPlatform([
          d.merchant.account.address, ALIPAY_CRYPTO_PID, 1n, p2.proofs,
        ]),
        "DuplicateAlipayOrderId",
      );
    });

    T("ALI-ATT-02", "旧支付复用攻击 -> AlipayTransferTooOld", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const order = await getOrderSnapshot(d, d.merchant.account.address, ALIPAY_CRYPTO_PID, ASSET_CRYPTO, 0n);
      const creation = order.deadline - ORDER_TIMEOUT;
      const built = await buildAlipayProofForCrypto(d, {
        gmtSuccess: toAlipayGmtSuccess(creation - 1n),
      });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, ALIPAY_CRYPTO_PID, 0n, built.proofs,
        ]),
        "AlipayTransferTooOld",
      );
    });

    T("ALI-ATT-03", "延时提交攻击 -> AlipayTransferDateExpired", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const order = await getOrderSnapshot(d, d.merchant.account.address, ALIPAY_CRYPTO_PID, ASSET_CRYPTO, 0n);
      const built = await buildAlipayProofForCrypto(d, {
        gmtSuccess: toAlipayGmtSuccess(order.deadline + 1n),
      });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, ALIPAY_CRYPTO_PID, 0n, built.proofs,
        ]),
        "AlipayTransferDateExpired",
      );
    });

    T("ALI-ATT-04", "字段删减绕过 -> MissingAlipayField", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const base = await buildAlipayProofForCrypto(d);
      const amount = toAmountX1000String(calcFiatX1000(base.order.amount, base.order.rate, ASSET_CRYPTO));
      const proof = await buildAlipayProofMissingField({
        omit: "status",
        verifierWallet: d.verifierSigner,
        orderBindingHash: base.orderBindingHash,
        chainId: CHAIN_ID,
        serverName: ALIPAY_SERVER,
        paymentTime: base.order.deadline - 60n,
        payAmount: amount,
      });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, ALIPAY_CRYPTO_PID, 0n, [proof],
        ]),
        "MissingAlipayField",
      );
    });

    T("ALI-ATT-05", "直连平台合约绕过 TLSN（普通地址）-> only TLSNVerifier", async (ctx) => {
      const alipayRandom = await alipayVerifierAs(viem, d, d.randomUser);
      await expectRevertTracked(
        ctx,
        alipayRandom.write.verifyMerchantSent(["0x1234", "0x5678"]),
        /only TLSNVerifier/,
      );
    });

    T("ALI-ATT-06", "伪造状态码 -> AlipayPaymentNotCompleted", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const built = await buildAlipayProofForCrypto(d, { status: "PENDING" });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, ALIPAY_CRYPTO_PID, 0n, built.proofs,
        ]),
        "AlipayPaymentNotCompleted",
      );
    });

    T("ALI-ATT-07", "伪造业务类型 -> InvalidAlipayBizType", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const built = await buildAlipayProofForCrypto(d, { bizType: "REFUND" });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, ALIPAY_CRYPTO_PID, 0n, built.proofs,
        ]),
        "InvalidAlipayBizType",
      );
    });

    T("ALI-ATT-08", "不可信 payment server -> NotTrustedPaymentServer", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const built = await buildAlipayProofForCrypto(d, {
        serverName: "evil.alipay.example",
      });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, ALIPAY_CRYPTO_PID, 0n, built.proofs,
        ]),
        "NotTrustedPaymentServer",
      );
    });
  });

  describe("TAMPER", () => {
    T("ALI-TAMPER-01", "商家改汇率后旧单 proof 仍可通过", async (ctx) => {
      await placeCryptoOrder(viem, d);
      await d.adminAsMerchant.write.publishRate([ALIPAY_CRYPTO_PID, ASSET_CRYPTO, RATE_ALIPAY_CRYPTO * 2n, 0n]);
      const built = await buildAlipayProofForCrypto(d);

      await sendTx(ctx, d.escrowAsBuyer.write.payOrderByPlatform([
        d.merchant.account.address, ALIPAY_CRYPTO_PID, 0n, built.proofs,
      ]));
    });

    T("ALI-TAMPER-02", "proof 使用错误 rateVersion -> OrderBindingHashMismatch", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const order = await getOrderSnapshot(d, d.merchant.account.address, ALIPAY_CRYPTO_PID, ASSET_CRYPTO, 0n);

      const forgedObh = computeOrderBindingHash({
        escrow: d.c2cEscrow.address,
        chainId: CHAIN_ID,
        merchant: d.merchant.account.address,
        buyer: order.buyer,
        productId: ALIPAY_CRYPTO_PID,
        orderId: 0n,
        assetType: ASSET_CRYPTO,
        amount: order.amount,
        rate: order.rate,
        rateVersion: order.rateVersion + 1n,
        deadline: order.deadline,
        merchantNameHash: MERCHANT_NAME_HASH,
        merchantIdHash: MERCHANT_ID_HASH,
        payeeNameHash: MERCHANT_NAME_HASH,
        payeeIdHash: MERCHANT_ID_HASH,
      });

      const built = await buildAlipayProofForCrypto(d, {
        orderBindingHash: forgedObh,
      });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, ALIPAY_CRYPTO_PID, 0n, built.proofs,
        ]),
        "OrderBindingHashMismatch",
      );
    });

    T("ALI-TAMPER-03", "改 buyer/payee 绑定 -> OrderBindingHashMismatch", async (ctx) => {
      await placeFiatOrder(viem, d);
      const built = await buildAlipayProofForFiat(d, {
        payeeNameHash: ATTACKER_NAME_HASH,
        payeeIdHash: ATTACKER_ID_HASH,
      });

      await expectRevertTracked(
        ctx,
        d.escrowAsMerchant.write.receiveCryptoWithPlatformPayment([
          ALIPAY_FIAT_PID, 0n, built.proofs,
        ]),
        "OrderBindingHashMismatch",
      );
    });

    T("ALI-TAMPER-04", "FIAT WAITING 订单 cancel -> NotPending (V4: OrderCancellationDisabled)", async (ctx) => {
      await placeFiatOrder(viem, d);
      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.cancelOrder([
          d.merchant.account.address, ALIPAY_FIAT_PID, ASSET_FIAT, 0n,
        ]),
        "NotPending|OrderCancellationDisabled",
      );
    });

    T("ALI-TAMPER-05", "非买家取消 PENDING 订单 -> NotAllowed (V4: OrderCancellationDisabled)", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const escRandom = await escrowAs(viem, d, d.randomUser);
      await expectRevertTracked(
        ctx,
        escRandom.write.cancelOrder([
          d.merchant.account.address, ALIPAY_CRYPTO_PID, ASSET_CRYPTO, 0n,
        ]),
        "NotAllowed|OrderCancellationDisabled",
      );
    });

    T("ALI-TAMPER-06", "非商家提交 FIAT 证明 -> WrongId（当前实现）", async (ctx) => {
      await placeFiatOrder(viem, d);
      const built = await buildAlipayProofForFiat(d);
      const escRandom = await escrowAs(viem, d, d.randomUser);

      await expectRevertTracked(
        ctx,
        escRandom.write.receiveCryptoWithPlatformPayment([
          ALIPAY_FIAT_PID, 0n, built.proofs,
        ]),
        "WrongId",
      );
    });

    T("ALI-TAMPER-07", "订单完成后重复提交 proof：cleanup 后 OrderNotFound；未 cleanup 时 NotPending", async (ctx) => {
      // Case A: completed order is cleaned up, replay hits OrderNotFound.
      await placeCryptoOrder(viem, d);
      const built = await buildAlipayProofForCrypto(d, { orderId: 0n });

      await d.escrowAsBuyer.write.payOrderByPlatform([
        d.merchant.account.address, ALIPAY_CRYPTO_PID, 0n, built.proofs,
      ]);

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, ALIPAY_CRYPTO_PID, 0n, built.proofs,
        ]),
        "OrderNotFound",
      );

      // Case B: head pending order blocks cleanup, completed order remains -> NotPending.
      await fundAndApproveWallet(viem, d, d.newAdmin);
      await placeCryptoOrder(viem, d, { buyerWallet: d.buyer }); // orderId=1, head pending
      await placeCryptoOrder(viem, d, { buyerWallet: d.newAdmin }); // orderId=2, target completed
      const escNewAdmin = await escrowAs(viem, d, d.newAdmin);
      const built2 = await buildAlipayProofForCrypto(d, { orderId: 2n });
      assert.ok(built2.order.deadline > (await pc.getBlock()).timestamp, "replay case should run before deadline");

      await escNewAdmin.write.payOrderByPlatform([
        d.merchant.account.address, ALIPAY_CRYPTO_PID, 2n, built2.proofs,
      ]);

      await expectRevertTracked(
        ctx,
        escNewAdmin.write.payOrderByPlatform([
          d.merchant.account.address, ALIPAY_CRYPTO_PID, 2n, built2.proofs,
        ]),
        "NotPending",
      );
    });

    T("ALI-TAMPER-08", "商家更新支付哈希后复用旧 proof 仍可通过", async (ctx) => {
      await placeCryptoOrder(viem, d);
      await d.adminAsMerchant.write.setPlatformBinding([
        PLATFORM_ALIPAY,
        ALT_MERCHANT_NAME_HASH,
        ALT_MERCHANT_ID_HASH,
      ]);

      const built = await buildAlipayProofForCrypto(d, {
        merchantNameHash: MERCHANT_NAME_HASH,
        merchantIdHash: MERCHANT_ID_HASH,
        payeeNameHash: MERCHANT_NAME_HASH,
        payeeIdHash: MERCHANT_ID_HASH,
      });

      await sendTx(ctx, d.escrowAsBuyer.write.payOrderByPlatform([
        d.merchant.account.address, ALIPAY_CRYPTO_PID, 0n, built.proofs,
      ]));
    });

    T("ALI-TAMPER-09", "非营业时段下单 -> MerchantClosed", async (ctx) => {
      await d.adminAsMerchant.write.closeNow([ALIPAY_CRYPTO_PID, ASSET_CRYPTO]);
      await expectRevertTracked(
        ctx,
        placeCryptoOrder(viem, d),
        "MerchantClosed",
      );
    });

    T("ALI-TAMPER-10", "改支付哈希后用新哈希签旧订单 -> OrderBindingHashMismatch", async (ctx) => {
      await placeCryptoOrder(viem, d);
      await d.adminAsMerchant.write.setPlatformBinding([
        PLATFORM_ALIPAY,
        ALT_MERCHANT_NAME_HASH,
        ALT_MERCHANT_ID_HASH,
      ]);

      const built = await buildAlipayProofForCrypto(d, {
        merchantNameHash: ALT_MERCHANT_NAME_HASH,
        merchantIdHash: ALT_MERCHANT_ID_HASH,
        payeeNameHash: ALT_MERCHANT_NAME_HASH,
        payeeIdHash: ALT_MERCHANT_ID_HASH,
      });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, ALIPAY_CRYPTO_PID, 0n, built.proofs,
        ]),
        "OrderBindingHashMismatch",
      );
    });
  });
});
