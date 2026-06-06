
/**
 * WisePlatform.ts
 *
 * Test suite for Wise platform verifier flow through C2CEscrow entrypoints.
 * Covers: WISE-FLOW-01~05, WISE-ERR-01~14, WISE-ATT-01~08, WISE-TAMPER-01~07
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
  buildWiseContactsProof,
  buildWiseTransferProof,
  buildWiseTransferProofMissingField,
  nextSession,
  type TLSNProof,
} from "./helpers/proofBuilder.js";
import { computeOrderBindingHash } from "./helpers/orderBindingHash.js";
import {
  BUYER_HANDLE,
  BUYER_NAME,
  COLLATERAL,
  MYR_FIAT_ID,
  MYR_NAME,
  ORDER_TIMEOUT,
  RATE_WISE_CRYPTO,
  RATE_WISE_FIAT,
  TRADE_AMOUNT,
  USDT_CRYPTO_ID,
  WISE_MERCHANT_HANDLE,
  WISE_MERCHANT_NAME,
  WISE_SERVER,
  ZERO_HASH,
} from "./helpers/constants.js";

const CHAIN_ID = 31337n;
const ASSET_CRYPTO = 0;
const ASSET_FIAT = 1;

const WISE_CRYPTO_PID = 0n;
const WISE_FIAT_PID = 0n;

const MAX_UINT = (2n ** 256n) - 1n;

const MERCHANT_NAME_HASH = keccak256(toBytes(WISE_MERCHANT_NAME));
const MERCHANT_ID_HASH = keccak256(toBytes(WISE_MERCHANT_HANDLE));
const BUYER_NAME_HASH = keccak256(toBytes(BUYER_NAME));
const BUYER_ID_HASH = keccak256(toBytes(BUYER_HANDLE));

const ALT_MERCHANT_NAME_HASH = keccak256(toBytes("ALT-WISE-MERCHANT"));
const ALT_MERCHANT_ID_HASH = keccak256(toBytes("@alt-wise-merchant"));
const ATTACKER_NAME_HASH = keccak256(toBytes("ATTACKER-NAME"));
const ATTACKER_ID_HASH = keccak256(toBytes("attacker@example.com"));
const SECOND_MERCHANT_NAME_HASH = keccak256(toBytes("SECOND-MERCHANT"));
const SECOND_MERCHANT_ID_HASH = keccak256(toBytes("@second-merchant"));

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

let _wiseTransferId = 900_000_000n;
function nextWiseTransferId(): bigint {
  _wiseTransferId += 1n;
  return _wiseTransferId;
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

function toBytes32Uint(v: bigint): Hex {
  return `0x${v.toString(16).padStart(64, "0")}` as Hex;
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
      err?.cause?.message,
      err?.cause?.shortMessage,
      err?.cause?.details,
      err?.cause?.cause?.message,
      err?.cause?.cause?.shortMessage,
      err?.cause?.cause?.details,
      String(err),
      String(err?.cause ?? ""),
      String(err?.cause?.cause ?? ""),
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

async function wiseVerifierAs(viem: any, d: DeployResult, wallet: any) {
  return viem.getContractAt("WisePlatformVerifier", d.wisePlatformVerifier.address, {
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
  const PLATFORM_WISE: Hex = await d.tlsnVerifier.read.PLATFORM_WISE();

  await d.c2cAdmin.write.registerMerchantByAdmin([d.merchant.account.address]);
  await d.adminAsMerchant.write.setPlatformBinding([
    PLATFORM_WISE,
    MERCHANT_NAME_HASH,
    MERCHANT_ID_HASH,
  ]);

  await d.usdtAsMerchant.write.approve([d.c2cEscrow.address, MAX_UINT]);
  await d.usdtAsBuyer.write.approve([d.c2cEscrow.address, MAX_UINT]);

  await d.escrowAsMerchant.write.listCryptoProduct([
    USDT_CRYPTO_ID, MYR_FIAT_ID, COLLATERAL, true, PLATFORM_WISE,
  ]);
  await d.escrowAsMerchant.write.listFiatProduct([
    MYR_FIAT_ID, USDT_CRYPTO_ID, COLLATERAL, true, PLATFORM_WISE,
  ]);

  const expiry = (await pc.getBlock()).timestamp + 365n * 24n * 3600n;
  await d.adminAsMerchant.write.publishRate([WISE_CRYPTO_PID, ASSET_CRYPTO, RATE_WISE_CRYPTO, expiry]);
  await d.adminAsMerchant.write.publishRate([WISE_FIAT_PID, ASSET_FIAT, RATE_WISE_FIAT, expiry]);

  await d.adminAsMerchant.write.openNow([WISE_CRYPTO_PID, ASSET_CRYPTO]);
  await d.adminAsMerchant.write.openNow([WISE_FIAT_PID, ASSET_FIAT]);

  return { d, pc, PLATFORM_WISE };
}

async function setupSecondWiseMerchant(
  viem: any,
  d: DeployResult,
  pc: any,
  wallet: any,
  merchantNameHash: Hex,
  merchantIdHash: Hex,
) {
  await d.c2cAdmin.write.registerMerchantByAdmin([wallet.account.address]);
  await fundAndApproveWallet(viem, d, wallet, COLLATERAL * 5n);

  const adminWallet = await adminAs(viem, d, wallet);
  const escrowWallet = await escrowAs(viem, d, wallet);
  const PLATFORM_WISE: Hex = await d.tlsnVerifier.read.PLATFORM_WISE();

  await adminWallet.write.setPlatformBinding([
    PLATFORM_WISE,
    merchantNameHash,
    merchantIdHash,
  ]);
  await escrowWallet.write.listCryptoProduct([
    USDT_CRYPTO_ID, MYR_FIAT_ID, COLLATERAL, true, PLATFORM_WISE,
  ]);

  const expiry = (await pc.getBlock()).timestamp + 365n * 24n * 3600n;
  await adminWallet.write.publishRate([WISE_CRYPTO_PID, ASSET_CRYPTO, RATE_WISE_CRYPTO, expiry]);
  await adminWallet.write.openNow([WISE_CRYPTO_PID, ASSET_CRYPTO]);
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
  const productId = p.productId ?? WISE_CRYPTO_PID;
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
  const productId = p.productId ?? WISE_FIAT_PID;
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

async function buildWiseProofPairForCrypto(
  d: DeployResult,
  p: {
    merchant?: Address;
    productId?: bigint;
    orderId?: bigint;
    chainId?: bigint;
    serverName?: string;
    transferId?: bigint;
    sessionIdContacts?: string;
    sessionIdTransfer?: string;
    state?: string;
    targetAmount?: string;
    targetCurrency?: string;
    dateMs?: bigint;
    orderBindingHash?: Hex;
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
  const productId = p.productId ?? WISE_CRYPTO_PID;
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
  const transferAmount = p.targetAmount ?? toAmountX1000String(fiatX1000);

  const contacts = await buildWiseContactsProof({
    verifierWallet: p.verifierWallet ?? d.verifierSigner,
    orderBindingHash: obh,
    chainId: p.chainId ?? CHAIN_ID,
    sessionId: p.sessionIdContacts,
    serverName: p.serverName ?? WISE_SERVER,
    overrideSignature: p.overrideSignature,
  });

  const transfer = await buildWiseTransferProof({
    verifierWallet: p.verifierWallet ?? d.verifierSigner,
    orderBindingHash: obh,
    chainId: p.chainId ?? CHAIN_ID,
    sessionId: p.sessionIdTransfer,
    serverName: p.serverName ?? WISE_SERVER,
    fields: {
      state: p.state ?? "OUTGOING_PAYMENT_SENT",
      targetAmount: transferAmount,
      targetCurrency: p.targetCurrency ?? MYR_NAME,
      transferId: p.transferId ?? nextWiseTransferId(),
      dateMs: p.dateMs ?? (order.deadline - 60n) * 1000n,
    },
    overrideCommitmentsHash: p.overrideCommitmentsHash,
    overrideSignature: p.overrideSignature,
  });

  return { proofs: [contacts, transfer] as TLSNProof[], order, orderBindingHash: obh };
}
async function buildWiseProofPairForFiat(
  d: DeployResult,
  p: {
    merchant?: Address;
    productId?: bigint;
    orderId?: bigint;
    chainId?: bigint;
    serverName?: string;
    transferId?: bigint;
    sessionIdContacts?: string;
    sessionIdTransfer?: string;
    state?: string;
    targetAmount?: string;
    targetCurrency?: string;
    dateMs?: bigint;
    orderBindingHash?: Hex;
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
  const productId = p.productId ?? WISE_FIAT_PID;
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
  const transferAmount = p.targetAmount ?? toAmountX1000String(fiatX1000);

  const contacts = await buildWiseContactsProof({
    verifierWallet: p.verifierWallet ?? d.verifierSigner,
    orderBindingHash: obh,
    chainId: p.chainId ?? CHAIN_ID,
    sessionId: p.sessionIdContacts,
    serverName: p.serverName ?? WISE_SERVER,
    overrideSignature: p.overrideSignature,
  });

  const transfer = await buildWiseTransferProof({
    verifierWallet: p.verifierWallet ?? d.verifierSigner,
    orderBindingHash: obh,
    chainId: p.chainId ?? CHAIN_ID,
    sessionId: p.sessionIdTransfer,
    serverName: p.serverName ?? WISE_SERVER,
    fields: {
      state: p.state ?? "OUTGOING_PAYMENT_SENT",
      targetAmount: transferAmount,
      targetCurrency: p.targetCurrency ?? MYR_NAME,
      transferId: p.transferId ?? nextWiseTransferId(),
      dateMs: p.dateMs ?? (order.deadline - 60n) * 1000n,
    },
    overrideCommitmentsHash: p.overrideCommitmentsHash,
    overrideSignature: p.overrideSignature,
  });

  return { proofs: [contacts, transfer] as TLSNProof[], order, orderBindingHash: obh };
}

async function assertPlatformPaymentEvent(
  d: DeployResult,
  receipt: any,
  platformId: Hex,
  isMerchantSent: boolean,
  transferId: bigint,
) {
  const expectedTxId = toBytes32Uint(transferId).toLowerCase();
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

describe("WisePlatformVerifier", async function () {
  const { viem } = await network.getOrCreate();
  const testClient = await viem.getTestClient();

  let d: DeployResult;
  let pc: any;
  let PLATFORM_WISE: Hex;
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
    PLATFORM_WISE = base.PLATFORM_WISE;
    snap = await testClient.snapshot();
  });

  beforeEach(async () => {
    await testClient.revert({ id: snap });
    snap = await testClient.snapshot();
  });

  after(() => {
    printTable("WisePlatform 测试报告");
  });

  describe("FLOW", () => {
    T("WISE-FLOW-01", "买家支付验证成功，txId=transferId", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const transferId = nextWiseTransferId();
      const { proofs } = await buildWiseProofPairForCrypto(d, { transferId });

      const buyerBefore = await d.usdt.read.balanceOf([d.buyer.account.address]);
      const receipt = await sendTx(ctx, d.escrowAsBuyer.write.payOrderByPlatform([
        d.merchant.account.address, WISE_CRYPTO_PID, 0n, proofs,
      ]));
      const buyerAfter = await d.usdt.read.balanceOf([d.buyer.account.address]);

      assert.equal(buyerAfter - buyerBefore, TRADE_AMOUNT);
      await assertPlatformPaymentEvent(d, receipt, PLATFORM_WISE, false, transferId);
    });

    T("WISE-FLOW-02", "商家收款验证成功，txId=transferId", async (ctx) => {
      await placeFiatOrder(viem, d);
      const transferId = nextWiseTransferId();
      const { proofs } = await buildWiseProofPairForFiat(d, { transferId });

      const merchantBefore = await d.usdt.read.balanceOf([d.merchant.account.address]);
      const receipt = await sendTx(ctx, d.escrowAsMerchant.write.receiveCryptoWithPlatformPayment([
        WISE_FIAT_PID, 0n, proofs,
      ]));
      const merchantAfter = await d.usdt.read.balanceOf([d.merchant.account.address]);

      assert.equal(merchantAfter - merchantBefore, TRADE_AMOUNT);
      await assertPlatformPaymentEvent(d, receipt, PLATFORM_WISE, true, transferId);
    });

    T("WISE-FLOW-03", "时间边界 dateMs/1000 == orderCreationTime 允许通过", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const order = await getOrderSnapshot(d, d.merchant.account.address, WISE_CRYPTO_PID, ASSET_CRYPTO, 0n);
      const creation = order.deadline - ORDER_TIMEOUT;
      const transferId = nextWiseTransferId();
      const { proofs } = await buildWiseProofPairForCrypto(d, {
        transferId,
        dateMs: creation * 1000n,
      });

      await sendTx(ctx, d.escrowAsBuyer.write.payOrderByPlatform([
        d.merchant.account.address, WISE_CRYPTO_PID, 0n, proofs,
      ]));
    });

    T("WISE-FLOW-04", "时间边界 dateMs/1000 == orderDeadline 允许通过", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const order = await getOrderSnapshot(d, d.merchant.account.address, WISE_CRYPTO_PID, ASSET_CRYPTO, 0n);
      const transferId = nextWiseTransferId();
      const { proofs } = await buildWiseProofPairForCrypto(d, {
        transferId,
        dateMs: order.deadline * 1000n,
      });

      await sendTx(ctx, d.escrowAsBuyer.write.payOrderByPlatform([
        d.merchant.account.address, WISE_CRYPTO_PID, 0n, proofs,
      ]));
    });

    T("WISE-FLOW-05", "transferId 成功后落库 usedTransferIds=true", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const transferId = nextWiseTransferId();
      const { proofs } = await buildWiseProofPairForCrypto(d, { transferId });

      await sendTx(ctx, d.escrowAsBuyer.write.payOrderByPlatform([
        d.merchant.account.address, WISE_CRYPTO_PID, 0n, proofs,
      ]));

      const used = await d.wisePlatformVerifier.read.usedTransferIds([transferId]);
      assert.equal(used, true);
    });
  });
  describe("ERR", () => {
    T("WISE-ERR-01", "非 TLSNVerifier 直接调用 verify*", async (ctx) => {
      const wiseRandom = await wiseVerifierAs(viem, d, d.randomUser);
      await expectRevertTracked(
        ctx,
        wiseRandom.write.verifyBuyerPayment(["0x1234", "0x5678"]),
        /only TLSNVerifier/,
      );
    });

    T("WISE-ERR-02", "proof 数量不足（仅 transfer 或 contacts）", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const built = await buildWiseProofPairForCrypto(d);

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, WISE_CRYPTO_PID, 0n, [built.proofs[0]],
        ]),
        /(0x32|out-of-bounds|panic|revert)/i,
      );

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, WISE_CRYPTO_PID, 0n, [built.proofs[1]],
        ]),
        /(0x32|out-of-bounds|panic|revert)/i,
      );
    });

    T("WISE-ERR-03", "proof 顺序颠倒 [transfer, contacts]", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const built = await buildWiseProofPairForCrypto(d);

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, WISE_CRYPTO_PID, 0n, [built.proofs[1], built.proofs[0]],
        ]),
        "MissingWiseField",
      );
    });

    T("WISE-ERR-04", "state 不匹配 -> PaymentNotCompleted", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const { proofs } = await buildWiseProofPairForCrypto(d, { state: "PENDING" });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, WISE_CRYPTO_PID, 0n, proofs,
        ]),
        "PaymentNotCompleted",
      );
    });

    T("WISE-ERR-05", "amount 不匹配 -> PaymentAmountMismatch", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const { proofs } = await buildWiseProofPairForCrypto(d, { targetAmount: "999.999" });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, WISE_CRYPTO_PID, 0n, proofs,
        ]),
        "PaymentAmountMismatch",
      );
    });

    T("WISE-ERR-06", "currency 不匹配 -> CurrencyMismatch", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const { proofs } = await buildWiseProofPairForCrypto(d, { targetCurrency: "USD" });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, WISE_CRYPTO_PID, 0n, proofs,
        ]),
        "CurrencyMismatch",
      );
    });

    T("WISE-ERR-07", "transferId 重放 -> DuplicateTransferId", async (ctx) => {
      const transferId = nextWiseTransferId();

      await placeCryptoOrder(viem, d);
      const first = await buildWiseProofPairForCrypto(d, { transferId });
      await d.escrowAsBuyer.write.payOrderByPlatform([
        d.merchant.account.address, WISE_CRYPTO_PID, 0n, first.proofs,
      ]);

      await placeCryptoOrder(viem, d);
      const second = await buildWiseProofPairForCrypto(d, { orderId: 1n, transferId });
      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, WISE_CRYPTO_PID, 1n, second.proofs,
        ]),
        "DuplicateTransferId",
      );
    });

    T("WISE-ERR-08", "付款早于下单 -> WiseTransferTooOld", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const order = await getOrderSnapshot(d, d.merchant.account.address, WISE_CRYPTO_PID, ASSET_CRYPTO, 0n);
      const creation = order.deadline - ORDER_TIMEOUT;
      const { proofs } = await buildWiseProofPairForCrypto(d, {
        dateMs: (creation - 1n) * 1000n,
      });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, WISE_CRYPTO_PID, 0n, proofs,
        ]),
        "WiseTransferTooOld",
      );
    });

    T("WISE-ERR-09", "付款晚于截止 -> TransferDateExpired", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const order = await getOrderSnapshot(d, d.merchant.account.address, WISE_CRYPTO_PID, ASSET_CRYPTO, 0n);
      const { proofs } = await buildWiseProofPairForCrypto(d, {
        dateMs: (order.deadline + 1n) * 1000n,
      });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, WISE_CRYPTO_PID, 0n, proofs,
        ]),
        "TransferDateExpired",
      );
    });

    T("WISE-ERR-10", "缺 state 字段 -> MissingWiseField", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const base = await buildWiseProofPairForCrypto(d);
      const amount = toAmountX1000String(calcFiatX1000(base.order.amount, base.order.rate, ASSET_CRYPTO));

      const transfer = await buildWiseTransferProofMissingField({
        omit: "state",
        verifierWallet: d.verifierSigner,
        orderBindingHash: base.orderBindingHash,
        chainId: CHAIN_ID,
        serverName: WISE_SERVER,
        dateMs: (base.order.deadline - 60n) * 1000n,
        targetAmount: amount,
        targetCurrency: MYR_NAME,
        transferId: nextWiseTransferId(),
      });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, WISE_CRYPTO_PID, 0n, [base.proofs[0], transfer],
        ]),
        "MissingWiseField",
      );
    });

    T("WISE-ERR-11", "缺 targetAmount 字段 -> MissingWiseField", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const base = await buildWiseProofPairForCrypto(d);
      const amount = toAmountX1000String(calcFiatX1000(base.order.amount, base.order.rate, ASSET_CRYPTO));

      const transfer = await buildWiseTransferProofMissingField({
        omit: "targetAmount",
        verifierWallet: d.verifierSigner,
        orderBindingHash: base.orderBindingHash,
        chainId: CHAIN_ID,
        serverName: WISE_SERVER,
        dateMs: (base.order.deadline - 60n) * 1000n,
        targetAmount: amount,
        targetCurrency: MYR_NAME,
        transferId: nextWiseTransferId(),
      });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, WISE_CRYPTO_PID, 0n, [base.proofs[0], transfer],
        ]),
        "MissingWiseField",
      );
    });

    T("WISE-ERR-12", "缺 targetCurrency 字段 -> MissingWiseField", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const base = await buildWiseProofPairForCrypto(d);
      const amount = toAmountX1000String(calcFiatX1000(base.order.amount, base.order.rate, ASSET_CRYPTO));

      const transfer = await buildWiseTransferProofMissingField({
        omit: "targetCurrency",
        verifierWallet: d.verifierSigner,
        orderBindingHash: base.orderBindingHash,
        chainId: CHAIN_ID,
        serverName: WISE_SERVER,
        dateMs: (base.order.deadline - 60n) * 1000n,
        targetAmount: amount,
        targetCurrency: MYR_NAME,
        transferId: nextWiseTransferId(),
      });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, WISE_CRYPTO_PID, 0n, [base.proofs[0], transfer],
        ]),
        "MissingWiseField",
      );
    });

    T("WISE-ERR-13", "缺 id 字段 -> MissingWiseField", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const base = await buildWiseProofPairForCrypto(d);
      const amount = toAmountX1000String(calcFiatX1000(base.order.amount, base.order.rate, ASSET_CRYPTO));

      const transfer = await buildWiseTransferProofMissingField({
        omit: "transferId",
        verifierWallet: d.verifierSigner,
        orderBindingHash: base.orderBindingHash,
        chainId: CHAIN_ID,
        serverName: WISE_SERVER,
        dateMs: (base.order.deadline - 60n) * 1000n,
        targetAmount: amount,
        targetCurrency: MYR_NAME,
        transferId: nextWiseTransferId(),
      });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, WISE_CRYPTO_PID, 0n, [base.proofs[0], transfer],
        ]),
        "MissingWiseField",
      );
    });

    T("WISE-ERR-14", "缺 date 字段 -> MissingWiseField", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const base = await buildWiseProofPairForCrypto(d);
      const amount = toAmountX1000String(calcFiatX1000(base.order.amount, base.order.rate, ASSET_CRYPTO));

      const transfer = await buildWiseTransferProofMissingField({
        omit: "dateMs",
        verifierWallet: d.verifierSigner,
        orderBindingHash: base.orderBindingHash,
        chainId: CHAIN_ID,
        serverName: WISE_SERVER,
        dateMs: (base.order.deadline - 60n) * 1000n,
        targetAmount: amount,
        targetCurrency: MYR_NAME,
        transferId: nextWiseTransferId(),
      });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, WISE_CRYPTO_PID, 0n, [base.proofs[0], transfer],
        ]),
        "MissingWiseField",
      );
    });
  });
  describe("ATTACK", () => {
    T("WISE-ATT-01", "跨订单 transferId replay -> DuplicateTransferId", async (ctx) => {
      await fundAndApproveWallet(viem, d, d.newAdmin);
      const transferId = nextWiseTransferId();

      await placeCryptoOrder(viem, d, { buyerWallet: d.buyer });
      const p1 = await buildWiseProofPairForCrypto(d, { orderId: 0n, transferId });
      await d.escrowAsBuyer.write.payOrderByPlatform([
        d.merchant.account.address, WISE_CRYPTO_PID, 0n, p1.proofs,
      ]);

      await placeCryptoOrder(viem, d, { buyerWallet: d.newAdmin });
      const escNewAdmin = await escrowAs(viem, d, d.newAdmin);
      const p2 = await buildWiseProofPairForCrypto(d, { orderId: 1n, transferId });

      await expectRevertTracked(
        ctx,
        escNewAdmin.write.payOrderByPlatform([
          d.merchant.account.address, WISE_CRYPTO_PID, 1n, p2.proofs,
        ]),
        "DuplicateTransferId",
      );
    });

    T("WISE-ATT-02", "旧转账复用攻击 -> WiseTransferTooOld", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const order = await getOrderSnapshot(d, d.merchant.account.address, WISE_CRYPTO_PID, ASSET_CRYPTO, 0n);
      const creation = order.deadline - ORDER_TIMEOUT;
      const { proofs } = await buildWiseProofPairForCrypto(d, {
        dateMs: (creation - 1n) * 1000n,
      });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, WISE_CRYPTO_PID, 0n, proofs,
        ]),
        "WiseTransferTooOld",
      );
    });

    T("WISE-ATT-03", "延迟提交攻击 -> TransferDateExpired", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const order = await getOrderSnapshot(d, d.merchant.account.address, WISE_CRYPTO_PID, ASSET_CRYPTO, 0n);
      const { proofs } = await buildWiseProofPairForCrypto(d, {
        dateMs: (order.deadline + 1n) * 1000n,
      });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, WISE_CRYPTO_PID, 0n, proofs,
        ]),
        "TransferDateExpired",
      );
    });

    T("WISE-ATT-04", "伪造 amount/currency -> 参数校验拒绝", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const { proofs } = await buildWiseProofPairForCrypto(d, {
        targetAmount: "888.888",
        targetCurrency: "USD",
      });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, WISE_CRYPTO_PID, 0n, proofs,
        ]),
        /(PaymentAmountMismatch|CurrencyMismatch)/,
      );
    });

    T("WISE-ATT-05", "弱化 contacts proof（文档性用例）", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const base = await buildWiseProofPairForCrypto(d);

      const fakeContacts = await buildWiseTransferProof({
        verifierWallet: d.verifierSigner,
        orderBindingHash: base.orderBindingHash,
        chainId: CHAIN_ID,
        serverName: WISE_SERVER,
        fields: {
          state: "NOT_CONTACTS",
          targetAmount: "0.001",
          targetCurrency: "ZZZ",
          transferId: nextWiseTransferId(),
          dateMs: (base.order.deadline - 10n) * 1000n,
        },
      });

      await sendTx(ctx, d.escrowAsBuyer.write.payOrderByPlatform([
        d.merchant.account.address, WISE_CRYPTO_PID, 0n, [fakeContacts, base.proofs[1]],
      ]));
    });

    T("WISE-ATT-06", "直连调用平台合约绕过 TLSN -> only TLSNVerifier", async (ctx) => {
      const wiseRandom = await wiseVerifierAs(viem, d, d.randomUser);
      await expectRevertTracked(
        ctx,
        wiseRandom.write.verifyMerchantSent(["0x1234", "0x5678"]),
        /only TLSNVerifier/,
      );
    });

    T("WISE-ATT-07", "session replay（跨 proof）-> SessionAlreadyUsed", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const sid = nextSession();
      const { proofs } = await buildWiseProofPairForCrypto(d, {
        sessionIdContacts: sid,
        sessionIdTransfer: sid,
      });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, WISE_CRYPTO_PID, 0n, proofs,
        ]),
        "SessionAlreadyUsed",
      );
    });

    T("WISE-ATT-08", "不可信 payment server -> NotTrustedPaymentServer", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const { proofs } = await buildWiseProofPairForCrypto(d, {
        serverName: "evil.wise.example",
      });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, WISE_CRYPTO_PID, 0n, proofs,
        ]),
        "NotTrustedPaymentServer",
      );
    });
  });

  describe("TAMPER", () => {
    T("WISE-TAMPER-01", "商家改支付哈希后沿用旧 proof 仍可通过", async (ctx) => {
      await placeCryptoOrder(viem, d);
      await d.adminAsMerchant.write.setPlatformBinding([
        PLATFORM_WISE,
        ALT_MERCHANT_NAME_HASH,
        ALT_MERCHANT_ID_HASH,
      ]);

      const { proofs } = await buildWiseProofPairForCrypto(d, {
        merchantNameHash: MERCHANT_NAME_HASH,
        merchantIdHash: MERCHANT_ID_HASH,
        payeeNameHash: MERCHANT_NAME_HASH,
        payeeIdHash: MERCHANT_ID_HASH,
      });

      await sendTx(ctx, d.escrowAsBuyer.write.payOrderByPlatform([
        d.merchant.account.address, WISE_CRYPTO_PID, 0n, proofs,
      ]));
    });

    T("WISE-TAMPER-02", "改 rateVersion 提交 -> OrderBindingHashMismatch", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const order = await getOrderSnapshot(d, d.merchant.account.address, WISE_CRYPTO_PID, ASSET_CRYPTO, 0n);

      const forgedObh = computeOrderBindingHash({
        escrow: d.c2cEscrow.address,
        chainId: CHAIN_ID,
        merchant: d.merchant.account.address,
        buyer: order.buyer,
        productId: WISE_CRYPTO_PID,
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

      const { proofs } = await buildWiseProofPairForCrypto(d, {
        orderBindingHash: forgedObh,
      });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, WISE_CRYPTO_PID, 0n, proofs,
        ]),
        "OrderBindingHashMismatch",
      );
    });

    T("WISE-TAMPER-03", "改 buyer/payee 绑定 -> OrderBindingHashMismatch", async (ctx) => {
      await placeFiatOrder(viem, d);
      const { proofs } = await buildWiseProofPairForFiat(d, {
        payeeNameHash: ATTACKER_NAME_HASH,
        payeeIdHash: ATTACKER_ID_HASH,
      });

      await expectRevertTracked(
        ctx,
        d.escrowAsMerchant.write.receiveCryptoWithPlatformPayment([
          WISE_FIAT_PID, 0n, proofs,
        ]),
        "OrderBindingHashMismatch",
      );
    });

    T("WISE-TAMPER-04", "商家更新汇率后旧单 proof 仍可通过", async (ctx) => {
      await placeCryptoOrder(viem, d);
      await d.adminAsMerchant.write.publishRate([WISE_CRYPTO_PID, ASSET_CRYPTO, RATE_WISE_CRYPTO * 2n, 0n]);
      const { proofs } = await buildWiseProofPairForCrypto(d);

      await sendTx(ctx, d.escrowAsBuyer.write.payOrderByPlatform([
        d.merchant.account.address, WISE_CRYPTO_PID, 0n, proofs,
      ]));
    });

    T("WISE-TAMPER-05", "订单完成后重复提交同 proof", async (ctx) => {
      await placeCryptoOrder(viem, d);
      const built = await buildWiseProofPairForCrypto(d);

      await d.escrowAsBuyer.write.payOrderByPlatform([
        d.merchant.account.address, WISE_CRYPTO_PID, 0n, built.proofs,
      ]);

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, WISE_CRYPTO_PID, 0n, built.proofs,
        ]),
        /(OutOfDeadline|OrderNotFound)/,
      );
    });
    T("WISE-TAMPER-06", "伪造同平台不同商家上下文 -> 绑定不一致拒绝", async (ctx) => {
      await setupSecondWiseMerchant(
        viem,
        d,
        pc,
        d.newAdmin,
        SECOND_MERCHANT_NAME_HASH,
        SECOND_MERCHANT_ID_HASH,
      );

      await placeCryptoOrder(viem, d, { merchant: d.merchant.account.address });
      const victimProof = await buildWiseProofPairForCrypto(d, {
        merchant: d.merchant.account.address,
        orderId: 0n,
      });

      await placeCryptoOrder(viem, d, { merchant: d.newAdmin.account.address });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.newAdmin.account.address,
          WISE_CRYPTO_PID,
          0n,
          victimProof.proofs,
        ]),
        "OrderBindingHashMismatch",
      );
    });

    T("WISE-TAMPER-07", "改支付哈希后用新哈希签旧订单 -> OrderBindingHashMismatch", async (ctx) => {
      await placeCryptoOrder(viem, d);
      await d.adminAsMerchant.write.setPlatformBinding([
        PLATFORM_WISE,
        ALT_MERCHANT_NAME_HASH,
        ALT_MERCHANT_ID_HASH,
      ]);

      const { proofs } = await buildWiseProofPairForCrypto(d, {
        merchantNameHash: ALT_MERCHANT_NAME_HASH,
        merchantIdHash: ALT_MERCHANT_ID_HASH,
        payeeNameHash: ALT_MERCHANT_NAME_HASH,
        payeeIdHash: ALT_MERCHANT_ID_HASH,
      });

      await expectRevertTracked(
        ctx,
        d.escrowAsBuyer.write.payOrderByPlatform([
          d.merchant.account.address, WISE_CRYPTO_PID, 0n, proofs,
        ]),
        "OrderBindingHashMismatch",
      );
    });
  });
});
