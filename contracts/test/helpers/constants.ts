// ─── Shared test constants ────────────────────────────────────────────────────

export const ORDER_TIMEOUT = 900n; // 15 min, matches C2CEscrow.sol

// Server names (must be registered as trustedPaymentServers)
export const ALIPAY_SERVER = "mbillexprod.alipay.com";
export const WISE_SERVER   = "wise.com";

// ERC-20 amounts
export const TRADE_AMOUNT = 1_000_000_000_000_000_000n; // 1 USDT (1e18)
export const COLLATERAL   = 10_000_000_000_000_000_000n; // 10 USDT (enough for tests)
export const MINT_AMOUNT  = 50_000_000_000_000_000_000n; // 50 USDT

// ── Alipay rates ──────────────────────────────────────────────────────────────
// Unified encoding: rate = fiat_price_per_whole_token × 10^8
// fiatX1000 = mulDiv(amountRaw × 1000, rate, 10^(tokenDecimals + 8))
// For USDT (18dp): fiatX1000 = 1e18 × 1000 × 720_000_000 / 10^26 = 7200
export const RATE_ALIPAY_CRYPTO   = 720_000_000n; // 7.200 CNY/token × 1e8
export const RATE_ALIPAY_FIAT     = 720_000_000n; // same unified encoding
export const ALIPAY_FIAT_X1000    = 7200n; // expected fiatAmountX1000 in both flows
export const ALIPAY_AMOUNT_STR    = "7.200"; // extractFiatAmount("7.200") == 7200

// ── Wise rates ────────────────────────────────────────────────────────────────
// For USDT (18dp): fiatX1000 = 1e18 × 1000 × 450_000_000 / 10^26 = 4500
export const RATE_WISE_CRYPTO     = 450_000_000n; // 4.500 MYR/token × 1e8
export const RATE_WISE_FIAT       = 450_000_000n; // same unified encoding
export const WISE_FIAT_X1000      = 4500n;
export const WISE_AMOUNT_STR      = "4.500";

// Asset IDs (registered in deploy.ts)
export const USDT_CRYPTO_ID = 0n;
export const CNY_FIAT_ID    = 0n;
export const MYR_FIAT_ID    = 1n;

export const CNY_NAME = "CNY";
export const MYR_NAME = "MYR";

// Test identity strings (hashed before going on-chain)
// Alipay identities
export const ALIPAY_MERCHANT_NAME   = "* LIM HOOI YEN";
export const ALIPAY_MERCHANT_HANDLE = "kel***@hotmail.com";
export const ALIPAY_BUYER_NAME      = "* KAI ZHI";
export const ALIPAY_BUYER_HANDLE    = "151******62";

// Wise identities
export const WISE_MERCHANT_NAME   = "KAI XU LOOI";
export const WISE_MERCHANT_HANDLE = "@kaixul1";
export const WISE_BUYER_NAME      = "KELLY LIM HOOI YEN";
export const WISE_BUYER_HANDLE    = "@kellylimh";

// Backward-compatible aliases (defaulting to Wise identities)
export const MERCHANT_NAME   = WISE_MERCHANT_NAME;
export const MERCHANT_HANDLE = WISE_MERCHANT_HANDLE;
export const BUYER_NAME      = WISE_BUYER_NAME;
export const BUYER_HANDLE    = WISE_BUYER_HANDLE;

export const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;

// ── MVP: Rate & BusinessHours constants ──────────────────────────────────────
// 第一次 publishRate 后 version == 1（初始默认值 0 表示"未发布"）
export const RATE_VERSION_INITIAL = 1n;

// USD 上限（D-5：1:1，USDT 18 位小数），1000 USDT
export const MAX_ORDER_AMOUNT = 1_000n * 10n ** 18n;

// 营业时间（UTC 秒）09:00–18:00，周一至周五
export const OPEN_SECOND          = 9 * 3600;    // 32400
export const CLOSE_SECOND         = 18 * 3600;   // 64800
export const ACTIVE_DAYS_WEEKDAY  = 0b0011111;   // bit0–bit4 = 周一至周五 = 31
