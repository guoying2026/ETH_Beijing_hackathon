/**
 * Deploy all C2C platform contracts and write addresses to packages/web/.env.local.
 *
 * Usage:
 *   # Terminal 1 — start local node (keep running)
 *   cd packages/contracts && npx hardhat node --network hardhatMainnet
 *
 *   # Terminal 2 — deploy
 *   cd packages/contracts && npm run deploy:web
 *
 * The script preserves all existing non-contract variables in .env.local and
 * only updates the NEXT_PUBLIC_* contract address lines.
 */

import { network } from "hardhat";
import { parseUnits, keccak256, toBytes, concat, type Hex } from "viem";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Binding DB seed helpers ────────────────────────────────────────────────
// These mirror packages/web/src/lib/payeeCrypto.ts + bindingRepo.ts. Cross-
// importing is awkward (web is a Next "use client" tree); inlining keeps this
// script self-contained while staying byte-equivalent to the API path.
function normalize(s: string): string {
    return s.trim().toLowerCase().normalize("NFC");
}
function randomSaltHex(): Hex {
    return ("0x" + randomBytes(32).toString("hex")) as Hex;
}
function computeCommit(plaintext: string, salt: Hex): Hex {
    return keccak256(concat([toBytes(normalize(plaintext)), toBytes(salt)]));
}
function normalizeWallet(addr: string): string {
    return addr.toLowerCase();
}

// ── Alipay masking (mirrors packages/web/src/lib/proofMask/alipay.ts) ───────
// Alipay's payment-detail response masks the payee identity. We store the FULL
// value for display but commit over the MASKED value, because that is what the
// proof reveals. Wise returns the full identity, so it commits over the full
// value (no masking helper needed).
function maskAlipayName(full: string): string {
    const s = full.trim();
    if (s.length === 0) return s;
    const firstSpace = s.indexOf(" ");
    return firstSpace > 0 ? "*" + s.slice(firstSpace) : "*" + s.slice(1);
}
function maskAlipayHandle(full: string): string {
    const s = full.trim();
    const at = s.indexOf("@");
    if (at >= 0) return s.slice(0, 3) + "***" + s.slice(at);
    if (s.length <= 6) return s;
    return s.slice(0, 3) + "*".repeat(s.length - 6) + s.slice(-3);
}

const webDir     = path.resolve(__dirname, "../../web");
const sqlitePath = path.resolve(webDir, "data/c2c.db");

// Load better-sqlite3 (it isn't a contracts dep — it ships transitively via
// packages/web. In npm workspaces it's typically hoisted to the workspace root,
// so let Node's normal resolution walk the parent node_modules chain.)
let DatabaseCtor: any | null = null;
let dbLoadError: unknown = null;
try {
    const require = createRequire(import.meta.url);
    DatabaseCtor = require("better-sqlite3");
} catch (err) {
    dbLoadError = err;
}

/**
 * Run `npx drizzle-kit migrate` in packages/web so the SQLite file is created
 * with all expected tables. Called when the script detects missing tables.
 * Synchronous (spawnSync) so the subsequent INSERTs see the schema.
 */
function applyDrizzleMigrations(): void {
    console.log("[deploy] running drizzle-kit migrate to bootstrap SQLite schema...");
    const isWin = process.platform === "win32";
    const result = spawnSync(
        isWin ? "npx.cmd" : "npx",
        ["drizzle-kit", "migrate"],
        { cwd: webDir, stdio: "inherit", env: process.env },
    );
    if (result.status !== 0) {
        throw new Error(`drizzle-kit migrate exited with code ${result.status}`);
    }
}

/**
 * Check whether `wallet_payment_binding` exists; if not, bootstrap via drizzle.
 * Idempotent — does nothing once tables exist.
 */
function ensureSchema(): void {
    if (!DatabaseCtor) {
        throw new Error(
            "better-sqlite3 not found — run `npm install` at the workspace root or in packages/web. " +
            "Underlying error: " + (dbLoadError instanceof Error ? dbLoadError.message : String(dbLoadError)),
        );
    }
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });

    let needsMigrate = false;
    if (!fs.existsSync(sqlitePath)) {
        needsMigrate = true;
    } else {
        const db = new DatabaseCtor(sqlitePath);
        try {
            const row = db
                .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wallet_payment_binding'")
                .get();
            if (!row) needsMigrate = true;
        } finally {
            db.close();
        }
    }
    if (needsMigrate) applyDrizzleMigrations();
}

/**
 * Pure helper — generate salt + commits the same way `/api/binding/register`
 * does. NOTHING is written to DB here. DB write happens only after the on-chain
 * setPlatformBinding tx is confirmed successful (see writeBindingToDb below).
 */
function newCommits(name: string, handle: string): {
    salt: Hex; nameCommit: Hex; idCommit: Hex;
} {
    const salt = randomSaltHex();
    return {
        salt,
        nameCommit: computeCommit(name, salt),
        idCommit:   computeCommit(handle, salt),
    };
}

// ── Generic DB helpers ─────────────────────────────────────────────────────

/** Open a DB connection, run `fn`, then close. */
function withDb<T>(fn: (db: any) => T): T {
    const db = new DatabaseCtor(sqlitePath);
    db.pragma("foreign_keys = ON");
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

/**
 * Phase 0 — wipe the SQLite file and its journal/WAL companions before each
 * deploy. `ensureSchema()` will recreate the schema via drizzle migrate on the
 * next access. User asked for this so dev runs always start from a known state.
 */
function clearSqliteDb(): void {
    for (const suffix of ["", "-journal", "-wal", "-shm"] as const) {
        const f = sqlitePath + suffix;
        if (fs.existsSync(f)) {
            fs.rmSync(f, { force: true });
            console.log(`[deploy] cleared ${path.basename(f)}`);
        }
    }
}

/** Insert or update a user_profile row. Idempotent. */
function upsertUserProfile(
    wallet: string,
    role: "buyer" | "merchant" | "both",
    db?: any,
): void {
    const exec = (d: any) => {
        const w = normalizeWallet(wallet);
        const ts = Math.floor(Date.now() / 1000);
        const existing = d
            .prepare("SELECT wallet_address FROM user_profile WHERE wallet_address = ?")
            .get(w);
        if (existing) {
            d.prepare(
                "UPDATE user_profile SET role = ?, updated_at = ? WHERE wallet_address = ?",
            ).run(role, ts, w);
        } else {
            d.prepare(
                "INSERT INTO user_profile (wallet_address, role, created_at, updated_at) VALUES (?, ?, ?, ?)",
            ).run(w, role, ts, ts);
        }
    };
    if (db) exec(db);
    else withDb(exec);
}

// ── Phase 1 — sync admin-managed assets after on-chain success ─────────────

/** Mirror `addCryptoInfo` into `support_crypto_assets`. */
function writeCryptoAssetToDb(opts: {
    cryptoId:     number;
    tokenSymbol:  string;
    tokenAddress: string;
    isActive:     boolean;
}): void {
    ensureSchema();
    withDb((db) => {
        const ts = Math.floor(Date.now() / 1000);
        db.prepare(
            "INSERT INTO support_crypto_assets " +
            "(crypto_id, token_symbol, token_address, is_active, edit_time, created_time) " +
            "VALUES (?, ?, ?, ?, ?, ?)",
        ).run(
            opts.cryptoId,
            opts.tokenSymbol,
            opts.tokenAddress,
            opts.isActive ? 1 : 0,
            ts, ts,
        );
    });
}

/** Mirror `addFiatInfo` into `support_fiat_assets`. */
function writeFiatAssetToDb(opts: {
    fiatId:   number;
    fiatName: string;
    isActive: boolean;
}): void {
    ensureSchema();
    withDb((db) => {
        const ts = Math.floor(Date.now() / 1000);
        db.prepare(
            "INSERT INTO support_fiat_assets " +
            "(fiat_id, fiat_name, is_active, edit_time, created_time) " +
            "VALUES (?, ?, ?, ?, ?)",
        ).run(opts.fiatId, opts.fiatName, opts.isActive ? 1 : 0, ts, ts);
    });
}

/**
 * Persist a merchant's binding row to SQLite. CALL ONLY AFTER the matching
 * setPlatformBinding tx is confirmed successful.
 */
function writeBindingToDb(opts: {
    wallet:     string;
    platformId: Hex;
    name:       string;
    handle:     string;
    salt:       Hex;
    nameCommit: Hex;
    idCommit:   Hex;
}): void {
    ensureSchema();
    withDb((db) => {
        const w = normalizeWallet(opts.wallet);
        const ts = Math.floor(Date.now() / 1000);
        db.transaction(() => {
            upsertUserProfile(w, "merchant", db);

            db.prepare(
                "UPDATE wallet_payment_binding SET status = 'superseded', superseded_at = ? " +
                "WHERE wallet_address = ? AND platform_id = ? AND status = 'active'",
            ).run(ts, w, opts.platformId);

            db.prepare(
                "INSERT INTO wallet_payment_binding " +
                "(wallet_address, platform_id, plaintext_name, plaintext_handle, salt, name_commit, id_commit, status, created_at) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)",
            ).run(
                w,
                opts.platformId,
                // Store the FULL identity for display (trim only) — the masked
                // commit pre-image is reflected in nameCommit/idCommit only.
                opts.name.trim(),
                opts.handle.trim(),
                opts.salt,
                opts.nameCommit,
                opts.idCommit,
                ts,
            );
        })();
    });
}

// ── Phase 2 — seed dev-only tables that the legacy /api/order/* routes need ──

/**
 * Seed `payment_method`, `userdata`, `fiat_bank_accounts`, `order_contract`,
 * `order_index` so `/orders/[orderId]` detail page can render the 4 demo
 * orders. These tables have no on-chain analog — they're carry-over MySQL
 * dictionaries the legacy detail-page routes still query.
 *
 * Call ONCE near the end of deploy, after all chain operations have committed.
 */
function seedDevTables(opts: { merchant: string }): void {
    ensureSchema();
    const m = normalizeWallet(opts.merchant);
    const ts = Math.floor(Date.now() / 1000);

    withDb((db) => {
        db.transaction(() => {
            // payment_method dictionary
            db.prepare(
                "INSERT INTO payment_method (method_id, method_name, icon_url, url) VALUES (?, ?, NULL, NULL)",
            ).run(1, "Wise");
            db.prepare(
                "INSERT INTO payment_method (method_id, method_name, icon_url, url) VALUES (?, ?, NULL, NULL)",
            ).run(2, "Alipay");

            // userdata — merchant stats (default values, dev-only)
            db.prepare(
                "INSERT INTO userdata " +
                "(wallet_address, verified, close_rate, trading_volume, close_rate_binance, trading_volume_binance, " +
                "user_level, minimum_amount, maximum_amount, create_time, update_time) " +
                "VALUES (?, 1, 0, 0, 0, 0, 0, 50, 100, ?, ?)",
            ).run(m, ts, ts);

            // fiat_bank_accounts — one row per (merchant, currency, method) combo.
            // account_number_hash is a 32-byte BLOB; we use placeholder bytes since
            // the merchant's real account info is dev-side fiction.
            const wiseHash   = Buffer.from("a".repeat(64), "hex");
            const alipayHash = Buffer.from("b".repeat(64), "hex");
            db.prepare(
                "INSERT INTO fiat_bank_accounts " +
                "(id, wallet_address, method_id_fk, currency, account_holder_name, account_number_hash, " +
                "account_last4, bank_verified, create_time) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)",
            ).run(1, m, 1, "MYR", MERCHANT_WISE_NAME,   wiseHash,   "0001", ts);
            db.prepare(
                "INSERT INTO fiat_bank_accounts " +
                "(id, wallet_address, method_id_fk, currency, account_holder_name, account_number_hash, " +
                "account_last4, bank_verified, create_time) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)",
            ).run(2, m, 2, "CNY", MERCHANT_ALIPAY_NAME, alipayHash, "0002", ts);

            // order_contract — mirror the 4 chain products. `contract_address`
            // has a UNIQUE constraint so we generate distinct hex strings per
            // row; the field is display-only (no FK).
            const productAddr = (i: number) => "0x" + i.toString(16).padStart(40, "0");
            const products = [
                { id: 1, fiat: "MYR", crypto: "USDT", fiat_to_crypto: 1 }, // CRYPTO #0 Wise
                { id: 2, fiat: "CNY", crypto: "USDT", fiat_to_crypto: 1 }, // CRYPTO #1 Alipay
                { id: 3, fiat: "MYR", crypto: "USDT", fiat_to_crypto: 0 }, // FIAT   #0 Wise
                { id: 4, fiat: "CNY", crypto: "USDT", fiat_to_crypto: 0 }, // FIAT   #1 Alipay
            ];
            for (const p of products) {
                db.prepare(
                    "INSERT INTO order_contract " +
                    "(id, wallet_address, fiat_asset_name, crypto_asset_name, fiat_to_crypto, contract_address, create_time) " +
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                ).run(p.id, m, p.fiat, p.crypto, p.fiat_to_crypto, productAddr(p.id), ts);
            }

            // order_index — link each order_contract row to the merchant's bank
            // account that handles its currency.
            const insertIndex = db.prepare(
                "INSERT INTO order_index (wallet_address, order_id, bank_id) VALUES (?, ?, ?)",
            );
            insertIndex.run(m, 1, 1); // MYR  → Wise account
            insertIndex.run(m, 2, 2); // CNY  → Alipay account
            insertIndex.run(m, 3, 1); // MYR  → Wise account (FIAT side)
            insertIndex.run(m, 4, 2); // CNY  → Alipay account (FIAT side)
        })();
    });
    console.log(
        "✅ Dev tables seeded (payment_method × 2, userdata × 1, fiat_bank_accounts × 2, order_contract × 4, order_index × 4)",
    );
}

// ── Asset registry — single source of truth shared with the web app ─────────
const ASSETS_PATH = path.resolve(__dirname, "../../web/src/config/assets.json");
type CryptoEntry = { symbol: string; displayName: string; coingeckoId: string; onChain: { id: number; decimals: number } | null };
type FiatEntry   = { symbol: string; displayName: string; coingeckoVs: string; onChain: { id: number } | null };
const assets = JSON.parse(fs.readFileSync(ASSETS_PATH, "utf-8")) as { crypto: CryptoEntry[]; fiat: FiatEntry[] };
const onChainCryptos = assets.crypto.filter((c): c is CryptoEntry & { onChain: { id: number; decimals: number } } => c.onChain !== null);
const onChainFiats   = assets.fiat.filter((f): f is FiatEntry & { onChain: { id: number } } => f.onChain !== null);

// Rust verifier server signing address (from packages/verifier/.env VERIFIER_PRIVATE_KEY)
// Private key 0x2a871d…09c6 → Hardhat default account[9]
const VERIFIER_SIGNER_ADDRESS = "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720";

const COLLATERAL_18 = parseUnits("100", 18);   // 100 USDT collateral per product
const MINT_AMOUNT_18 = parseUnits("500", 18);  // 500 USDT minted per account
const MINT_AMOUNT_6  = parseUnits("500",  6);  // 500 USDC minted per account
const MAX_ORDER_AMOUNT = parseUnits("1000000", 18);  // 1M USDT global cap (avoids placeOrder revert)
const MAX_UINT256 = (2n ** 256n) - 1n;
const RATE_CNY = 1_000_000n;                   // 0.01 CNY / USDT (RATE_PRECISION_EXP = 8)
const RATE_MYR = 2_000_000n;                   // 0.02 MYR / USDT
const MERCHANT_WISE_NAME     = "KAI XU LOOI";
const MERCHANT_WISE_HANDLE   = "@kaixul1";
const MERCHANT_ALIPAY_NAME   = "KELLY LIM HOOI YEN";
const MERCHANT_ALIPAY_HANDLE = "kellylimhooiyen@hotmail.com";

// Risk config (matches thesis defaults; reset/freeze/reward/decay per user spec):
//   min=500 bps (5%), base=1000 bps (10%), max=10000 bps (100%), step=300 bps (3% per level)
//   reset=5, freezeThreshold=3, rewardThreshold=10, decayIntervalDays=1
const RISK_MIN    = 500;
const RISK_BASE   = 1000;
const RISK_MAX    = 10000;
const RISK_STEP   = 300;
const RISK_RESET  = 5;
const RISK_FREEZE = 3;
const RISK_REWARD = 10;
const RISK_DECAY  = 1;

const TRUSTED_KYB_SERVERS = ["kyb.example.com"];
const TRUSTED_PAYMENT_SERVERS = ["wise.com", "mbillexprod.alipay.com"];

async function main() {
  const { viem } = await network.connect();

  console.log("=== C2C Web Deployment ===\n");

  // ── 0. Wipe SQLite (user explicitly wants every deploy to start fresh) ────
  clearSqliteDb();
  ensureSchema();
  console.log("✅ SQLite schema bootstrapped");

  // ── 1. MockERC20 tokens (driven by assets.json) ──────────────────────────
  const tokens: Record<string, Awaited<ReturnType<typeof viem.deployContract>>> = {};
  for (const [i, c] of onChainCryptos.entries()) {
    if (c.onChain.id !== i) {
      throw new Error(`assets.json: crypto "${c.symbol}".onChain.id (${c.onChain.id}) ≠ on-chain array index ${i}`);
    }
    tokens[c.symbol] = await viem.deployContract("MockERC20", [c.displayName, c.symbol, c.onChain.decimals]);
    console.log(`MockERC20 (${c.symbol}):`.padEnd(24), tokens[c.symbol].address);
  }
  // Keep familiar aliases so the rest of this script stays readable.
  const usdt = tokens["USDT"];
  const usdc = tokens["USDC"];

  // ── 2. TLSNVerifier ───────────────────────────────────────────────────────
  const tlsnVerifier = await viem.deployContract("TLSNVerifier");
  console.log("TLSNVerifier:          ", tlsnVerifier.address);

  // ── 3. C2CAdmin ───────────────────────────────────────────────────────────
  const c2cAdmin = await viem.deployContract("C2CAdmin", [tlsnVerifier.address]);
  console.log("C2CAdmin:              ", c2cAdmin.address);

  // ── 4. C2CEscrow ──────────────────────────────────────────────────────────
  const c2cEscrow = await viem.deployContract("C2CEscrow", [
    c2cAdmin.address,
    tlsnVerifier.address,
  ]);
  console.log("C2CEscrow:             ", c2cEscrow.address);
  // Capture the deploy block immediately so downstream consumers (e.g. keeper
  // event replay) can skip pre-deploy blocks.
  const publicClient = await viem.getPublicClient();
  const escrowDeploymentBlock = await publicClient.getBlockNumber();
  const escrowChainId = await publicClient.getChainId();

  // ── 5. C2CBondVault ───────────────────────────────────────────────────────
  const c2cBondVault = await viem.deployContract("C2CBondVault", [c2cAdmin.address]);
  console.log("C2CBondVault:          ", c2cBondVault.address);

  // ── 6. C2CRiskManager ─────────────────────────────────────────────────────
  const c2cRiskManager = await viem.deployContract("C2CRiskManager", [c2cAdmin.address]);
  console.log("C2CRiskManager:        ", c2cRiskManager.address);

  // ── 7. WisePlatformVerifier + AlipayPlatformVerifier ──────────────────────
  const wisePlatformVerifier = await viem.deployContract("WisePlatformVerifier", [
    tlsnVerifier.address,
  ]);
  const alipayPlatformVerifier = await viem.deployContract("AlipayPlatformVerifier", [
    tlsnVerifier.address,
  ]);
  console.log("WisePlatformVerifier:  ", wisePlatformVerifier.address);
  console.log("AlipayPlatformVerifier:", alipayPlatformVerifier.address);

  // ── 8. Cross-contract authorization ───────────────────────────────────────
  await tlsnVerifier.write.setAuthorizedCaller([c2cAdmin.address, true]);
  await tlsnVerifier.write.setAuthorizedCaller([c2cEscrow.address, true]);
  await c2cAdmin.write.setAuthorizedCaller([c2cEscrow.address, true]);
  console.log("\n✅ Cross-contract authorization configured");

  await c2cBondVault.write.setEscrow([c2cEscrow.address]);
  await c2cRiskManager.write.setEscrow([c2cEscrow.address]);
  await c2cEscrow.write.setManagers([c2cRiskManager.address, c2cBondVault.address]);
  console.log("✅ V4 manager wiring configured (BondVault + RiskManager)");

  // ── 9. Trusted verifier ───────────────────────────────────────────────────
  await tlsnVerifier.write.addTrustedVerifier([VERIFIER_SIGNER_ADDRESS]);
  console.log("✅ Trusted verifier added:", VERIFIER_SIGNER_ADDRESS);

  // ── 10. Trusted servers ───────────────────────────────────────────────────
  for (const server of TRUSTED_KYB_SERVERS) {
    await tlsnVerifier.write.addTrustedKYBServer([server]);
  }
  for (const server of TRUSTED_PAYMENT_SERVERS) {
    await tlsnVerifier.write.addTrustedPaymentServer([server]);
  }
  console.log("✅ Trusted servers:", [...TRUSTED_KYB_SERVERS, ...TRUSTED_PAYMENT_SERVERS].join(", "));

  // ── 11. Platform verifiers ────────────────────────────────────────────────
  const PLATFORM_WISE = await tlsnVerifier.read.PLATFORM_WISE();
  const PLATFORM_ALIPAY = await tlsnVerifier.read.PLATFORM_ALIPAY();
  await tlsnVerifier.write.setPlatformVerifier([PLATFORM_WISE, wisePlatformVerifier.address]);
  await tlsnVerifier.write.setPlatformVerifier([PLATFORM_ALIPAY, alipayPlatformVerifier.address]);
  console.log("✅ Platform verifiers registered (Wise + Alipay)");

  // ── 12. Register supported assets (driven by assets.json) ───────────────
  // Each on-chain write is followed by a receipt check; only on success do we
  // mirror into the corresponding SQLite table (Phase 1).
  for (const c of onChainCryptos) {
    const txHash = await c2cAdmin.write.addCryptoInfo([tokens[c.symbol].address, true]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new Error(`addCryptoInfo(${c.symbol}) reverted: ${txHash}`);
    }
    writeCryptoAssetToDb({
      cryptoId:     c.onChain.id,
      tokenSymbol:  c.symbol,
      tokenAddress: tokens[c.symbol].address,
      isActive:     true,
    });
  }
  for (const [i, f] of onChainFiats.entries()) {
    if (f.onChain.id !== i) {
      throw new Error(`assets.json: fiat "${f.symbol}".onChain.id (${f.onChain.id}) ≠ on-chain array index ${i}`);
    }
    const txHash = await c2cAdmin.write.addFiatInfo([f.symbol, true]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new Error(`addFiatInfo(${f.symbol}) reverted: ${txHash}`);
    }
    writeFiatAssetToDb({
      fiatId:   f.onChain.id,
      fiatName: f.symbol,
      isActive: true,
    });
  }
  console.log("✅ Assets registered from assets.json + DB mirrored:",
    onChainCryptos.map((c, i) => `${c.symbol}(c=${i})`).join(", "), "|",
    onChainFiats.map((f, i) => `${f.symbol}(f=${i})`).join(", "),
  );

  // ── 13. Fetch all node wallets ────────────────────────────────────────────
  const nodeWallets  = await viem.getWalletClients();
  const merchantWallet = nodeWallets[1];
  const merchantAddr   = merchantWallet.account.address;
  // accounts[0]=admin, [1-3]=merchants, [4-8]=users, [9]=verifier signer
  const allAccounts = nodeWallets.slice(0, 10).map((w) => w.account.address);
  const userWallets = nodeWallets.slice(4, 9);
  console.log("\nMerchant:", merchantAddr);
  console.log(`Minting to ${allAccounts.length} accounts...`);

  // ── 14. Mint USDT + USDC to accounts[0-9] ────────────────────────────────
  for (const addr of allAccounts) {
    await usdt.write.mint([addr, MINT_AMOUNT_18]);
    await usdc.write.mint([addr, MINT_AMOUNT_6]);
  }
  console.log("✅ Minted 500 USDT + 500 USDC to all 10 accounts");

  // ── 15. Approve escrow + BondVault for every account[0..9] ──────────────
  //   - escrow approve: required for FIAT placeOrder (locks token in escrow)
  //   - BondVault approve: required for CRYPTO placeOrder (pulls bond into vault)
  // Pre-approving both for ALL accounts removes the extra MetaMask popup at
  // order time and ensures placeOrder eth_estimateGas doesn't fail because of
  // a missing allowance.
  const approveWallets = nodeWallets.slice(0, 10);
  for (const w of approveWallets) {
    const usdtAs = await viem.getContractAt("MockERC20", usdt.address, { client: { wallet: w } });
    const usdcAs = await viem.getContractAt("MockERC20", usdc.address, { client: { wallet: w } });
    await usdtAs.write.approve([c2cEscrow.address,    MAX_UINT256]);
    await usdcAs.write.approve([c2cEscrow.address,    MAX_UINT256]);
    await usdtAs.write.approve([c2cBondVault.address, MAX_UINT256]);
    await usdcAs.write.approve([c2cBondVault.address, MAX_UINT256]);
  }
  console.log("✅ All 10 accounts approved Escrow + BondVault for USDT + USDC");

  // ── 16. Merchant setup (accounts[1]) ─────────────────────────────────────
  {
    const txHash = await c2cAdmin.write.registerMerchantByAdmin([merchantAddr]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new Error(`registerMerchantByAdmin(${merchantAddr}) reverted: ${txHash}`);
    }
    // Persist DB role so useMyRole picks up `merchant` without needing the
    // /api/admin/role/grant signing flow.
    upsertUserProfile(merchantAddr, "merchant");
  }

  const usdtAsM   = await viem.getContractAt("MockERC20", usdt.address, { client: { wallet: merchantWallet } });
  const usdcAsM   = await viem.getContractAt("MockERC20", usdc.address, { client: { wallet: merchantWallet } });
  const adminAsM  = await viem.getContractAt("C2CAdmin",  c2cAdmin.address,  { client: { wallet: merchantWallet } });
  const escrowAsM = await viem.getContractAt("C2CEscrow", c2cEscrow.address, { client: { wallet: merchantWallet } });

  await usdtAsM.write.approve([c2cEscrow.address, MAX_UINT256]);
  await usdcAsM.write.approve([c2cEscrow.address, MAX_UINT256]);

  // Wise payment info — order is critical: chain FIRST → verify receipt →
  // DB ONLY THEN. Crashing or reverting after step 2 leaves DB untouched.
  const wiseSalted = newCommits(MERCHANT_WISE_NAME, MERCHANT_WISE_HANDLE);
  {
    const txHash = await (adminAsM.write as any).setPlatformBinding(
      [PLATFORM_WISE, wiseSalted.nameCommit, wiseSalted.idCommit],
    );
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new Error(`setPlatformBinding(wise) reverted: ${txHash}`);
    }
    writeBindingToDb({
      wallet:     merchantAddr,
      platformId: PLATFORM_WISE as Hex,
      name:       MERCHANT_WISE_NAME,
      handle:     MERCHANT_WISE_HANDLE,
      salt:       wiseSalted.salt,
      nameCommit: wiseSalted.nameCommit,
      idCommit:   wiseSalted.idCommit,
    });
  }

  // Alipay payment info — store the FULL identity, but commit over the MASKED
  // form (that is what the Alipay payment-detail proof reveals).
  const alipaySalted = newCommits(
    maskAlipayName(MERCHANT_ALIPAY_NAME),
    maskAlipayHandle(MERCHANT_ALIPAY_HANDLE),
  );
  {
    const txHash = await (adminAsM.write as any).setPlatformBinding(
      [PLATFORM_ALIPAY, alipaySalted.nameCommit, alipaySalted.idCommit],
    );
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new Error(`setPlatformBinding(alipay) reverted: ${txHash}`);
    }
    writeBindingToDb({
      wallet:     merchantAddr,
      platformId: PLATFORM_ALIPAY as Hex,
      name:       MERCHANT_ALIPAY_NAME,
      handle:     MERCHANT_ALIPAY_HANDLE,
      salt:       alipaySalted.salt,
      nameCommit: alipaySalted.nameCommit,
      idCommit:   alipaySalted.idCommit,
    });
  }
  console.log("✅ Merchant registered + Wise + Alipay payment info set (chain confirmed → DB written)");

  // ── 17. List 4 products (all USDT collateral) ────────────────────────────
  //   CRYPTO #0: USDT(0) + MYR(0) + Wise   → buyer pays MYR via Wise, gets USDT
  //   CRYPTO #1: USDT(0) + CNY(1) + Alipay → buyer pays CNY via Alipay, gets USDT
  //   FIAT  #0: MYR(0)  + USDT(0) + Wise   → user locks USDT, merchant pays MYR via Wise
  //   FIAT  #1: CNY(1)  + USDT(0) + Alipay → user locks USDT, merchant pays CNY via Alipay
  await (escrowAsM.write as any).listCryptoProduct([0n, 0n, COLLATERAL_18, true, PLATFORM_WISE]);    // CRYPTO #0
  await (escrowAsM.write as any).listCryptoProduct([0n, 1n, COLLATERAL_18, true, PLATFORM_ALIPAY]);  // CRYPTO #1
  await (escrowAsM.write as any).listFiatProduct(  [0n, 0n, COLLATERAL_18, true, PLATFORM_WISE]);    // FIAT   #0
  await (escrowAsM.write as any).listFiatProduct(  [1n, 0n, COLLATERAL_18, true, PLATFORM_ALIPAY]);  // FIAT   #1
  console.log("✅ Listed 4 products: Wise×MYR (CRYPTO+FIAT), Alipay×CNY (CRYPTO+FIAT)");

  // Publish rates (RATE_PRECISION_EXP=8): Wise→4.70 MYR/USDT, Alipay→7.24 CNY/USDT
  await (adminAsM.write as any).publishRate([0n, 0, RATE_MYR, 0n]);  // CRYPTO #0 Wise-MYR
  await (adminAsM.write as any).publishRate([1n, 0, RATE_CNY, 0n]);  // CRYPTO #1 Alipay-CNY
  await (adminAsM.write as any).publishRate([0n, 1, RATE_MYR, 0n]);  // FIAT   #0 Wise-MYR
  await (adminAsM.write as any).publishRate([1n, 1, RATE_CNY, 0n]);  // FIAT   #1 Alipay-CNY
  console.log("✅ Rates published: 0.02 MYR/USDT (Wise), 0.01 CNY/USDT (Alipay)");

  // Open all 4 products
  await (adminAsM.write as any).openNow([0n, 0]);
  await (adminAsM.write as any).openNow([1n, 0]);
  await (adminAsM.write as any).openNow([0n, 1]);
  await (adminAsM.write as any).openNow([1n, 1]);
  console.log("✅ All 4 products opened");

  // ── 18. Global / risk config (admin-only, fixes placeOrder gas-cap revert) ──
  await c2cAdmin.write.setMaxOrderAmount([MAX_ORDER_AMOUNT]);
  console.log(`✅ maxOrderAmount = ${MAX_ORDER_AMOUNT.toString()} (1M USDT cap)`);

  await c2cRiskManager.write.setRiskConfig([
    RISK_MIN, RISK_BASE, RISK_MAX, RISK_STEP,
    RISK_RESET, RISK_FREEZE, RISK_REWARD, RISK_DECAY,
  ]);
  console.log(
    `✅ Risk config set: min=${RISK_MIN} base=${RISK_BASE} max=${RISK_MAX} step=${RISK_STEP} `
    + `reset=${RISK_RESET} freeze=${RISK_FREEZE} reward=${RISK_REWARD} decay=${RISK_DECAY}`,
  );

  // ── 18b. Seed legacy dev-only tables for /orders/[orderId] detail page ───
  seedDevTables({ merchant: merchantAddr });

  // ── 19. Write packages/web/.env.local ────────────────────────────────────
  const envPath = path.resolve(__dirname, "../../web/.env.local");

  let existingLines: string[] = [];
  if (fs.existsSync(envPath)) {
    existingLines = fs.readFileSync(envPath, "utf-8").split("\n");
  }

  const contractKeys = new Set([
    "NEXT_PUBLIC_C2C_ADMIN_ADDRESS",
    "NEXT_PUBLIC_C2C_ESCROW_ADDRESS",
    "NEXT_PUBLIC_C2C_BOND_VAULT_ADDRESS",
    "NEXT_PUBLIC_C2C_RISK_MANAGER_ADDRESS",
    "NEXT_PUBLIC_MERCHANT_ADDRESS",
    "NEXT_PUBLIC_CHAIN_ID",
    // Per-token address keys, derived from registry so adding a crypto in
    // assets.json automatically wires the env var (and prunes stale ones).
    ...onChainCryptos.map((c) => `NEXT_PUBLIC_${c.symbol}_ADDRESS`),
  ]);

  const preserved = existingLines.filter((line) => {
    const key = line.split("=")[0].trim();
    return !contractKeys.has(key);
  });

  const contractBlock = [
    `# === Contract addresses (client-side) — updated by deploy-web.ts at ${new Date().toISOString()} ===`,
    `NEXT_PUBLIC_C2C_ADMIN_ADDRESS=${c2cAdmin.address}`,
    `NEXT_PUBLIC_C2C_ESCROW_ADDRESS=${c2cEscrow.address}`,
    `NEXT_PUBLIC_C2C_BOND_VAULT_ADDRESS=${c2cBondVault.address}`,
    `NEXT_PUBLIC_C2C_RISK_MANAGER_ADDRESS=${c2cRiskManager.address}`,
    `NEXT_PUBLIC_MERCHANT_ADDRESS=${merchantAddr}`,
    ...onChainCryptos.map((c) => `NEXT_PUBLIC_${c.symbol}_ADDRESS=${tokens[c.symbol].address}`),
    `NEXT_PUBLIC_CHAIN_ID=31337`,
  ];

  const filtered = preserved.filter(
    (l) => !l.startsWith("# === Contract addresses"),
  );

  const newContent = [...filtered, "", ...contractBlock, ""].join("\n");
  fs.writeFileSync(envPath, newContent, "utf-8");

  // ── 19b. Write packages/contracts/deployments/<chainId>.json ─────────────
  // Consumed by services that need address discovery without hard-coding —
  // e.g. the keeper reads .contracts.c2cEscrow + .deploymentBlock on startup.
  const deploymentsDir = path.resolve(__dirname, "../deployments");
  fs.mkdirSync(deploymentsDir, { recursive: true });
  const deploymentsFile = path.join(deploymentsDir, `web-${escrowChainId}.json`);
  const deploymentsRecord = {
    chainId: escrowChainId,
    label: "web",
    deployedAt: new Date().toISOString(),
    deploymentBlock: escrowDeploymentBlock.toString(),
    contracts: {
      c2cAdmin: c2cAdmin.address,
      c2cEscrow: c2cEscrow.address,
      c2cBondVault: c2cBondVault.address,
      c2cRiskManager: c2cRiskManager.address,
      tlsnVerifier: tlsnVerifier.address,
      wisePlatformVerifier: wisePlatformVerifier.address,
      alipayPlatformVerifier: alipayPlatformVerifier.address,
    },
    tokens: Object.fromEntries(
      onChainCryptos.map((c) => [c.symbol, tokens[c.symbol].address]),
    ),
    merchant: merchantAddr,
  };
  fs.writeFileSync(deploymentsFile, JSON.stringify(deploymentsRecord, null, 2), "utf-8");
  console.log(`✅ Deployments written to ${path.relative(process.cwd(), deploymentsFile)}`);

  // ── 19c. Reset the web keeper's persisted state ──────────────────────────
  // A redeploy produces a fresh escrow + deploymentBlock. The keeper resumes
  // from the cursor in its state.json (`lastProcessedBlock`) and never
  // re-scans below it, so a stale cursor from a previous deploy/chain makes it
  // silently skip the new escrow's early-block orders. Deleting the snapshot
  // forces the keeper to start fresh from this deploymentBlock on its next
  // launch. Matches the keeper's default STATE_FILE_PATH (`./data/state.json`
  // relative to packages/keeper). Only the `web` keeper is reset here — the
  // `demo` keeper tracks a different escrow and is left untouched.
  // NOTE: this only invalidates the on-disk snapshot. A keeper process that is
  // already running keeps the old escrow in memory and rewrites state.json on
  // its next save — it MUST be restarted after this deploy to take effect.
  const keeperStateFile = path.resolve(__dirname, "../../keeper/data/state.json");
  try {
    if (fs.existsSync(keeperStateFile)) {
      fs.rmSync(keeperStateFile, { force: true });
      console.log("🧹 Reset web keeper state (deleted keeper/data/state.json) — restart the keeper to pick up this deploy");
    }
  } catch (err) {
    console.warn(`⚠ Could not reset keeper state at ${keeperStateFile}:`, err);
  }

  console.log("\n" + "=".repeat(60));
  console.log("✅ packages/web/.env.local updated");
  console.log("=".repeat(60));
  console.log(`NEXT_PUBLIC_C2C_ADMIN_ADDRESS=${c2cAdmin.address}`);
  console.log(`NEXT_PUBLIC_C2C_ESCROW_ADDRESS=${c2cEscrow.address}`);
  console.log(`NEXT_PUBLIC_C2C_BOND_VAULT_ADDRESS=${c2cBondVault.address}`);
  console.log(`NEXT_PUBLIC_C2C_RISK_MANAGER_ADDRESS=${c2cRiskManager.address}`);
  console.log(`NEXT_PUBLIC_MERCHANT_ADDRESS=${merchantAddr}`);
  for (const c of onChainCryptos) {
    console.log(`NEXT_PUBLIC_${c.symbol}_ADDRESS=${tokens[c.symbol].address}`);
  }
  console.log(`NEXT_PUBLIC_CHAIN_ID=31337`);
  console.log("=".repeat(60));
  console.log("\nDone. Restart the Next.js dev server to pick up new addresses.\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
