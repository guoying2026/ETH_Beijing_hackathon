/**
 * TLSNProof builder for contract tests.
 *
 * Commitment scheme (mirrors TLSNVerifier._verifyCommitmentOpenings):
 *   hashValue = keccak256(concat(utf8(value), blinder_bytes))
 *   commitmentsHash = keccak256(concat(all hashValues))
 *
 * Verifier signature v2 (mirrors TLSNVerifier._recoverVerifierSigner):
 *   preimage (136 bytes) =
 *     chainId (uint64, 8 bytes BE)
 *     || keccak256(sessionId as UTF-8) (32 bytes)
 *     || commitmentsHash (32 bytes)
 *     || orderBindingHash (32 bytes, bytes32(0) if absent)
 *     || policyVersionHash (32 bytes, bytes32(0) if absent)
 *   messageHash = keccak256(preimage)
 *   signature   = eth_sign(messageHash)  ← adds Ethereum Signed Message prefix
 */

import { randomBytes } from "node:crypto";
import {
  keccak256, encodePacked, toBytes, stringToHex, concat, toHex,
  type WalletClient,
} from "viem";

const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;

// ── Types matching the contract structs ───────────────────────────────────────

export interface TLSNRevealedItem {
  handlerType:       string;
  part:              string;
  value:             string;
  commitment_index:  bigint;
  start_item:        bigint;
  end_item:          bigint;
  start_value:       bigint;
  end_value:         bigint;
}

export interface TLSNCommitmentOpening {
  blinderHex: `0x${string}`;
}

export interface TLSNCommitment {
  direction: string;
  hashAlg:   string;
  hashValue: `0x${string}`;
}

export interface TLSNProof {
  chainId:             bigint;
  sessionId:           string;
  commitmentsHash:     `0x${string}`;
  orderBindingHash:    `0x${string}`;
  policyVersionHash:   `0x${string}`;
  verifierSignature:   `0x${string}`;
  revealedItems:       TLSNRevealedItem[];
  commitmentOpenings:  TLSNCommitmentOpening[];
  commitments:         TLSNCommitment[];
  serverName:          string;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Random 32-byte hex blinder */
function randomBlinder(): `0x${string}` {
  return `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
}

/** keccak256(concat(utf8(value), blinder_bytes)) */
function commitHash(value: string, blinder: `0x${string}`): `0x${string}` {
  return keccak256(concat([stringToHex(value), blinder]));
}

/** Sign the verifier message with eth_sign prefix (v2: 5-item 136-byte preimage) */
async function signVerifier(
  wallet: WalletClient,
  chainId: bigint,
  sessionId: string,
  commitmentsHash: `0x${string}`,
  orderBindingHash: `0x${string}`,
  policyVersionHash: `0x${string}`,
): Promise<`0x${string}`> {
  const sessionIdHash = keccak256(toHex(toBytes(sessionId)));
  const messageHash = keccak256(
    encodePacked(
      ["uint64", "bytes32", "bytes32", "bytes32", "bytes32"],
      [chainId, sessionIdHash, commitmentsHash, orderBindingHash, policyVersionHash],
    ),
  );
  return wallet.signMessage({
    account: wallet.account!,
    message: { raw: toBytes(messageHash) },
  }) as Promise<`0x${string}`>;
}

/** Build a TLSNProof from an ordered list of field value strings */
async function assembleProof(params: {
  fieldValues:      string[];            // e.g. ['"payAmount":"7.20"', '"status":"SUCCESS"']
  chainId:          bigint;
  sessionId:        string;
  orderBindingHash: `0x${string}`;
  verifierWallet:   WalletClient;
  serverName:       string;
  policyVersionHash?: `0x${string}`;    // default bytes32(0)
  /** override specific commitments (for tamper tests) */
  overrideCommitments?: TLSNCommitment[];
  /** override commitmentsHash (for tamper tests) */
  overrideCommitmentsHash?: `0x${string}`;
  /** override verifierSignature (for tamper tests) */
  overrideSignature?: `0x${string}`;
}): Promise<TLSNProof> {
  const policyVersionHash = params.policyVersionHash ?? ZERO_HASH;
  const blinders = params.fieldValues.map(() => randomBlinder());
  const hashValues = params.fieldValues.map((v, i) => commitHash(v, blinders[i]));

  // commitmentsHash = keccak256(concat(all hashValues))
  const commitmentsHash: `0x${string}` =
    params.overrideCommitmentsHash ??
    keccak256(concat(hashValues));

  const signature = params.overrideSignature ??
    await signVerifier(
      params.verifierWallet,
      params.chainId,
      params.sessionId,
      commitmentsHash,
      params.orderBindingHash,
      policyVersionHash,
    );

  const revealedItems: TLSNRevealedItem[] = params.fieldValues.map((v, i) => ({
    handlerType:      "RECV",
    part:             "BODY",
    value:            v,
    commitment_index: BigInt(i),
    start_item:       0n,
    end_item:         BigInt(v.length),
    start_value:      0n,
    end_value:        BigInt(v.length),
  }));

  const commitmentOpenings: TLSNCommitmentOpening[] = blinders.map((b) => ({
    blinderHex: b,
  }));

  const commitments: TLSNCommitment[] =
    params.overrideCommitments ??
    hashValues.map((h) => ({
      direction: "Recv",
      hashAlg:   "Keccak256",
      hashValue: h,
    }));

  return {
    chainId:            params.chainId,
    sessionId:          params.sessionId,
    commitmentsHash,
    orderBindingHash:   params.orderBindingHash,
    policyVersionHash,
    verifierSignature:  signature,
    revealedItems,
    commitmentOpenings,
    commitments,
    serverName:         params.serverName,
  };
}

// ── Counter for unique session IDs ────────────────────────────────────────────
let _sessionCounter = 0;
export function nextSession(): string {
  return `test-session-${Date.now()}-${++_sessionCounter}`;
}

// ── KYB proof builders ────────────────────────────────────────────────────────

/**
 * Build a valid KYB proof for merchant registration.
 * The revealedItem value is '"verified"' with byte ranges that extract "verified".
 * orderBindingHash is ZERO_HASH since KYB proofs are not bound to an escrow order.
 *
 * On-chain _extractAndVerifyField(item, isStringType=true):
 *   value = '"verified"' (10 chars)
 *   start_value = 1, end_value = 9
 *   value[start-1] = value[0] = '"' ✓
 *   value[end]     = value[9] = '"' ✓
 *   extracted = value[1..8] = "verified" ✓
 */
export async function buildKYBProof(p: {
  verifierWallet:      WalletClient;
  chainId:             bigint;
  sessionId?:          string;
  serverName?:         string;
  overrideCommitmentsHash?: `0x${string}`;
  overrideCommitments?:     TLSNCommitment[];
  overrideSignature?:       `0x${string}`;
}): Promise<TLSNProof> {
  // '"verified"' — 10 chars.  On-chain extraction: start_value=1, end_value=9
  //   value[0]='"', value[9]='"', value[1..8]="verified"
  const kybValue = '"verified"';
  const startV = 1n;
  const endV   = 9n; // 1 + "verified".length = 9

  const orderBindingHash = ZERO_HASH;
  const sessionId  = p.sessionId ?? nextSession();
  const blinder    = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
  const hashValue  = keccak256(concat([stringToHex(kybValue), blinder]));
  const commitmentsHash = p.overrideCommitmentsHash ?? keccak256(hashValue);

  const sessionIdHash = keccak256(toHex(toBytes(sessionId)));
  const messageHash   = keccak256(
    encodePacked(
      ["uint64", "bytes32", "bytes32", "bytes32", "bytes32"],
      [p.chainId, sessionIdHash, commitmentsHash, orderBindingHash, ZERO_HASH],
    ),
  );
  const signature = p.overrideSignature ??
    (await p.verifierWallet.signMessage({
      account: p.verifierWallet.account!,
      message: { raw: toBytes(messageHash) },
    }) as `0x${string}`);

  const commitments: TLSNCommitment[] = p.overrideCommitments ?? [{
    direction: "Recv",
    hashAlg:   "Keccak256",
    hashValue,
  }];

  return {
    chainId:           p.chainId,
    sessionId,
    commitmentsHash,
    orderBindingHash,
    policyVersionHash: ZERO_HASH,
    verifierSignature: signature,
    revealedItems: [{
      handlerType:      "RECV",
      part:             "BODY",
      value:            kybValue,
      commitment_index: 0n,
      start_item:       0n,
      end_item:         BigInt(kybValue.length),
      start_value:      startV,
      end_value:        endV,
    }],
    commitmentOpenings: [{ blinderHex: blinder }],
    commitments,
    serverName: p.serverName ?? "kyb.example.com",
  };
}

/**
 * Build a KYB proof with a non-"verified" status, triggering KYCNotVerified on-chain.
 */
export async function buildKYBProofBadStatus(p: {
  verifierWallet: WalletClient;
  chainId:        bigint;
  sessionId?:     string;
  serverName?:    string;
  status?:        string; // default "pending"
}): Promise<TLSNProof> {
  // Construct a value with quoted status that is NOT "verified"
  // Format: '"<status>"' where <status> defaults to "pending"
  const status   = p.status ?? "pending";
  const kybValue = `"${status}"`;
  // Byte ranges: start_value=1, end_value=1+status.length
  const startV = 1;
  const endV   = 1 + status.length;

  // Manually assemble since we need custom byte ranges
  const blinder    = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
  const hashValue  = keccak256(concat([stringToHex(kybValue), blinder]));
  const commitmentsHash = keccak256(hashValue);
  const sessionId  = p.sessionId ?? nextSession();
  const orderBindingHash = ZERO_HASH;

  const sessionIdHash = keccak256(toHex(toBytes(sessionId)));
  const messageHash   = keccak256(
    encodePacked(
      ["uint64", "bytes32", "bytes32", "bytes32", "bytes32"],
      [p.chainId, sessionIdHash, commitmentsHash, orderBindingHash, ZERO_HASH],
    ),
  );
  const signature = await p.verifierWallet.signMessage({
    account: p.verifierWallet.account!,
    message: { raw: toBytes(messageHash) },
  }) as `0x${string}`;

  return {
    chainId:           p.chainId,
    sessionId,
    commitmentsHash,
    orderBindingHash,
    policyVersionHash: ZERO_HASH,
    verifierSignature: signature,
    revealedItems: [{
      handlerType:      "RECV",
      part:             "BODY",
      value:            kybValue,
      commitment_index: 0n,
      start_item:       0n,
      end_item:         BigInt(kybValue.length),
      start_value:      BigInt(startV),
      end_value:        BigInt(endV),
    }],
    commitmentOpenings: [{ blinderHex: blinder }],
    commitments: [{
      direction: "Recv",
      hashAlg:   "Keccak256",
      hashValue,
    }],
    serverName: p.serverName ?? "kyb.example.com",
  };
}

// ── GMT+8 datetime helper for Alipay ─────────────────────────────────────────

/** Convert Unix UTC timestamp to Alipay's "YYYY-MM-DD HH:MM:SS" (UTC+8) string */
export function toAlipayGmtSuccess(unixUtc: bigint): string {
  const utc8 = Number(unixUtc) + 28800;
  const d = new Date(utc8 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

// ── Alipay proof builders ─────────────────────────────────────────────────────

export interface AlipayFields {
  payAmount:  string;  // e.g. "7.200"
  status:     string;  // "SUCCESS"
  bizType:    string;  // "TRANSFER"
  orderId:    string;  // e.g. "ALI12345"
  gmtSuccess: string;  // "YYYY-MM-DD HH:MM:SS" UTC+8
}

export async function buildAlipayProof(p: {
  fields:           AlipayFields;
  verifierWallet:   WalletClient;
  orderBindingHash: `0x${string}`;
  chainId:          bigint;
  sessionId?:       string;
  serverName:       string;
  // tamper overrides
  overrideCommitmentsHash?:  `0x${string}`;
  overrideCommitments?:      TLSNCommitment[];
  overrideSignature?:        `0x${string}`;
}): Promise<TLSNProof> {
  const fieldValues = [
    `"payAmount":"${p.fields.payAmount}"`,
    `"status":"${p.fields.status}"`,
    `"bizType":"${p.fields.bizType}"`,
    `"orderId":"${p.fields.orderId}"`,
    `"gmtSuccess":"${p.fields.gmtSuccess}"`,
  ];
  return assembleProof({
    fieldValues,
    chainId:          p.chainId,
    sessionId:        p.sessionId ?? nextSession(),
    orderBindingHash: p.orderBindingHash,
    verifierWallet:   p.verifierWallet,
    serverName:       p.serverName,
    overrideCommitmentsHash: p.overrideCommitmentsHash,
    overrideCommitments:     p.overrideCommitments,
    overrideSignature:       p.overrideSignature,
  });
}

/** Build an Alipay proof that is missing one required field */
export async function buildAlipayProofMissingField(p: {
  omit:             keyof AlipayFields;
  verifierWallet:   WalletClient;
  orderBindingHash: `0x${string}`;
  chainId:          bigint;
  sessionId?:       string;
  serverName:       string;
  paymentTime:      bigint;
  payAmount:        string;
}): Promise<TLSNProof> {
  const all: Record<keyof AlipayFields, string> = {
    payAmount:  `"payAmount":"${p.payAmount}"`,
    status:     `"status":"SUCCESS"`,
    bizType:    `"bizType":"TRANSFER"`,
    orderId:    `"orderId":"ALI-MISSING-${Date.now()}"`,
    gmtSuccess: `"gmtSuccess":"${toAlipayGmtSuccess(p.paymentTime)}"`,
  };
  delete (all as Record<string, string>)[p.omit];
  return assembleProof({
    fieldValues:      Object.values(all),
    chainId:          p.chainId,
    sessionId:        p.sessionId ?? nextSession(),
    orderBindingHash: p.orderBindingHash,
    verifierWallet:   p.verifierWallet,
    serverName:       p.serverName,
  });
}

// ── Wise proof builders ───────────────────────────────────────────────────────

/** Wise contacts proof — content is a no-op in _verifyContacts() */
export async function buildWiseContactsProof(p: {
  verifierWallet:   WalletClient;
  orderBindingHash: `0x${string}`;
  chainId:          bigint;
  sessionId?:       string;
  serverName:       string;
  overrideSignature?: `0x${string}`;
}): Promise<TLSNProof> {
  // contacts proof: single placeholder field (no-op on-chain)
  return assembleProof({
    fieldValues:      [`"contacts":"verified"`],
    chainId:          p.chainId,
    sessionId:        p.sessionId ?? nextSession(),
    orderBindingHash: p.orderBindingHash,
    verifierWallet:   p.verifierWallet,
    serverName:       p.serverName,
    overrideSignature: p.overrideSignature,
  });
}

export interface WiseTransferFields {
  state:          string;  // "OUTGOING_PAYMENT_SENT"
  targetAmount:   string;  // "4.500"
  targetCurrency: string;  // "MYR"
  transferId:     bigint;  // 12345678n
  dateMs:         bigint;  // unix_ms
}

export async function buildWiseTransferProof(p: {
  fields:           WiseTransferFields;
  verifierWallet:   WalletClient;
  orderBindingHash: `0x${string}`;
  chainId:          bigint;
  sessionId?:       string;
  serverName:       string;
  overrideCommitmentsHash?: `0x${string}`;
  overrideCommitments?:     TLSNCommitment[];
  overrideSignature?:       `0x${string}`;
}): Promise<TLSNProof> {
  const fieldValues = [
    `"state":"${p.fields.state}"`,
    `"targetAmount":"${p.fields.targetAmount}"`,
    `"targetCurrency":"${p.fields.targetCurrency}"`,
    `"id":${p.fields.transferId.toString()}`,
    `"date":${p.fields.dateMs.toString()}`,
  ];
  return assembleProof({
    fieldValues,
    chainId:          p.chainId,
    sessionId:        p.sessionId ?? nextSession(),
    orderBindingHash: p.orderBindingHash,
    verifierWallet:   p.verifierWallet,
    serverName:       p.serverName,
    overrideCommitmentsHash: p.overrideCommitmentsHash,
    overrideCommitments:     p.overrideCommitments,
    overrideSignature:       p.overrideSignature,
  });
}

/** Wise transfer proof missing one required field */
export async function buildWiseTransferProofMissingField(p: {
  omit:             keyof WiseTransferFields;
  verifierWallet:   WalletClient;
  orderBindingHash: `0x${string}`;
  chainId:          bigint;
  sessionId?:       string;
  serverName:       string;
  dateMs:           bigint;
  targetAmount:     string;
  targetCurrency:   string;
  transferId:       bigint;
}): Promise<TLSNProof> {
  const all: Record<string, string> = {
    state:          `"state":"OUTGOING_PAYMENT_SENT"`,
    targetAmount:   `"targetAmount":"${p.targetAmount}"`,
    targetCurrency: `"targetCurrency":"${p.targetCurrency}"`,
    transferId:     `"id":${p.transferId.toString()}`,
    dateMs:         `"date":${p.dateMs.toString()}`,
  };
  delete all[p.omit];
  return assembleProof({
    fieldValues:      Object.values(all),
    chainId:          p.chainId,
    sessionId:        p.sessionId ?? nextSession(),
    orderBindingHash: p.orderBindingHash,
    verifierWallet:   p.verifierWallet,
    serverName:       p.serverName,
  });
}
