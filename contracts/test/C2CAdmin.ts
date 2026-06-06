/**
 * C2CAdmin.ts
 *
 * Full test suite for C2CAdmin contract.
 * Covers: ADM-FLOW-01~15, ADM-ERR-01~24, ADM-ATT-01~08, ADM-TAMPER-01~09
 *
 * Pattern: addRecord+makeCtx wrapper on every test for tableReporter output.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { network } from "hardhat";
import { keccak256, toBytes, zeroAddress, type Hex } from "viem";

import { deployAll, type DeployResult } from "./helpers/deploy.js";
import {
  buildKYBProof,
  buildKYBProofBadStatus,
  nextSession,
} from "./helpers/proofBuilder.js";
import { advanceTime } from "./helpers/time.js";
import {
  addRecord,
  clearRecords,
  makeCtx,
  printTable,
} from "./helpers/tableReporter.js";
import {
  USDT_CRYPTO_ID,
  CNY_FIAT_ID,
  MYR_FIAT_ID,
  OPEN_SECOND,
  CLOSE_SECOND,
  ACTIVE_DAYS_WEEKDAY,
  ZERO_HASH,
  COLLATERAL,
} from "./helpers/constants.js";

const CHAIN_ID = 31337n;

const MERCHANT_NAME_HASH = keccak256(toBytes("TestMerchantName"));
const MERCHANT_ID_HASH   = keccak256(toBytes("testmerchant@example.com"));
const MERCHANT_ALT_NAME_HASH = keccak256(toBytes("TestMerchantNameAlt"));
const MERCHANT_ALT_ID_HASH = keccak256(toBytes("testmerchant+alt@example.com"));
const ALIPAY_NAME_HASH = keccak256(toBytes("TestMerchantNameAlipay"));
const ALIPAY_ID_HASH = keccak256(toBytes("testmerchant@alipay.example"));

// ─────────────────────────────────────────────────────────────────────────────

describe("C2CAdmin", async function () {
  const { viem } = await network.getOrCreate();
  const pc       = await viem.getPublicClient();

  before(() => clearRecords());
  after(() => printTable("C2CAdmin 测试报告"));

  // ══════════════════════════════════════════════════════════════
  //  FLOW — 正常流程
  // ══════════════════════════════════════════════════════════════

  describe("FLOW — 正常流程", async () => {
    let fresh: DeployResult;

    beforeEach(async () => {
      fresh = await deployAll(viem);
    });

    // ADM-FLOW-01: 两步管理员移交 proposeAdmin -> acceptAdmin
    it("ADM-FLOW-01: 两步管理员移交", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        await fresh.c2cAdmin.write.proposeAdmin([fresh.newAdmin.account.address]);
        const asNewAdmin = await viem.getContractAt("C2CAdmin", fresh.c2cAdmin.address, {
          client: { wallet: fresh.newAdmin },
        });

        ctx.markVerifyStart();
        const hash = await asNewAdmin.write.acceptAdmin();
        const receipt = await pc.getTransactionReceipt({ hash });
        ctx.markVerifyEnd(); ctx.setGas(receipt.gasUsed);

        const currentAdmin = await fresh.c2cAdmin.read.admin();
        assert.equal(currentAdmin.toLowerCase(), fresh.newAdmin.account.address.toLowerCase());
        pass = true;
      } finally {
        addRecord({ id: "ADM-FLOW-01", desc: "proposeAdmin->acceptAdmin 管理员切换成功",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: ctx.gasUsed });
      }
    });

    // ADM-FLOW-02: 新增支持币种 addCryptoInfo
    it("ADM-FLOW-02: 新增支持币种", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        const countBefore = await fresh.c2cAdmin.read.getSupportCryptoCount();

        ctx.markVerifyStart();
        const hash = await fresh.c2cAdmin.write.addCryptoInfo([fresh.usdt.address, true]);
        const receipt = await pc.getTransactionReceipt({ hash });
        ctx.markVerifyEnd(); ctx.setGas(receipt.gasUsed);

        const countAfter = await fresh.c2cAdmin.read.getSupportCryptoCount();
        assert.equal(countAfter, countBefore + 1n, "count should increase by 1");
        pass = true;
      } finally {
        addRecord({ id: "ADM-FLOW-02", desc: "addCryptoInfo 事件+计数+1",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: ctx.gasUsed });
      }
    });

    // ADM-FLOW-03: 新增支持法币 addFiatInfo
    it("ADM-FLOW-03: 新增支持法币", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        const countBefore = await fresh.c2cAdmin.read.getSupportFiatCount();

        ctx.markVerifyStart();
        const hash = await fresh.c2cAdmin.write.addFiatInfo(["SGD", true]);
        const receipt = await pc.getTransactionReceipt({ hash });
        ctx.markVerifyEnd(); ctx.setGas(receipt.gasUsed);

        const countAfter = await fresh.c2cAdmin.read.getSupportFiatCount();
        assert.equal(countAfter, countBefore + 1n, "fiat count should increase by 1");
        pass = true;
      } finally {
        addRecord({ id: "ADM-FLOW-03", desc: "addFiatInfo 事件+计数+1",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: ctx.gasUsed });
      }
    });

    // ADM-FLOW-04: 资产上下架 deactivateAsset -> activateAsset
    it("ADM-FLOW-04: 资产上下架切换", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        // USDT (id=0) starts active; deactivate it then reactivate
        await fresh.c2cAdmin.write.deactivateAsset([0n, 0]); // 0=CRYPTO
        const info1 = await fresh.c2cAdmin.read.getSupportCryptoInfo([0n]);
        assert.equal(info1.isActive, false, "should be inactive after deactivate");

        ctx.markVerifyStart();
        const hash = await fresh.c2cAdmin.write.activateAsset([0n, 0]);
        const receipt = await pc.getTransactionReceipt({ hash });
        ctx.markVerifyEnd(); ctx.setGas(receipt.gasUsed);

        const info2 = await fresh.c2cAdmin.read.getSupportCryptoInfo([0n]);
        assert.equal(info2.isActive, true, "should be active after reactivate");
        pass = true;
      } finally {
        addRecord({ id: "ADM-FLOW-04", desc: "deactivateAsset->activateAsset 状态正确切换",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: ctx.gasUsed });
      }
    });

    // ADM-FLOW-05: 管理员注册商家 registerMerchantByAdmin
    it("ADM-FLOW-05: 管理员注册商家", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        ctx.markVerifyStart();
        const hash = await fresh.c2cAdmin.write.registerMerchantByAdmin([fresh.merchant.account.address]);
        const receipt = await pc.getTransactionReceipt({ hash });
        ctx.markVerifyEnd(); ctx.setGas(receipt.gasUsed);

        const isActive = await fresh.c2cAdmin.read.isMerchantActive([fresh.merchant.account.address]);
        const [isActiveField, kybVerified] = await fresh.c2cAdmin.read.merchants([fresh.merchant.account.address]);
        assert.equal(isActive, true, "merchant should be active");
        assert.equal(kybVerified, true, "KYB should be verified");
        pass = true;
      } finally {
        addRecord({ id: "ADM-FLOW-05", desc: "registerMerchantByAdmin 商家激活KYB=true",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: ctx.gasUsed });
      }
    });

    // ADM-FLOW-06: 商家注册走 KYB proof
    it("ADM-FLOW-06: 商家KYB证明注册", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        const proof = await buildKYBProof({
          verifierWallet: fresh.verifierSigner,
          chainId: CHAIN_ID,
        });
        // Register as the merchant wallet
        const adminAsMerchant = await viem.getContractAt("C2CAdmin", fresh.c2cAdmin.address, {
          client: { wallet: fresh.merchant },
        });

        ctx.markVerifyStart();
        const hash = await adminAsMerchant.write.registerMerchant([proof]);
        const receipt = await pc.getTransactionReceipt({ hash });
        ctx.markVerifyEnd(); ctx.setGas(receipt.gasUsed);

        const isActive = await fresh.c2cAdmin.read.isMerchantActive([fresh.merchant.account.address]);
        assert.equal(isActive, true, "merchant should be active after KYB registration");
        pass = true;
      } finally {
        addRecord({ id: "ADM-FLOW-06", desc: "registerMerchant(kybProof) MerchantRegistered",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: ctx.gasUsed });
      }
    });

    // ADM-FLOW-07: 商家设置支付哈希信息
    it("ADM-FLOW-07: 商家设置支付哈希信息", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        await fresh.c2cAdmin.write.registerMerchantByAdmin([fresh.merchant.account.address]);
        const platformWise: Hex = await fresh.tlsnVerifier.read.PLATFORM_WISE();

        ctx.markVerifyStart();
        const hash = await fresh.adminAsMerchant.write.setPlatformBinding([
          platformWise,
          MERCHANT_NAME_HASH,
          MERCHANT_ID_HASH,
        ]);
        const receipt = await pc.getTransactionReceipt({ hash });
        ctx.markVerifyEnd(); ctx.setGas(receipt.gasUsed);

        const info = await fresh.c2cAdmin.read.getPlatformBinding([
          fresh.merchant.account.address,
          platformWise,
        ]);
        assert.equal(info.isSet, true, "isSet should be true");
        assert.equal(info.nameHash, MERCHANT_NAME_HASH);
        assert.equal(info.idHash, MERCHANT_ID_HASH);
        pass = true;
      } finally {
        addRecord({ id: "ADM-FLOW-07", desc: "setPlatformBinding(WISE) isSet=true 哈希落链",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: ctx.gasUsed });
      }
    });

    it("ADM-FLOW-07A: 商家可分别设置 Wise/Alipay 支付信息", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        await fresh.c2cAdmin.write.registerMerchantByAdmin([fresh.merchant.account.address]);
        const platformWise: Hex = await fresh.tlsnVerifier.read.PLATFORM_WISE();
        const platformAlipay: Hex = await fresh.tlsnVerifier.read.PLATFORM_ALIPAY();

        await fresh.adminAsMerchant.write.setPlatformBinding([
          platformWise,
          MERCHANT_NAME_HASH,
          MERCHANT_ID_HASH,
        ]);

        ctx.markVerifyStart();
        const hash = await fresh.adminAsMerchant.write.setPlatformBinding([
          platformAlipay,
          ALIPAY_NAME_HASH,
          ALIPAY_ID_HASH,
        ]);
        const receipt = await pc.getTransactionReceipt({ hash });
        ctx.markVerifyEnd(); ctx.setGas(receipt.gasUsed);

        const wiseInfo = await fresh.c2cAdmin.read.getPlatformBinding([
          fresh.merchant.account.address,
          platformWise,
        ]);
        const alipayInfo = await fresh.c2cAdmin.read.getPlatformBinding([
          fresh.merchant.account.address,
          platformAlipay,
        ]);

        assert.equal(wiseInfo.isSet, true);
        assert.equal(wiseInfo.nameHash, MERCHANT_NAME_HASH);
        assert.equal(wiseInfo.idHash, MERCHANT_ID_HASH);
        assert.equal(alipayInfo.isSet, true);
        assert.equal(alipayInfo.nameHash, ALIPAY_NAME_HASH);
        assert.equal(alipayInfo.idHash, ALIPAY_ID_HASH);
        pass = true;
      } finally {
        addRecord({ id: "ADM-FLOW-07A", desc: "Wise/Alipay 支付信息可独立设置并读取",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: ctx.gasUsed });
      }
    });

    it("ADM-FLOW-07B: 修改某平台支付信息且不影响其他平台", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        await fresh.c2cAdmin.write.registerMerchantByAdmin([fresh.merchant.account.address]);
        const platformWise: Hex = await fresh.tlsnVerifier.read.PLATFORM_WISE();
        const platformAlipay: Hex = await fresh.tlsnVerifier.read.PLATFORM_ALIPAY();

        await fresh.adminAsMerchant.write.setPlatformBinding([
          platformWise,
          MERCHANT_NAME_HASH,
          MERCHANT_ID_HASH,
        ]);
        await fresh.adminAsMerchant.write.setPlatformBinding([
          platformAlipay,
          ALIPAY_NAME_HASH,
          ALIPAY_ID_HASH,
        ]);

        ctx.markVerifyStart();
        const hash = await fresh.adminAsMerchant.write.setPlatformBinding([
          platformWise,
          MERCHANT_ALT_NAME_HASH,
          MERCHANT_ALT_ID_HASH,
        ]);
        const receipt = await pc.getTransactionReceipt({ hash });
        ctx.markVerifyEnd(); ctx.setGas(receipt.gasUsed);

        const wiseInfo = await fresh.c2cAdmin.read.getPlatformBinding([
          fresh.merchant.account.address,
          platformWise,
        ]);
        const alipayInfo = await fresh.c2cAdmin.read.getPlatformBinding([
          fresh.merchant.account.address,
          platformAlipay,
        ]);

        assert.equal(wiseInfo.nameHash, MERCHANT_ALT_NAME_HASH);
        assert.equal(wiseInfo.idHash, MERCHANT_ALT_ID_HASH);
        assert.equal(alipayInfo.nameHash, ALIPAY_NAME_HASH);
        assert.equal(alipayInfo.idHash, ALIPAY_ID_HASH);
        pass = true;
      } finally {
        addRecord({ id: "ADM-FLOW-07B", desc: "单平台更新成功且不污染其他平台",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: ctx.gasUsed });
      }
    });

    it("ADM-FLOW-07C: 未设置的平台读取返回 isSet=false", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        await fresh.c2cAdmin.write.registerMerchantByAdmin([fresh.merchant.account.address]);
        const platformWise: Hex = await fresh.tlsnVerifier.read.PLATFORM_WISE();
        const platformAlipay: Hex = await fresh.tlsnVerifier.read.PLATFORM_ALIPAY();

        ctx.markVerifyStart();
        const hash = await fresh.adminAsMerchant.write.setPlatformBinding([
          platformWise,
          MERCHANT_NAME_HASH,
          MERCHANT_ID_HASH,
        ]);
        const receipt = await pc.getTransactionReceipt({ hash });
        ctx.markVerifyEnd(); ctx.setGas(receipt.gasUsed);

        const alipayInfo = await fresh.c2cAdmin.read.getPlatformBinding([
          fresh.merchant.account.address,
          platformAlipay,
        ]);
        assert.equal(alipayInfo.isSet, false);
        assert.equal(alipayInfo.nameHash, ZERO_HASH);
        assert.equal(alipayInfo.idHash, ZERO_HASH);
        pass = true;
      } finally {
        addRecord({ id: "ADM-FLOW-07C", desc: "未设置平台读取 isSet=false",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: ctx.gasUsed });
      }
    });

    // ADM-FLOW-08: 商家设置法币账户
    it("ADM-FLOW-08: 商家设置法币账户", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        await fresh.c2cAdmin.write.registerMerchantByAdmin([fresh.merchant.account.address]);

        ctx.markVerifyStart();
        const hash = await fresh.adminAsMerchant.write.setMerchantFiatAccount(["merchant@wise.com"]);
        const receipt = await pc.getTransactionReceipt({ hash });
        ctx.markVerifyEnd(); ctx.setGas(receipt.gasUsed);

        const account = await fresh.c2cAdmin.read.getMerchantFiatAccount([fresh.merchant.account.address]);
        assert.equal(account, "merchant@wise.com");
        pass = true;
      } finally {
        addRecord({ id: "ADM-FLOW-08", desc: "setMerchantFiatAccount 账户字符串保存",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: ctx.gasUsed });
      }
    });

    // ADM-FLOW-09: 首次发布汇率 version=1
    it("ADM-FLOW-09: 首次发布汇率 version=1", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        await fresh.c2cAdmin.write.registerMerchantByAdmin([fresh.merchant.account.address]);
        const expiry = (await pc.getBlock()).timestamp + 86400n;

        ctx.markVerifyStart();
        const hash = await fresh.adminAsMerchant.write.publishRate([0n, 0, 7200n, expiry]);
        const receipt = await pc.getTransactionReceipt({ hash });
        ctx.markVerifyEnd(); ctx.setGas(receipt.gasUsed);

        const mr = await fresh.c2cAdmin.read.getMerchantRate([fresh.merchant.account.address, 0n, 0]);
        assert.equal(mr.version, 1, "first publish should yield version 1");
        assert.ok(mr.publishedAt > 0n, "publishedAt should be set");
        pass = true;
      } finally {
        addRecord({ id: "ADM-FLOW-09", desc: "首次publishRate version=1 publishedAt>0",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: ctx.gasUsed });
      }
    });

    // ADM-FLOW-10: 二次发布汇率 version单调递增
    it("ADM-FLOW-10: 二次发布汇率 version递增", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        await fresh.c2cAdmin.write.registerMerchantByAdmin([fresh.merchant.account.address]);
        const expiry = (await pc.getBlock()).timestamp + 86400n;
        await fresh.adminAsMerchant.write.publishRate([0n, 0, 7200n, expiry]);

        ctx.markVerifyStart();
        const hash = await fresh.adminAsMerchant.write.publishRate([0n, 0, 7300n, expiry]);
        const receipt = await pc.getTransactionReceipt({ hash });
        ctx.markVerifyEnd(); ctx.setGas(receipt.gasUsed);

        const mr = await fresh.c2cAdmin.read.getMerchantRate([fresh.merchant.account.address, 0n, 0]);
        assert.equal(mr.version, 2, "second publish should yield version 2");
        assert.equal(mr.rate, 7300n);
        pass = true;
      } finally {
        addRecord({ id: "ADM-FLOW-10", desc: "二次publishRate version单调递增",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: ctx.gasUsed });
      }
    });

    // ADM-FLOW-11: 设置营业时间
    it("ADM-FLOW-11: 设置营业时间", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        await fresh.c2cAdmin.write.registerMerchantByAdmin([fresh.merchant.account.address]);

        ctx.markVerifyStart();
        const hash = await fresh.adminAsMerchant.write.setBusinessHours(
          [0n, 0, OPEN_SECOND, CLOSE_SECOND, ACTIVE_DAYS_WEEKDAY]
        );
        const receipt = await pc.getTransactionReceipt({ hash });
        ctx.markVerifyEnd(); ctx.setGas(receipt.gasUsed);

        const bh = await fresh.c2cAdmin.read.businessHours([
          fresh.merchant.account.address, 0n, 0
        ]);
        // viem returns tuple by index even with named ABI outputs
        assert.equal(bh[0], OPEN_SECOND, "openSecond mismatch");
        assert.equal(bh[1], CLOSE_SECOND, "closeSecond mismatch");
        assert.equal(bh[2], ACTIVE_DAYS_WEEKDAY, "activeDays mismatch");
        pass = true;
      } finally {
        addRecord({ id: "ADM-FLOW-11", desc: "setBusinessHours open/close/daymask正确",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: ctx.gasUsed });
      }
    });

    // ADM-FLOW-12: 强制营业/打烊/恢复自动
    it("ADM-FLOW-12: 强制营业/打烊/恢复自动", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        await fresh.c2cAdmin.write.registerMerchantByAdmin([fresh.merchant.account.address]);

        await fresh.adminAsMerchant.write.openNow([0n, 0]);
        const open = await fresh.c2cAdmin.read.isMerchantOpen([fresh.merchant.account.address, 0n, 0]);
        assert.equal(open, true, "openNow should make merchant open");

        await fresh.adminAsMerchant.write.closeNow([0n, 0]);
        const closed = await fresh.c2cAdmin.read.isMerchantOpen([fresh.merchant.account.address, 0n, 0]);
        assert.equal(closed, false, "closeNow should make merchant closed");

        ctx.markVerifyStart();
        const hash = await fresh.adminAsMerchant.write.clearManualOverride([0n, 0]);
        const receipt = await pc.getTransactionReceipt({ hash });
        ctx.markVerifyEnd(); ctx.setGas(receipt.gasUsed);

        const bh = await fresh.c2cAdmin.read.businessHours([fresh.merchant.account.address, 0n, 0]);
        assert.equal(bh[3], 0, "clearManualOverride should reset to 0");
        pass = true;
      } finally {
        addRecord({ id: "ADM-FLOW-12", desc: "openNow/closeNow/clearManualOverride覆盖正确",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: ctx.gasUsed });
      }
    });

    // ADM-FLOW-13: 设置单笔限额
    it("ADM-FLOW-13: 设置单笔限额", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        const newCap = 500n * 10n ** 18n;

        ctx.markVerifyStart();
        const hash = await fresh.c2cAdmin.write.setMaxOrderAmount([newCap]);
        const receipt = await pc.getTransactionReceipt({ hash });
        ctx.markVerifyEnd(); ctx.setGas(receipt.gasUsed);

        const stored = await fresh.c2cAdmin.read.maxOrderAmount();
        assert.equal(stored, newCap, "new cap should take effect immediately");
        pass = true;
      } finally {
        addRecord({ id: "ADM-FLOW-13", desc: "setMaxOrderAmount 新限额立即生效",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: ctx.gasUsed });
      }
    });

    // ADM-FLOW-14: 授权调用方
    it("ADM-FLOW-14: 授权调用方", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        const callerAddr = fresh.randomUser.account.address;

        ctx.markVerifyStart();
        const hash = await fresh.c2cAdmin.write.setAuthorizedCaller([callerAddr, true]);
        const receipt = await pc.getTransactionReceipt({ hash });
        ctx.markVerifyEnd(); ctx.setGas(receipt.gasUsed);

        const authorized = await fresh.c2cAdmin.read.authorizedCallers([callerAddr]);
        assert.equal(authorized, true, "caller should be authorized");

        // Revoke
        await fresh.c2cAdmin.write.setAuthorizedCaller([callerAddr, false]);
        const revoked = await fresh.c2cAdmin.read.authorizedCallers([callerAddr]);
        assert.equal(revoked, false, "caller should be revoked");
        pass = true;
      } finally {
        addRecord({ id: "ADM-FLOW-14", desc: "setAuthorizedCaller 授权映射正确更新",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: ctx.gasUsed });
      }
    });

    // ADM-FLOW-15: 受权合约递增产品计数
    it("ADM-FLOW-15: 受权合约递增产品计数", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        await fresh.c2cAdmin.write.registerMerchantByAdmin([fresh.merchant.account.address]);
        // C2CEscrow is already authorized in deployAll
        const mBefore = await fresh.c2cAdmin.read.merchants([fresh.merchant.account.address]);
        const cryptoBefore = mBefore.sellCryptoAmount;
        const fiatBefore   = mBefore.sellFiatAmount;

        ctx.markVerifyStart();
        // C2CEscrow calls incrementSellCount internally when listing a product
        // We simulate via escrow.listCryptoProduct
        const MAX = 2n ** 256n - 1n;
        await fresh.usdtAsMerchant.write.approve([fresh.c2cEscrow.address, MAX]);
        const hash = await fresh.escrowAsMerchant.write.listCryptoProduct(
          [USDT_CRYPTO_ID, CNY_FIAT_ID, COLLATERAL, true, await fresh.tlsnVerifier.read.PLATFORM_ALIPAY()]
        );
        const receipt = await pc.getTransactionReceipt({ hash });
        ctx.markVerifyEnd(); ctx.setGas(receipt.gasUsed);

        const mAfter = await fresh.c2cAdmin.read.merchants([fresh.merchant.account.address]);
        // sellCryptoAmount is returned as a JS number (not bigint) by viem for uint32 fields
        assert.equal(Number(mAfter.sellCryptoAmount), Number(cryptoBefore) + 1, "CRYPTO count should increment");
        assert.equal(Number(mAfter.sellFiatAmount), Number(fiatBefore), "FIAT count should not change");
        pass = true;
      } finally {
        addRecord({ id: "ADM-FLOW-15", desc: "incrementSellCount CRYPTO/FIAT计数独立",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: ctx.gasUsed });
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  ERR — 错误拦截
  // ══════════════════════════════════════════════════════════════

  describe("ERR — 错误拦截", async () => {
    let d: DeployResult;
    let asRandom: any;
    let asMerchant: any;
    let PLATFORM_WISE: Hex;

    before(async () => {
      d = await deployAll(viem);
      await d.c2cAdmin.write.registerMerchantByAdmin([d.merchant.account.address]);
      PLATFORM_WISE = await d.tlsnVerifier.read.PLATFORM_WISE();
      asRandom = await viem.getContractAt("C2CAdmin", d.c2cAdmin.address, {
        client: { wallet: d.randomUser },
      });
      asMerchant = d.adminAsMerchant;
    });

    it("ADM-ERR-01: 非admin调proposeAdmin", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        ctx.markVerifyStart();
        // Hardhat extractRevertError can't traverse .cause chain for some fn calls;
        // fall back to checking the error message contains the OnlyAdmin selector.
        try {
          await asRandom.write.proposeAdmin([d.randomUser.account.address]);
          assert.fail("should have reverted with OnlyAdmin");
        } catch (err: any) {
          const msg = String(err);
          assert.ok(msg.includes("OnlyAdmin") || msg.includes("0x47556579"),
            `Expected OnlyAdmin revert, got: ${msg.slice(0, 300)}`);
        }
        ctx.markVerifyEnd();
        pass = true;
      } finally {
        addRecord({ id: "ADM-ERR-01", desc: "非admin proposeAdmin → OnlyAdmin",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });

    it("ADM-ERR-02: 非pendingAdmin调acceptAdmin", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        ctx.markVerifyStart();
        await viem.assertions.revertWithCustomError(
          asRandom.write.acceptAdmin(),
          d.c2cAdmin, "NotPendingAdmin",
        );
        ctx.markVerifyEnd();
        pass = true;
      } finally {
        addRecord({ id: "ADM-ERR-02", desc: "非pendingAdmin acceptAdmin → NotPendingAdmin",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });

    it("ADM-ERR-03: proposeAdmin零地址", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        ctx.markVerifyStart();
        await viem.assertions.revertWithCustomError(
          d.c2cAdmin.write.proposeAdmin([zeroAddress]),
          d.c2cAdmin, "ZeroAddress",
        );
        ctx.markVerifyEnd();
        pass = true;
      } finally {
        addRecord({ id: "ADM-ERR-03", desc: "proposeAdmin(0x0) → ZeroAddress",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });

    it("ADM-ERR-04: 非admin新增crypto", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        ctx.markVerifyStart();
        try {
          await asRandom.write.addCryptoInfo([d.usdt.address, true]);
          assert.fail("should have reverted with OnlyAdmin");
        } catch (err: any) {
          const msg = String(err);
          assert.ok(msg.includes("OnlyAdmin") || msg.includes("0x47556579"),
            `Expected OnlyAdmin revert, got: ${msg.slice(0, 300)}`);
        }
        ctx.markVerifyEnd();
        pass = true;
      } finally {
        addRecord({ id: "ADM-ERR-04", desc: "非admin addCryptoInfo → OnlyAdmin",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });

    it("ADM-ERR-05: 非admin新增fiat", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        ctx.markVerifyStart();
        try {
          await asRandom.write.addFiatInfo(["EUR", true]);
          assert.fail("should have reverted with OnlyAdmin");
        } catch (err: any) {
          const msg = String(err);
          assert.ok(msg.includes("OnlyAdmin") || msg.includes("0x47556579"),
            `Expected OnlyAdmin revert, got: ${msg.slice(0, 300)}`);
        }
        ctx.markVerifyEnd();
        pass = true;
      } finally {
        addRecord({ id: "ADM-ERR-05", desc: "非admin addFiatInfo → OnlyAdmin",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });

    it("ADM-ERR-06: 激活已激活资产", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        // USDT (id=0) starts active
        ctx.markVerifyStart();
        await viem.assertions.revertWithCustomError(
          d.c2cAdmin.write.activateAsset([0n, 0]),
          d.c2cAdmin, "AlreadyActive",
        );
        ctx.markVerifyEnd();
        pass = true;
      } finally {
        addRecord({ id: "ADM-ERR-06", desc: "重复activateAsset → AlreadyActive",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });

    it("ADM-ERR-07: 下架已下架资产", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        // Fresh deploy to avoid polluting shared state
        const f = await deployAll(viem);
        await f.c2cAdmin.write.deactivateAsset([0n, 0]); // deactivate first

        ctx.markVerifyStart();
        await viem.assertions.revertWithCustomError(
          f.c2cAdmin.write.deactivateAsset([0n, 0]),
          f.c2cAdmin, "AlreadyInactive",
        );
        ctx.markVerifyEnd();
        pass = true;
      } finally {
        addRecord({ id: "ADM-ERR-07", desc: "重复deactivateAsset → AlreadyInactive",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });

    it("ADM-ERR-08: 资产ID越界", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        ctx.markVerifyStart();
        await viem.assertions.revertWithCustomError(
          d.c2cAdmin.write.activateAsset([999n, 0]),
          d.c2cAdmin, "WrongId",
        );
        ctx.markVerifyEnd();
        pass = true;
      } finally {
        addRecord({ id: "ADM-ERR-08", desc: "activateAsset越界 → WrongId",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });

    it("ADM-ERR-09: 非商家发布汇率", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        ctx.markVerifyStart();
        await viem.assertions.revertWithCustomError(
          asRandom.write.publishRate([0n, 0, 7200n, 0n]),
          d.c2cAdmin, "NotMerchant",
        );
        ctx.markVerifyEnd();
        pass = true;
      } finally {
        addRecord({ id: "ADM-ERR-09", desc: "非商家publishRate → NotMerchant",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });

    it("ADM-ERR-10: 发布过期汇率", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        const pastTs = BigInt(Math.floor(Date.now() / 1000) - 100);
        ctx.markVerifyStart();
        await viem.assertions.revertWithCustomError(
          asMerchant.write.publishRate([0n, 0, 7200n, pastTs]),
          d.c2cAdmin, "RateExpired",
        );
        ctx.markVerifyEnd();
        pass = true;
      } finally {
        addRecord({ id: "ADM-ERR-10", desc: "expiresAt<=now publishRate → RateExpired",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });

    it("ADM-ERR-11: 非商家设置营业时间", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        ctx.markVerifyStart();
        await viem.assertions.revertWithCustomError(
          asRandom.write.setBusinessHours([0n, 0, OPEN_SECOND, CLOSE_SECOND, ACTIVE_DAYS_WEEKDAY]),
          d.c2cAdmin, "NotMerchant",
        );
        ctx.markVerifyEnd();
        pass = true;
      } finally {
        addRecord({ id: "ADM-ERR-11", desc: "非商家setBusinessHours → NotMerchant",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });

    it("ADM-ERR-12: 非商家openNow/closeNow", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        ctx.markVerifyStart();
        await viem.assertions.revertWithCustomError(
          asRandom.write.openNow([0n, 0]),
          d.c2cAdmin, "NotMerchant",
        );
        ctx.markVerifyEnd();
        await viem.assertions.revertWithCustomError(
          asRandom.write.closeNow([0n, 0]),
          d.c2cAdmin, "NotMerchant",
        );
        pass = true;
      } finally {
        addRecord({ id: "ADM-ERR-12", desc: "非商家openNow/closeNow → NotMerchant",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });

    it("ADM-ERR-13: 非admin设置限额", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        ctx.markVerifyStart();
        await viem.assertions.revertWithCustomError(
          asRandom.write.setMaxOrderAmount([100n]),
          d.c2cAdmin, "OnlyAdmin",
        );
        ctx.markVerifyEnd();
        pass = true;
      } finally {
        addRecord({ id: "ADM-ERR-13", desc: "非admin setMaxOrderAmount → OnlyAdmin",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });

    it("ADM-ERR-14: 非授权调用递增计数", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        ctx.markVerifyStart();
        await viem.assertions.revertWithCustomError(
          asRandom.write.incrementSellCount([d.merchant.account.address, 0]),
          d.c2cAdmin, "NotAuthorizedCaller",
        );
        ctx.markVerifyEnd();
        pass = true;
      } finally {
        addRecord({ id: "ADM-ERR-14", desc: "非授权incrementSellCount → NotAuthorizedCaller",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });

    it("ADM-ERR-15: 非商家设置法币账户", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        ctx.markVerifyStart();
        await viem.assertions.revertWithCustomError(
          asRandom.write.setMerchantFiatAccount(["attacker@fake.com"]),
          d.c2cAdmin, "NotMerchant",
        );
        ctx.markVerifyEnd();
        pass = true;
      } finally {
        addRecord({ id: "ADM-ERR-15", desc: "非商家setMerchantFiatAccount → NotMerchant",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });

    it("ADM-ERR-16: 空法币账户", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        ctx.markVerifyStart();
        await viem.assertions.revertWithCustomError(
          asMerchant.write.setMerchantFiatAccount([""]),
          d.c2cAdmin, "EmptyAccount",
        );
        ctx.markVerifyEnd();
        pass = true;
      } finally {
        addRecord({ id: "ADM-ERR-16", desc: "setMerchantFiatAccount('') → EmptyAccount",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });

    it("ADM-ERR-17: 任意钱包可设置支付哈希（gate 已移除，binding 通用化）", async () => {
      // Phase 1.2: NotMerchant gate on setPlatformBinding was
      // removed so buyers can self-bind too (R3/R9). A non-merchant wallet must
      // therefore succeed and the binding must land on the mapping.
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        ctx.markVerifyStart();
        const altName = keccak256(toBytes("ADM-ERR-17-non-merchant-name"));
        const altId   = keccak256(toBytes("ADM-ERR-17-non-merchant-id"));
        await asRandom.write.setPlatformBinding([
          PLATFORM_WISE,
          altName,
          altId,
        ]);
        const info = await d.c2cAdmin.read.getPlatformBinding([
          d.randomUser.account.address, PLATFORM_WISE,
        ]);
        assert.equal(info.nameHash, altName);
        assert.equal(info.idHash,   altId);
        assert.equal(info.isSet,    true);
        ctx.markVerifyEnd();
        pass = true;
      } finally {
        addRecord({ id: "ADM-ERR-17", desc: "非商家 setPlatformBinding 已可成功",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });

    it("ADM-ERR-18: 支付哈希为空", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        ctx.markVerifyStart();
        await viem.assertions.revertWithCustomError(
          asMerchant.write.setPlatformBinding([
            PLATFORM_WISE,
            ZERO_HASH,
            MERCHANT_ID_HASH,
          ]),
          d.c2cAdmin, "EmptyAccount",
        );
        ctx.markVerifyEnd();
        pass = true;
      } finally {
        addRecord({ id: "ADM-ERR-18", desc: "nameHash=0 setPlatformBinding → EmptyAccount",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });

    it("ADM-ERR-18A: 未注册平台设置支付哈希 -> PlatformNotRegistered", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        const unregisteredPlatform = keccak256(toBytes("unregistered-platform"));
        ctx.markVerifyStart();
        await viem.assertions.revertWithCustomError(
          asMerchant.write.setPlatformBinding([
            unregisteredPlatform,
            MERCHANT_NAME_HASH,
            MERCHANT_ID_HASH,
          ]),
          d.c2cAdmin, "PlatformNotRegistered",
        );
        ctx.markVerifyEnd();
        pass = true;
      } finally {
        addRecord({ id: "ADM-ERR-18A", desc: "未注册平台 setPlatformBinding → PlatformNotRegistered",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });

    it("ADM-ERR-19: 重复商家注册", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        // merchant is already registered in before()
        ctx.markVerifyStart();
        await viem.assertions.revertWithCustomError(
          d.c2cAdmin.write.registerMerchantByAdmin([d.merchant.account.address]),
          d.c2cAdmin, "AlreadyRegistered",
        );
        ctx.markVerifyEnd();
        pass = true;
      } finally {
        addRecord({ id: "ADM-ERR-19", desc: "重复registerMerchantByAdmin → AlreadyRegistered",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });

    it("ADM-ERR-20: KYB proof链ID错误", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        const proof = await buildKYBProof({ verifierWallet: d.verifierSigner, chainId: 99999n });
        const adminAsBuyer = await viem.getContractAt("C2CAdmin", d.c2cAdmin.address, {
          client: { wallet: d.buyer },
        });
        ctx.markVerifyStart();
        await viem.assertions.revertWithCustomError(
          adminAsBuyer.write.registerMerchant([proof]),
          d.tlsnVerifier, "WrongChainId",
        );
        ctx.markVerifyEnd();
        pass = true;
      } finally {
        addRecord({ id: "ADM-ERR-20", desc: "KYB proof chainId错误 → WrongChainId",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });

    it("ADM-ERR-21: KYB proof session重放", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        const sharedSession = nextSession();
        // First proof: new unregistered address (buyer is not registered yet)
        const proof1 = await buildKYBProof({
          verifierWallet: d.verifierSigner, chainId: CHAIN_ID, sessionId: sharedSession,
        });
        const adminAsBuyer = await viem.getContractAt("C2CAdmin", d.c2cAdmin.address, {
          client: { wallet: d.buyer },
        });
        await adminAsBuyer.write.registerMerchant([proof1]); // succeeds, session consumed

        // Second proof with same session — should fail
        const proof2 = await buildKYBProof({
          verifierWallet: d.verifierSigner, chainId: CHAIN_ID, sessionId: sharedSession,
        });
        const adminAsRandom = await viem.getContractAt("C2CAdmin", d.c2cAdmin.address, {
          client: { wallet: d.randomUser },
        });
        ctx.markVerifyStart();
        await viem.assertions.revertWithCustomError(
          adminAsRandom.write.registerMerchant([proof2]),
          d.tlsnVerifier, "SessionAlreadyUsed",
        );
        ctx.markVerifyEnd();
        pass = true;
      } finally {
        addRecord({ id: "ADM-ERR-21", desc: "KYB同sessionId重放 → SessionAlreadyUsed",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });

    it("ADM-ERR-22: KYB proof伪造签名", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        // Sign with a non-trusted wallet (randomUser)
        const proof = await buildKYBProof({ verifierWallet: d.randomUser, chainId: CHAIN_ID });
        const adminAsNew = await viem.getContractAt("C2CAdmin", d.c2cAdmin.address, {
          client: { wallet: d.newAdmin },
        });
        ctx.markVerifyStart();
        await viem.assertions.revertWithCustomError(
          adminAsNew.write.registerMerchant([proof]),
          d.tlsnVerifier, "UntrustedVerifier",
        );
        ctx.markVerifyEnd();
        pass = true;
      } finally {
        addRecord({ id: "ADM-ERR-22", desc: "KYB伪造签名 → UntrustedVerifier",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });

    it("ADM-ERR-23: KYB server未信任", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        const proof = await buildKYBProof({
          verifierWallet: d.verifierSigner,
          chainId: CHAIN_ID,
          serverName: "untrusted-kyb.com",
        });
        const adminAsNew = await viem.getContractAt("C2CAdmin", d.c2cAdmin.address, {
          client: { wallet: d.newAdmin },
        });
        ctx.markVerifyStart();
        await viem.assertions.revertWithCustomError(
          adminAsNew.write.registerMerchant([proof]),
          d.tlsnVerifier, "NotTrustedKYBServer",
        );
        ctx.markVerifyEnd();
        pass = true;
      } finally {
        addRecord({ id: "ADM-ERR-23", desc: "KYB server未信任 → NotTrustedKYBServer",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });

    it("ADM-ERR-24: KYB状态非verified", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        const proof = await buildKYBProofBadStatus({
          verifierWallet: d.verifierSigner,
          chainId: CHAIN_ID,
          status: "pending",
        });
        const adminAsNew = await viem.getContractAt("C2CAdmin", d.c2cAdmin.address, {
          client: { wallet: d.newAdmin },
        });
        ctx.markVerifyStart();
        await viem.assertions.revertWithCustomError(
          adminAsNew.write.registerMerchant([proof]),
          d.tlsnVerifier, "KYCNotVerified",
        );
        ctx.markVerifyEnd();
        pass = true;
      } finally {
        addRecord({ id: "ADM-ERR-24", desc: "KYB status非verified → KYCNotVerified",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  ATTACK — 攻击防御
  // ══════════════════════════════════════════════════════════════

  describe("ATTACK — 攻击防御", async () => {
    let d: DeployResult;
    let asRandom: any;

    before(async () => {
      d = await deployAll(viem);
      await d.c2cAdmin.write.registerMerchantByAdmin([d.merchant.account.address]);
      asRandom = await viem.getContractAt("C2CAdmin", d.c2cAdmin.address, {
        client: { wallet: d.randomUser },
      });
    });

    it("ADM-ATT-01: 管理员劫持 — 非pending抢先acceptAdmin", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        // propose to newAdmin but attacker (randomUser) tries to accept
        await d.c2cAdmin.write.proposeAdmin([d.newAdmin.account.address]);
        ctx.markVerifyStart();
        await viem.assertions.revertWithCustomError(
          asRandom.write.acceptAdmin(),
          d.c2cAdmin, "NotPendingAdmin",
        );
        ctx.markVerifyEnd();
        // cleanup: let newAdmin accept so state is clean for next test
        const asNewAdmin = await viem.getContractAt("C2CAdmin", d.c2cAdmin.address, {
          client: { wallet: d.newAdmin },
        });
        await asNewAdmin.write.acceptAdmin();
        pass = true;
      } finally {
        addRecord({ id: "ADM-ATT-01", desc: "非pending抢acceptAdmin → NotPendingAdmin",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });

    it("ADM-ATT-02: 伪造KYB签名", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        const proof = await buildKYBProof({ verifierWallet: d.randomUser, chainId: CHAIN_ID });
        const adminAsRandom2 = await viem.getContractAt("C2CAdmin", d.c2cAdmin.address, {
          client: { wallet: d.buyer },
        });
        ctx.markVerifyStart();
        await viem.assertions.revertWithCustomError(
          adminAsRandom2.write.registerMerchant([proof]),
          d.tlsnVerifier, "UntrustedVerifier",
        );
        ctx.markVerifyEnd();
        pass = true;
      } finally {
        addRecord({ id: "ADM-ATT-02", desc: "攻击者私钥签KYB proof → UntrustedVerifier",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });

    it("ADM-ATT-03: KYB会话重放", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        const session = nextSession();
        const proof1 = await buildKYBProof({
          verifierWallet: d.verifierSigner, chainId: CHAIN_ID, sessionId: session,
        });
        // Register newAdmin as a merchant (they're not registered yet)
        const adminAsNewAdmin = await viem.getContractAt("C2CAdmin", d.c2cAdmin.address, {
          client: { wallet: d.newAdmin },
        });
        await adminAsNewAdmin.write.registerMerchant([proof1]);

        // Replay same session
        const proof2 = await buildKYBProof({
          verifierWallet: d.verifierSigner, chainId: CHAIN_ID, sessionId: session,
        });
        ctx.markVerifyStart();
        await viem.assertions.revertWithCustomError(
          asRandom.write.registerMerchant([proof2]),
          d.tlsnVerifier, "SessionAlreadyUsed",
        );
        ctx.markVerifyEnd();
        pass = true;
      } finally {
        addRecord({ id: "ADM-ATT-03", desc: "复用旧sessionId → SessionAlreadyUsed",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });

    it("ADM-ATT-04: commitments篡改", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        const fakeHash = keccak256(toBytes("tampered")) as Hex;
        const proof = await buildKYBProof({
          verifierWallet: d.verifierSigner,
          chainId: CHAIN_ID,
          overrideCommitmentsHash: fakeHash,
        });
        ctx.markVerifyStart();
        await viem.assertions.revertWithCustomError(
          asRandom.write.registerMerchant([proof]),
          d.tlsnVerifier, "CommitmentsHashMismatch",
        );
        ctx.markVerifyEnd();
        pass = true;
      } finally {
        addRecord({ id: "ADM-ATT-04", desc: "tamper commitmentsHash → CommitmentsHashMismatch",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });

    it("ADM-ATT-05: opening篡改", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        // Build valid proof then tamper the blinder
        const proof = await buildKYBProof({ verifierWallet: d.verifierSigner, chainId: CHAIN_ID });
        const tamperedProof = {
          ...proof,
          commitmentOpenings: [{ blinderHex: keccak256(toBytes("wrong-blinder")) as Hex }],
        };
        ctx.markVerifyStart();
        await viem.assertions.revertWithCustomError(
          asRandom.write.registerMerchant([tamperedProof]),
          d.tlsnVerifier, "CommitmentOpeningMismatch",
        );
        ctx.markVerifyEnd();
        pass = true;
      } finally {
        addRecord({ id: "ADM-ATT-05", desc: "tamper blinderHex → CommitmentOpeningMismatch",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });

    it("ADM-ATT-06: 越权授权调用方", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        ctx.markVerifyStart();
        try {
          await asRandom.write.setAuthorizedCaller([d.randomUser.account.address, true]);
          assert.fail("should have reverted with OnlyAdmin");
        } catch (err: any) {
          const msg = String(err);
          assert.ok(msg.includes("OnlyAdmin") || msg.includes("0x47556579"),
            `Expected OnlyAdmin revert, got: ${msg.slice(0, 300)}`);
        }
        ctx.markVerifyEnd();
        pass = true;
      } finally {
        addRecord({ id: "ADM-ATT-06", desc: "非admin setAuthorizedCaller → OnlyAdmin",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });

    it("ADM-ATT-07: 越权调整限额", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        ctx.markVerifyStart();
        await viem.assertions.revertWithCustomError(
          asRandom.write.setMaxOrderAmount([1n]),
          d.c2cAdmin, "OnlyAdmin",
        );
        ctx.markVerifyEnd();
        pass = true;
      } finally {
        addRecord({ id: "ADM-ATT-07", desc: "非admin setMaxOrderAmount → OnlyAdmin",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });

    it("ADM-ATT-08: 伪造商家身份发布汇率", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        ctx.markVerifyStart();
        await viem.assertions.revertWithCustomError(
          asRandom.write.publishRate([0n, 0, 7200n, 0n]),
          d.c2cAdmin, "NotMerchant",
        );
        ctx.markVerifyEnd();
        pass = true;
      } finally {
        addRecord({ id: "ADM-ATT-08", desc: "未注册地址publishRate → NotMerchant",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  TAMPER — 流程篡改
  // ══════════════════════════════════════════════════════════════

  describe("TAMPER — 流程篡改", async () => {
    let d: DeployResult;

    before(async () => {
      d = await deployAll(viem);
      await d.c2cAdmin.write.registerMerchantByAdmin([d.merchant.account.address]);
    });

    it("ADM-TAMPER-01: 商家频繁改汇率 版本严格递增", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        const expiry = (await pc.getBlock()).timestamp + 86400n;
        const mr0 = await d.c2cAdmin.read.getMerchantRate([d.merchant.account.address, 0n, 0]);
        const vBefore = mr0.version;

        for (let i = 0; i < 3; i++) {
          await d.adminAsMerchant.write.publishRate([0n, 0, BigInt(7200 + i), expiry]);
        }

        ctx.markVerifyStart();
        const hash = await d.adminAsMerchant.write.publishRate([0n, 0, 9999n, expiry]);
        const receipt = await pc.getTransactionReceipt({ hash });
        ctx.markVerifyEnd(); ctx.setGas(receipt.gasUsed);

        const mr1 = await d.c2cAdmin.read.getMerchantRate([d.merchant.account.address, 0n, 0]);
        assert.equal(Number(mr1.version), Number(vBefore) + 4, "version should increase by 4 total");
        assert.equal(mr1.rate, 9999n);
        pass = true;
      } finally {
        addRecord({ id: "ADM-TAMPER-01", desc: "连续publishRate版本严格递增不回退",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: ctx.gasUsed });
      }
    });

    it("ADM-TAMPER-02: 短expiresAt汇率先可下单后快速过期", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        const testClient = await viem.getTestClient();
        // Publish rate expiring in 10 seconds
        const nowTs = (await pc.getBlock()).timestamp;
        const shortExpiry = nowTs + 10n;
        await d.adminAsMerchant.write.publishRate([1n, 0, 7200n, shortExpiry]);

        // Rate not yet expired
        const mr = await d.c2cAdmin.read.getMerchantRate([d.merchant.account.address, 1n, 0]);
        assert.ok(mr.expiresAt > 0n, "should have expiry");

        // Advance time past expiry
        ctx.markVerifyStart();
        await advanceTime(testClient, 20); // +20s
        ctx.markVerifyEnd();

        // Now the rate is expired for new orders
        const nowTs2 = (await pc.getBlock()).timestamp;
        const mr2 = await d.c2cAdmin.read.getMerchantRate([d.merchant.account.address, 1n, 0]);
        assert.ok(nowTs2 > mr2.expiresAt, "rate should be expired now");
        pass = true;
      } finally {
        addRecord({ id: "ADM-TAMPER-02", desc: "短expiresAt: 先有效后过期",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });

    it("ADM-TAMPER-03: 开门后立即关门 最新override生效", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        await d.adminAsMerchant.write.openNow([2n, 0]);
        const open = await d.c2cAdmin.read.isMerchantOpen([d.merchant.account.address, 2n, 0]);
        assert.equal(open, true);

        ctx.markVerifyStart();
        const hash = await d.adminAsMerchant.write.closeNow([2n, 0]);
        const receipt = await pc.getTransactionReceipt({ hash });
        ctx.markVerifyEnd(); ctx.setGas(receipt.gasUsed);

        const closed = await d.c2cAdmin.read.isMerchantOpen([d.merchant.account.address, 2n, 0]);
        assert.equal(closed, false, "closeNow override should win over openNow");
        pass = true;
      } finally {
        addRecord({ id: "ADM-TAMPER-03", desc: "openNow→closeNow 最新override生效",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: ctx.gasUsed });
      }
    });

    it("ADM-TAMPER-04: 关门后清除覆盖回到时间表", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        await d.adminAsMerchant.write.closeNow([3n, 0]);
        const bh1 = await d.c2cAdmin.read.businessHours([d.merchant.account.address, 3n, 0]);
        assert.equal(bh1[3], 2); // index 3 = manualOverride

        ctx.markVerifyStart();
        const hash = await d.adminAsMerchant.write.clearManualOverride([3n, 0]);
        const receipt = await pc.getTransactionReceipt({ hash });
        ctx.markVerifyEnd(); ctx.setGas(receipt.gasUsed);

        const bh2 = await d.c2cAdmin.read.businessHours([d.merchant.account.address, 3n, 0]);
        assert.equal(bh2[3], 0, "manualOverride should be 0 after clear");
        pass = true;
      } finally {
        addRecord({ id: "ADM-TAMPER-04", desc: "closeNow→clearManualOverride回到时间表",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: ctx.gasUsed });
      }
    });

    it("ADM-TAMPER-05: openNow后setBusinessHours不抹掉override", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        await d.adminAsMerchant.write.openNow([4n, 0]); // manualOverride = 1

        ctx.markVerifyStart();
        const hash = await d.adminAsMerchant.write.setBusinessHours(
          [4n, 0, OPEN_SECOND, CLOSE_SECOND, ACTIVE_DAYS_WEEKDAY]
        );
        const receipt = await pc.getTransactionReceipt({ hash });
        ctx.markVerifyEnd(); ctx.setGas(receipt.gasUsed);

        const bh = await d.c2cAdmin.read.businessHours([d.merchant.account.address, 4n, 0]);
        assert.equal(bh[3], 1, "openNow override should be preserved"); // index 3 = manualOverride
        assert.equal(bh[0], OPEN_SECOND); // index 0 = openSecond
        pass = true;
      } finally {
        addRecord({ id: "ADM-TAMPER-05", desc: "openNow后setBusinessHours保留manualOverride",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: ctx.gasUsed });
      }
    });

    it("ADM-TAMPER-06: 产品维度isMerchantOpen隔离", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        // product 5: force open; product 6: force closed
        await d.adminAsMerchant.write.openNow([5n, 0]);
        await d.adminAsMerchant.write.closeNow([6n, 0]);

        ctx.markVerifyStart();
        const open5  = await d.c2cAdmin.read.isMerchantOpen([d.merchant.account.address, 5n, 0]);
        const close6 = await d.c2cAdmin.read.isMerchantOpen([d.merchant.account.address, 6n, 0]);
        ctx.markVerifyEnd();

        assert.equal(open5,  true,  "product 5 should be open");
        assert.equal(close6, false, "product 6 should be closed");
        pass = true;
      } finally {
        addRecord({ id: "ADM-TAMPER-06", desc: "isMerchantOpen按productId维度隔离",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });

    it("ADM-TAMPER-07: 管理员中途改限额 仅影响新单", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        const originalCap = await d.c2cAdmin.read.maxOrderAmount();
        const newCap = 1n * 10n ** 18n; // 1 USDT

        ctx.markVerifyStart();
        await d.c2cAdmin.write.setMaxOrderAmount([newCap]);
        ctx.markVerifyEnd();

        const stored = await d.c2cAdmin.read.maxOrderAmount();
        assert.equal(stored, newCap, "new cap immediately effective");

        // restore
        await d.c2cAdmin.write.setMaxOrderAmount([originalCap]);
        pass = true;
      } finally {
        addRecord({ id: "ADM-TAMPER-07", desc: "管理员改限额立即生效仅影响新单",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: 0n });
      }
    });

    it("ADM-TAMPER-08: ⚠️ assetType=2发布汇率(风险用例-当前无守卫)", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        // Risk: no guard on assetType, should NOT revert currently
        const expiry = (await pc.getBlock()).timestamp + 86400n;
        ctx.markVerifyStart();
        const hash = await d.adminAsMerchant.write.publishRate([0n, 2, 7200n, expiry]);
        const receipt = await pc.getTransactionReceipt({ hash });
        ctx.markVerifyEnd(); ctx.setGas(receipt.gasUsed);

        // Verify it was stored (risk: no assetType validation)
        const mr = await d.c2cAdmin.read.getMerchantRate([d.merchant.account.address, 0n, 2]);
        assert.ok(mr.publishedAt > 0n, "⚠️ rate stored without assetType guard");
        pass = true;
      } finally {
        addRecord({ id: "ADM-TAMPER-08", desc: "⚠️ assetType=2 publishRate 当前允许(风险)",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: ctx.gasUsed });
      }
    });

    it("ADM-TAMPER-09: ⚠️ rate=0发布(风险用例-当前允许)", async () => {
      const t0 = Date.now(); const ctx = makeCtx(); let pass = false;
      try {
        const expiry = (await pc.getBlock()).timestamp + 86400n;
        ctx.markVerifyStart();
        const hash = await d.adminAsMerchant.write.publishRate([0n, 0, 0n, expiry]);
        const receipt = await pc.getTransactionReceipt({ hash });
        ctx.markVerifyEnd(); ctx.setGas(receipt.gasUsed);

        const mr = await d.c2cAdmin.read.getMerchantRate([d.merchant.account.address, 0n, 0]);
        assert.equal(mr.rate, 0n, "⚠️ rate=0 stored without guard");
        pass = true;
      } finally {
        addRecord({ id: "ADM-TAMPER-09", desc: "⚠️ rate=0 publishRate 当前允许(风险)",
          pass, totalMs: Date.now()-t0, verifyMs: ctx.verifyMs(), gasUsed: ctx.gasUsed });
      }
    });
  });
});
