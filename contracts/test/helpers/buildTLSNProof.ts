import {
  keccak256,
  encodePacked,
  encodeAbiParameters,
  parseAbiParameters,
  toHex,
  toBytes,
  type WalletClient,
  type Address,
  type Hex,
  concat,
  hexToBytes,
  bytesToHex,
} from "viem";
import { createHash } from "node:crypto";

export interface RevealedItemInput {
  handlerType: string;
  part: string;
  /** Full JSON fragment, e.g. '{"status":"verified"}' */
  value: string;
  commitment_index: number;
  start_item: number;
  end_item: number;
  /** Byte offset within `value` where the extracted field starts */
  start_value: number;
  /** Byte offset within `value` where the extracted field ends */
  end_value: number;
}

export interface TLSNProofStruct {
  chainId: bigint;
  sessionId: string;
  commitmentsHash: Hex;
  orderBindingHash: Hex;
  policyVersionHash: Hex;
  verifierSignature: Hex;
  revealedItems: Array<{
    handlerType: string;
    part: string;
    value: string;
    commitment_index: bigint;
    start_item: bigint;
    end_item: bigint;
    start_value: bigint;
    end_value: bigint;
  }>;
  commitmentOpenings: Array<{ blinderHex: Hex }>;
  commitments: Array<{
    direction: string;
    hashAlg: string;
    hashValue: Hex;
  }>;
  serverName: string;
}

/**
 * Build a valid TLSNProof that will pass on-chain verification.
 *
 * Steps:
 * 1. For each revealed item, generate a random blinder.
 * 2. Compute commitment hashValue = keccak256(valueBytes || blinder).
 * 3. Compute commitmentsHash = keccak256(concat all hashValues).
 * 4. Sign: keccak256(chainId || keccak256(sessionId) || commitmentsHash) via eth_sign.
 */
const ZERO_BYTES32 = ("0x" + "00".repeat(32)) as Hex;

export async function buildTLSNProof(params: {
  chainId: bigint;
  sessionId: string;
  serverName: string;
  verifierWallet: WalletClient;
  revealedItems: RevealedItemInput[];
  /** orderBindingHash for escrow-bound proofs; defaults to bytes32(0) for standalone tests */
  orderBindingHash?: Hex;
}): Promise<TLSNProofStruct> {
  const { chainId, sessionId, serverName, verifierWallet, revealedItems } =
    params;
  const orderBindingHash: Hex = params.orderBindingHash ?? ZERO_BYTES32;

  // Determine how many unique commitments we need
  const maxIndex =
    revealedItems.length > 0
      ? Math.max(...revealedItems.map((r) => r.commitment_index)) + 1
      : 0;

  // Generate blinders and commitments
  const blinders: Uint8Array[] = [];
  const commitmentHashes: Hex[] = [];

  // Initialise arrays with placeholder values
  for (let i = 0; i < maxIndex; i++) {
    blinders.push(new Uint8Array(32)); // placeholder
    commitmentHashes.push("0x" + "00".repeat(32) as Hex);
  }

  // For each revealed item, compute commitment
  const commitmentOpenings: Array<{ blinderHex: Hex }> = [];

  for (const item of revealedItems) {
    const blinder = crypto.getRandomValues(new Uint8Array(32));
    const blinderHex = bytesToHex(blinder);
    commitmentOpenings.push({ blinderHex });

    // commitment hash = keccak256(value_bytes || blinder_bytes)
    const valueBytes = new TextEncoder().encode(item.value);
    const combined = new Uint8Array(valueBytes.length + blinder.length);
    combined.set(valueBytes, 0);
    combined.set(blinder, valueBytes.length);
    const hashValue = keccak256(bytesToHex(combined));

    // Store in the commitment slot
    blinders[item.commitment_index] = blinder;
    commitmentHashes[item.commitment_index] = hashValue;
  }

  // commitmentsHash = keccak256(concat all commitment hashValues as raw bytes)
  let concatenated: Hex = "0x";
  for (const h of commitmentHashes) {
    concatenated = concat([concatenated as Hex, h]);
  }
  const commitmentsHash = keccak256(concatenated);

  // Sign: preimage (136 bytes) = chainId || keccak256(sessionId) || commitmentsHash || orderBindingHash || policyVersionHash
  const sessionIdHash = keccak256(toHex(sessionId, { size: undefined }));
  const policyVersionHash: Hex = ZERO_BYTES32;

  // abi.encodePacked(uint64, bytes32, bytes32, bytes32, bytes32)
  const messageHash = keccak256(
    encodePacked(
      ["uint64", "bytes32", "bytes32", "bytes32", "bytes32"],
      [chainId, sessionIdHash, commitmentsHash, orderBindingHash, policyVersionHash],
    ),
  );

  // eth signed message (personal_sign)
  const verifierSignature = await verifierWallet.signMessage({
    account: verifierWallet.account!,
    message: { raw: toBytes(messageHash) },
  });

  // Build struct arrays
  const revealedItemsStruct = revealedItems.map((r) => ({
    handlerType: r.handlerType,
    part: r.part,
    value: r.value,
    commitment_index: BigInt(r.commitment_index),
    start_item: BigInt(r.start_item),
    end_item: BigInt(r.end_item),
    start_value: BigInt(r.start_value),
    end_value: BigInt(r.end_value),
  }));

  const commitmentsStruct = commitmentHashes.map((h) => ({
    direction: "Recv",
    hashAlg: "keccak256",
    hashValue: h,
  }));

  return {
    chainId,
    sessionId,
    commitmentsHash,
    orderBindingHash,
    policyVersionHash,
    verifierSignature,
    revealedItems: revealedItemsStruct,
    commitmentOpenings,
    commitments: commitmentsStruct,
    serverName,
  };
}

// ----------------------------------------------------------------
// Convenience builders for specific proof types
// ----------------------------------------------------------------

let sessionCounter = 0;

function nextSessionId(prefix: string): string {
  return `${prefix}-${Date.now()}-${++sessionCounter}`;
}

// ----------------------------------------------------------------
// Alipay datetime helpers
// ----------------------------------------------------------------

/**
 * Convert a Unix UTC timestamp (seconds) to Alipay's "YYYY-MM-DD HH:MM:SS"
 * format in UTC+8 (China Standard Time).
 *
 * The contract's parseDatetimeToUnix() will parse this string, subtract
 * 8 * 3600 (UTC+8 offset), and compare with block.timestamp.
 *
 * Usage in tests:
 *   const gmtSuccess = unixToAlipayDateString(await currentTimestamp());
 */
export function unixToAlipayDateString(unixTs: bigint): string {
  const UTC8_OFFSET = 8 * 3600;
  // Shift to UTC+8 timezone, then read UTC fields — they will represent CST time.
  const d = new Date((Number(unixTs) + UTC8_OFFSET) * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = d.getUTCFullYear();
  const mo = pad(d.getUTCMonth() + 1);
  const da = pad(d.getUTCDate());
  const h = pad(d.getUTCHours());
  const mi = pad(d.getUTCMinutes());
  const s = pad(d.getUTCSeconds());
  return `${y}-${mo}-${da} ${h}:${mi}:${s}`;
}

/**
 * Build a KYB proof where revealedItems[0].value contains "verified".
 *
 * JSON: {"status":"verified"}
 *         0123456789012345678901
 *                    ^-10    ^-18  (start_value=11, end_value=19 → extracts "verified")
 * But the contract checks: value[start-1] == '"' and value[end] == '"'
 * So for "verified": start_value=11, end_value=19 means json[10]='"', json[19]='"'
 *   json = {"status":"verified"}
 *   index: 0         1111111111222
 *          0123456789012345678901
 * "verified" is at index 11..18 (inclusive), so start_value=11, end_value=19
 * Wait: end is exclusive. Contract does: extracted = new bytes(end - start), loop i < end - start
 * And checks json[start-1]=='"' and json[end]=='"'
 * '{"status":"verified"}'
 *  0123456789...
 *  { " s t a t u s " : " v e r i f i e d " }
 *  0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20
 * "verified" = chars 11-18 (v=11, e=12, r=13, i=14, f=15, i=16, e=17, d=18)
 * start_value=11, end_value=19
 * json[10] = '"' ✓, json[19] = '"' ✓
 * extracted = json[11..18] = "verified" ✓
 */
export async function buildKYBProof(
  verifierWallet: WalletClient,
  chainId: bigint,
  serverName: string = "kyb.example.com",
): Promise<TLSNProofStruct> {
  return buildTLSNProof({
    chainId,
    sessionId: nextSessionId("kyb"),
    serverName,
    verifierWallet,
    revealedItems: [
      {
        handlerType: "RECV",
        part: "BODY",
        value: '{"status":"verified"}',
        commitment_index: 0,
        start_item: 0,
        end_item: 21,
        start_value: 11,
        end_value: 19,
      },
    ],
  });
}

/**
 * Build fiat payment proof.
 * revealedItems: [amount, account, status]
 */
export async function buildFiatPaymentProof(
  verifierWallet: WalletClient,
  chainId: bigint,
  amount: string,
  account: string,
): Promise<TLSNProofStruct> {
  // '{"amount":"123.45"}'
  //  0123456789...
  //  { " a m o u n t " : " 1 2 3 . 4 5 " }
  //  0 1 2 3 4 5 6 7 8 9 10 11 ...
  // value starts at index 11, ends at 11+amount.length
  const amountJson = `{"amount":"${amount}"}`;
  const amountStart = 11;
  const amountEnd = amountStart + amount.length;

  // '{"account":"alice@bank"}'
  const accountJson = `{"account":"${account}"}`;
  const accountStart = 12;
  const accountEnd = accountStart + account.length;

  // '{"status":"completed"}'
  const statusJson = '{"status":"completed"}';
  const statusStart = 11;
  const statusEnd = 20; // "completed" is 9 chars

  return buildTLSNProof({
    chainId,
    sessionId: nextSessionId("fiat-pay"),
    serverName: "wise.com",
    verifierWallet,
    revealedItems: [
      {
        handlerType: "RECV",
        part: "BODY",
        value: amountJson,
        commitment_index: 0,
        start_item: 0,
        end_item: amountJson.length,
        start_value: amountStart,
        end_value: amountEnd,
      },
      {
        handlerType: "RECV",
        part: "BODY",
        value: accountJson,
        commitment_index: 1,
        start_item: 0,
        end_item: accountJson.length,
        start_value: accountStart,
        end_value: accountEnd,
      },
      {
        handlerType: "RECV",
        part: "BODY",
        value: statusJson,
        commitment_index: 2,
        start_item: 0,
        end_item: statusJson.length,
        start_value: statusStart,
        end_value: statusEnd,
      },
    ],
  });
}

/**
 * Build merchant received proof.
 * revealedItems: [amount, status]
 */
export async function buildMerchantReceivedProof(
  verifierWallet: WalletClient,
  chainId: bigint,
  amount: string,
): Promise<TLSNProofStruct> {
  const amountJson = `{"amount":"${amount}"}`;
  const amountStart = 11;
  const amountEnd = amountStart + amount.length;

  const statusJson = '{"status":"completed"}';
  const statusStart = 11;
  const statusEnd = 20;

  return buildTLSNProof({
    chainId,
    sessionId: nextSessionId("merchant-recv"),
    serverName: "wise.com",
    verifierWallet,
    revealedItems: [
      {
        handlerType: "RECV",
        part: "BODY",
        value: amountJson,
        commitment_index: 0,
        start_item: 0,
        end_item: amountJson.length,
        start_value: amountStart,
        end_value: amountEnd,
      },
      {
        handlerType: "RECV",
        part: "BODY",
        value: statusJson,
        commitment_index: 1,
        start_item: 0,
        end_item: statusJson.length,
        start_value: statusStart,
        end_value: statusEnd,
      },
    ],
  });
}

// ----------------------------------------------------------------
// Alipay platform proof builder
// ----------------------------------------------------------------

/**
 * Build Alipay payment proof (single proof, unlike Wise which needs two).
 *
 * Parsed fields by key name (contract uses keccak256 key matching):
 *   - "payeeName"       → merchant's real name (e.g. "* LIM HOOI YEN")
 *   - "payeeLoginEmail" → merchant's Alipay email (e.g. "kel***@hotmail.com")
 *   - "status"          → must equal "succeed"
 *   - "payAmount"       → fiat amount STRING with 2dp (e.g. "250.00")
 *   - "orderId"         → unique Alipay order ID (string, replay prevention)
 *   - "gmtSuccess"      → UTC+8 datetime string "YYYY-MM-DD HH:MM:SS"
 *
 * Amount precision: same 1e33 formula as Wise.
 *   fiatAmountX1000 = mulDiv(cryptoAmount, rate, 1e33)
 *   e.g. 100 USDT at 2.50 CNY/USDT → 250000 → "250.00" in proof ✓
 *
 * Use unixToAlipayDateString(blockTimestamp) to generate a valid gmtSuccess.
 *
 * @param payeeName      Merchant's real name as registered on Alipay
 * @param payeeEmail     Merchant's Alipay login email
 * @param payAmount      CNY amount string e.g. "250.00"
 * @param orderId        Unique Alipay order ID
 * @param gmtSuccess     Payment datetime in UTC+8 "YYYY-MM-DD HH:MM:SS"
 */
export async function buildAlipayProof(
  verifierWallet: WalletClient,
  chainId: bigint,
  payeeName: string,
  payeeEmail: string,
  payAmount: string,
  orderId: string,
  gmtSuccess: string,
): Promise<TLSNProofStruct> {
  const sentStartLine =
    `POST https://mbillexprod.alipay.com/enterprise/fundReportDetailQuery.json?orderId=${orderId} HTTP/1.1`;
  const recvStartLine = "HTTP/1.1 200 OK";

  // Key-value fragments — contract parses by key name hash
  const payeeNameValue    = `"payeeName":"${payeeName}"`;
  const payeeEmailValue   = `"payeeLoginEmail":"${payeeEmail}"`;
  const statusValue       = `"status":"SUCCESS"`;
  const bizTypeValue      = `"bizType":"TRANSFER"`;
  const payAmountValue    = `"payAmount":"${payAmount}"`;
  const orderIdValue      = `"orderId":"${orderId}"`;
  const gmtSuccessValue   = `"gmtSuccess":"${gmtSuccess}"`;

  return buildTLSNProof({
    chainId,
    sessionId: nextSessionId("alipay"),
    serverName: "mbillexprod.alipay.com",
    verifierWallet,
    revealedItems: [
      // [0] SENT START_LINE
      {
        handlerType: "SENT",
        part: "START_LINE",
        value: sentStartLine,
        commitment_index: 0,
        start_item: 0, end_item: sentStartLine.length,
        start_value: 0, end_value: sentStartLine.length,
      },
      // [1] RECV START_LINE — HTTP 200 OK
      {
        handlerType: "RECV",
        part: "START_LINE",
        value: recvStartLine,
        commitment_index: 1,
        start_item: 0, end_item: recvStartLine.length,
        start_value: 0, end_value: recvStartLine.length,
      },
      // [2] payeeName
      {
        handlerType: "RECV",
        part: "ALL",
        value: payeeNameValue,
        commitment_index: 2,
        start_item: 0, end_item: payeeNameValue.length,
        start_value: 0, end_value: payeeNameValue.length,
      },
      // [3] payeeLoginEmail
      {
        handlerType: "RECV",
        part: "ALL",
        value: payeeEmailValue,
        commitment_index: 3,
        start_item: 0, end_item: payeeEmailValue.length,
        start_value: 0, end_value: payeeEmailValue.length,
      },
      // [4] status
      {
        handlerType: "RECV",
        part: "ALL",
        value: statusValue,
        commitment_index: 4,
        start_item: 0, end_item: statusValue.length,
        start_value: 0, end_value: statusValue.length,
      },
      // [5] bizType
      {
        handlerType: "RECV",
        part: "ALL",
        value: bizTypeValue,
        commitment_index: 5,
        start_item: 0, end_item: bizTypeValue.length,
        start_value: 0, end_value: bizTypeValue.length,
      },
      // [6] payAmount
      {
        handlerType: "RECV",
        part: "ALL",
        value: payAmountValue,
        commitment_index: 6,
        start_item: 0, end_item: payAmountValue.length,
        start_value: 0, end_value: payAmountValue.length,
      },
      // [7] orderId
      {
        handlerType: "RECV",
        part: "ALL",
        value: orderIdValue,
        commitment_index: 7,
        start_item: 0, end_item: orderIdValue.length,
        start_value: 0, end_value: orderIdValue.length,
      },
      // [8] gmtSuccess
      {
        handlerType: "RECV",
        part: "ALL",
        value: gmtSuccessValue,
        commitment_index: 8,
        start_item: 0, end_item: gmtSuccessValue.length,
        start_value: 0, end_value: gmtSuccessValue.length,
      },
    ],
  });
}

// ----------------------------------------------------------------
// Wise platform proof builders
// ----------------------------------------------------------------

/**
 * Build Wise contacts proof.
 *
 * Real proof structure (from Wise gateway API):
 *   [0] SENT START_LINE  — full request URL with profile/account IDs
 *   [1] RECV ALL         — "subtitle":"@handle" (Wise unique handle)
 *   [2] RECV START_LINE  — "HTTP/1.1 200 OK"
 *   [3] RECV ALL         — "title":"DISPLAY NAME" (display name)
 *
 * Value format: raw JSON key-value fragments like "key":"value" (no wrapping {}).
 * start_value/end_value span the full value for ALL/START_LINE items,
 * because the contract currently does NOT call _extractAndVerifyField on contacts items.
 * (Contract only checks revealedItems.length >= 3 and serverName trust.)
 *
 * ⚠ CONTRACT GAP: The contract does NOT extract or verify the recipient
 *   name/account from the contacts proof against the merchant's fiat account.
 */
export async function buildWiseContactsProof(
  verifierWallet: WalletClient,
  chainId: bigint,
  recipientName: string = "KAI XU LOOI",
  recipientHandle: string = "@kaixul1",
): Promise<TLSNProofStruct> {
  // [0] SENT START_LINE — full URL with profile ID and account ID
  const sentStartLine =
    "GET https://wise.com/gateway/v2/profiles/79154782/contacts?accountId=1217816236 HTTP/1.1";

  // [1] RECV ALL — "subtitle":"@kaixul1"
  //  " s u b t i t l e " : " @ k a i x u l 1 "
  //  0 1 2 3 4 5 6 7 8 9 10 11 12 ...
  // Full value span (contract doesn't extract subfields from contacts)
  const subtitleValue = `"subtitle":"${recipientHandle}"`;

  // [2] RECV START_LINE
  const recvStartLine = "HTTP/1.1 200 OK";

  // [3] RECV ALL — "title":"KAI XU LOOI"
  //  " t i t l e " : " K A I   X U   L O O I "
  //  0 1 2 3 4 5 6 7 8 9 10 ...
  const titleValue = `"title":"${recipientName}"`;

  return buildTLSNProof({
    chainId,
    sessionId: nextSessionId("wise-contacts"),
    serverName: "wise.com",
    verifierWallet,
    revealedItems: [
      {
        handlerType: "SENT",
        part: "START_LINE",
        value: sentStartLine,
        commitment_index: 0,
        start_item: 0,
        end_item: sentStartLine.length,
        start_value: 0,
        end_value: sentStartLine.length,
      },
      {
        handlerType: "RECV",
        part: "ALL",
        value: subtitleValue,
        commitment_index: 1,
        start_item: 1920,
        end_item: 1920 + subtitleValue.length,
        start_value: 0,
        end_value: subtitleValue.length,
      },
      {
        handlerType: "RECV",
        part: "START_LINE",
        value: recvStartLine,
        commitment_index: 2,
        start_item: 0,
        end_item: recvStartLine.length,
        start_value: 0,
        end_value: recvStartLine.length,
      },
      {
        handlerType: "RECV",
        part: "ALL",
        value: titleValue,
        commitment_index: 3,
        start_item: 1898,
        end_item: 1898 + titleValue.length,
        start_value: 0,
        end_value: titleValue.length,
      },
    ],
  });
}

/**
 * Build Wise transfer proof.
 *
 * The contract parses by key name (not index), so item order doesn't matter.
 * Required fields: "state", "targetAmount", "targetCurrency", "id", "date"
 *
 * Value format matches real Wise API:
 *   - "state":"OUTGOING_PAYMENT_SENT" (string)
 *   - "targetAmount":450 (numeric — contract parses via _extractFiatAmountFromBytes)
 *   - "targetCurrency":"MYR" (string)
 *   - "id":2008490705 (numeric)
 *   - "date":1772810945000 (numeric, milliseconds)
 *
 * @param amount — numeric amount string, e.g. "450" or "450.50" (no quotes added)
 * @param dateMs — date as millisecond timestamp (default: well within any test deadline)
 */
export async function buildWiseTransferProof(
  verifierWallet: WalletClient,
  chainId: bigint,
  amount: string,
  currency: string = "MYR",
  transferId: string = "2008490705",
  dateMs: string = "1000000000000",
): Promise<TLSNProofStruct> {
  const sentStartLine =
    `GET https://wise.com/gateway/v3/profiles/79154782/transfers/${transferId} HTTP/1.1`;
  const recvStartLine = "HTTP/1.1 200 OK";

  // Key-value items (contract parses by key name hash)
  const stateValue = `"state":"OUTGOING_PAYMENT_SENT"`;
  const amountValue = `"targetAmount":${amount}`;
  const currencyValue = `"targetCurrency":"${currency}"`;
  const idValue = `"id":${transferId}`;
  const dateValue = `"date":${dateMs}`;

  return buildTLSNProof({
    chainId,
    sessionId: nextSessionId("wise-transfer"),
    serverName: "wise.com",
    verifierWallet,
    revealedItems: [
      {
        handlerType: "SENT",
        part: "START_LINE",
        value: sentStartLine,
        commitment_index: 0,
        start_item: 0,
        end_item: sentStartLine.length,
        start_value: 0,
        end_value: sentStartLine.length,
      },
      {
        handlerType: "RECV",
        part: "START_LINE",
        value: recvStartLine,
        commitment_index: 1,
        start_item: 0,
        end_item: recvStartLine.length,
        start_value: 0,
        end_value: recvStartLine.length,
      },
      {
        handlerType: "RECV",
        part: "BODY",
        value: stateValue,
        commitment_index: 2,
        start_item: 0,
        end_item: stateValue.length,
        start_value: 0,
        end_value: stateValue.length,
      },
      {
        handlerType: "RECV",
        part: "BODY",
        value: amountValue,
        commitment_index: 3,
        start_item: 0,
        end_item: amountValue.length,
        start_value: 0,
        end_value: amountValue.length,
      },
      {
        handlerType: "RECV",
        part: "BODY",
        value: currencyValue,
        commitment_index: 4,
        start_item: 0,
        end_item: currencyValue.length,
        start_value: 0,
        end_value: currencyValue.length,
      },
      {
        handlerType: "RECV",
        part: "BODY",
        value: idValue,
        commitment_index: 5,
        start_item: 0,
        end_item: idValue.length,
        start_value: 0,
        end_value: idValue.length,
      },
      {
        handlerType: "RECV",
        part: "BODY",
        value: dateValue,
        commitment_index: 6,
        start_item: 0,
        end_item: dateValue.length,
        start_value: 0,
        end_value: dateValue.length,
      },
    ],
  });
}

// ================================================================
//  ZK Proof Helpers (TLSNZKProof — SHA256 commitments, Noir circuit)
// ================================================================

export interface TLSNZKProofStruct {
  chainId: bigint;
  sessionId: string;
  commitmentsHash: Hex;
  verifierSignature: Hex;
  zkProof: Hex;
  zkPublicInputs: Hex[];
  serverName: string;
}

/**
 * Encode a bytes32 value as 32 Noir field elements (one byte per element).
 * Each element is a 32-byte big-endian value with the actual byte in the
 * last position (same encoding used by @noir-lang/noir_js for [u8; 32] inputs).
 */
function bytes32ToFieldElements(value: Uint8Array | Buffer): Hex[] {
  const elements: Hex[] = [];
  for (let i = 0; i < 32; i++) {
    const fieldElem = new Uint8Array(32);
    fieldElem[31] = value[i] ?? 0;
    elements.push(bytesToHex(fieldElem) as Hex);
  }
  return elements;
}

/**
 * Encode a u64 value as one Noir field element (32 bytes, big-endian).
 */
function u64ToFieldElement(value: bigint): Hex {
  const fieldElem = new Uint8Array(32);
  for (let i = 7; i >= 0; i--) {
    fieldElem[31 - (7 - i)] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytesToHex(fieldElem) as Hex;
}

/**
 * Compute SHA256(raw_bytes) and return as 32-byte Buffer.
 */
function sha256(data: Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

/**
 * Build a mock TLSNZKProof with SHA256 commitments for Wise payment.
 *
 * Public input layout (wise-payment circuit):
 *   [0..31]  = commitments_hash (one byte per field element)
 *   [32]     = expected_fiat_amount_x1000 (u64)
 *   [33]     = order_deadline (u64)
 *   [34..65] = merchant_info_hash (one byte per field element)
 *   [66..97] = transfer_id_hash (one byte per field element)
 *
 * @param verifierWallet    Signer for verifier ECDSA signature
 * @param chainId           Chain ID
 * @param fiatAmountX1000   Expected fiat amount × 1000
 * @param orderDeadline     Order deadline (unix seconds)
 * @param merchantInfoHash  sha256(displayName || "|" || handle) from C2CAdmin
 * @param transferId        Wise transfer ID string (for replay prevention)
 * @param commitmentCount   Number of TLS commitments to simulate (default: 5)
 */
export async function buildWiseZKProof(
  verifierWallet: WalletClient,
  chainId: bigint,
  fiatAmountX1000: bigint,
  orderDeadline: bigint,
  merchantInfoHash: Hex,
  transferId: string = "2008490705",
  commitmentCount: number = 5,
  serverName: string = "wise.com",
): Promise<TLSNZKProofStruct> {
  // Simulate TLS commitments: SHA256(value || blinder_16bytes) for each
  const commitHashes: Buffer[] = [];
  for (let i = 0; i < commitmentCount; i++) {
    const valueBytes = Buffer.from(`commitment_value_${i}`);
    const blinder = Buffer.alloc(16, i); // deterministic for reproducibility
    const combined = Buffer.concat([valueBytes, blinder]);
    commitHashes.push(sha256(combined));
  }

  // commitmentsHash = SHA256(comm_0 || comm_1 || ... || comm_N)
  const allComms = Buffer.concat(commitHashes);
  const commitmentsHash = sha256(allComms);
  const commitmentsHashHex = bytesToHex(commitmentsHash) as Hex;

  // Compute transfer_id_hash = SHA256(transferId_bytes)
  const transferIdBytes = Buffer.from(transferId, "utf8");
  const transferIdHash = sha256(transferIdBytes);

  // Compute merchant_info_hash (bytes from the hex parameter)
  const merchantInfoHashBytes = hexToBytes(merchantInfoHash);

  // Build public inputs
  const zkPublicInputs: Hex[] = [
    ...bytes32ToFieldElements(commitmentsHash),           // [0..31]
    u64ToFieldElement(fiatAmountX1000),                   // [32]
    u64ToFieldElement(orderDeadline),                     // [33]
    ...bytes32ToFieldElements(merchantInfoHashBytes),     // [34..65]
    ...bytes32ToFieldElements(transferIdHash),            // [66..97]
  ];

  // Verifier signature: sign over keccak256(chainId || keccak256(sessionId) || commitmentsHash)
  const sessionId = nextSessionId("wise-zk");
  const sessionIdHash = keccak256(toHex(sessionId, { size: undefined }));
  const messageHash = keccak256(
    encodePacked(
      ["uint64", "bytes32", "bytes32"],
      [chainId, sessionIdHash as Hex, commitmentsHashHex],
    ),
  );
  const verifierSignature = await verifierWallet.signMessage({
    account: verifierWallet.account!,
    message: { raw: toBytes(messageHash) },
  });

  return {
    chainId,
    sessionId,
    commitmentsHash: commitmentsHashHex,
    verifierSignature,
    zkProof: "0xdeadbeef" as Hex, // MockNoirVerifier accepts any proof bytes
    zkPublicInputs,
    serverName,
  };
}

/**
 * Build a mock TLSNZKProof for Alipay payment/merchant-received circuits.
 *
 * Public input layout (alipay-payment / alipay-merchant-received circuit):
 *   [0..31]  = commitments_hash
 *   [32]     = expected_amount_x1000 (u64)
 *   [33]     = order_deadline (u64)
 *   [34..65] = merchant_info_hash
 *   [66..97] = order_id_hash = sha256(orderId_bytes)
 */
export async function buildAlipayZKProof(
  verifierWallet: WalletClient,
  chainId: bigint,
  amountX1000: bigint,
  orderDeadline: bigint,
  merchantInfoHash: Hex,
  orderId: string,
  serverName: string = "mbillexprod.alipay.com",
): Promise<TLSNZKProofStruct> {
  const commitmentCount = 8;
  const commitHashes: Buffer[] = [];
  for (let i = 0; i < commitmentCount; i++) {
    const valueBytes = Buffer.from(`alipay_commit_${i}`);
    const blinder = Buffer.alloc(16, i + 10);
    commitHashes.push(sha256(Buffer.concat([valueBytes, blinder])));
  }

  const allComms = Buffer.concat(commitHashes);
  const commitmentsHash = sha256(allComms);
  const commitmentsHashHex = bytesToHex(commitmentsHash) as Hex;

  const orderIdHash = sha256(Buffer.from(orderId, "utf8"));
  const merchantInfoHashBytes = hexToBytes(merchantInfoHash);

  const zkPublicInputs: Hex[] = [
    ...bytes32ToFieldElements(commitmentsHash),
    u64ToFieldElement(amountX1000),
    u64ToFieldElement(orderDeadline),
    ...bytes32ToFieldElements(merchantInfoHashBytes),
    ...bytes32ToFieldElements(orderIdHash),
  ];

  const sessionId = nextSessionId("alipay-zk");
  const sessionIdHash = keccak256(toHex(sessionId, { size: undefined }));
  const messageHash = keccak256(
    encodePacked(
      ["uint64", "bytes32", "bytes32"],
      [chainId, sessionIdHash as Hex, commitmentsHashHex],
    ),
  );
  const verifierSignature = await verifierWallet.signMessage({
    account: verifierWallet.account!,
    message: { raw: toBytes(messageHash) },
  });

  return {
    chainId,
    sessionId,
    commitmentsHash: commitmentsHashHex,
    verifierSignature,
    zkProof: "0xdeadbeef" as Hex,
    zkPublicInputs,
    serverName,
  };
}

// ================================================================
//  Platform verification ABI encoding helpers
//  Used by tests that call TLSNVerifier.verifyAndDelegate() directly.
//
//  C2CEscrow encodes these internally; these helpers are only needed
//  when constructing paramsData for direct TLSNVerifier calls in tests.
// ================================================================

/**
 * ABI-encode the standard paramsData consumed by every IPlatformVerifier.
 *
 * Matches what the contracts decode:
 *   abi.decode(paramsData, (uint256 fiatAmountX1000,
 *                           string  targetCurrency,
 *                           uint256 orderDeadline,
 *                           uint256 orderCreationTime))
 *
 * @param orderCreationTime  lower bound for transfer timestamp; pass 0 to disable.
 */
export function encodePlatformParams(
  fiatAmountX1000: bigint,
  targetCurrency: string,
  orderDeadline: bigint,
  orderCreationTime: bigint = 0n,
): Hex {
  return encodeAbiParameters(
    parseAbiParameters("uint256, string, uint256, uint256"),
    [fiatAmountX1000, targetCurrency, orderDeadline, orderCreationTime],
  ) as Hex;
}

// Convenience wrappers so call-sites are self-documenting:
export const encodeWiseParams = encodePlatformParams;
export const encodeAlipayParams = encodePlatformParams;
