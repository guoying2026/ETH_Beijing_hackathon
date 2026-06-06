import type { PublicClient, WalletClient } from 'viem';
import { escrowAbi } from './escrowAbi.js';
import { logger } from './logger.js';
import type { ScheduleEntry, SweepTarget } from './types.js';

/**
 * Match popped entries back to the targets in a batch so the tick loop knows
 * which entries to re-queue if the batch fails. Case-insensitive merchant
 * address comparison.
 */
export function mapBatchToEntries(
  batch: ReadonlyArray<{ merchant: string; productId: bigint; assetType: number }>,
  popped: ReadonlyArray<ScheduleEntry>,
): ScheduleEntry[] {
  const keys = new Set(
    batch.map((t) => `${t.merchant.toLowerCase()}:${t.productId}:${t.assetType}`),
  );
  return popped.filter((e) =>
    keys.has(`${e.merchant.toLowerCase()}:${e.productId}:${e.assetType}`),
  );
}

/**
 * Group due entries by (merchant, productId, assetType) and chunk into
 * batches no larger than `maxBatchSize`. Each target's `maxSteps` equals the
 * number of entries in that group — letting the contract clean exactly the
 * orders we observed and stop, so a flood of late expirations on the same
 * product doesn't spike one tx's gas.
 *
 * Pure function. Easy to unit-test.
 */
export function groupAndChunk(entries: ScheduleEntry[], maxBatchSize: number): SweepTarget[][] {
  const grouped = new Map<string, { target: SweepTarget; count: number }>();
  for (const e of entries) {
    const key = `${e.merchant.toLowerCase()}:${e.productId}:${e.assetType}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.count++;
      existing.target.maxSteps = BigInt(existing.count);
    } else {
      grouped.set(key, {
        target: {
          merchant: e.merchant,
          productId: e.productId,
          assetType: e.assetType,
          maxSteps: 1n,
        },
        count: 1,
      });
    }
  }
  const targets = Array.from(grouped.values()).map((g) => g.target);
  const batches: SweepTarget[][] = [];
  for (let i = 0; i < targets.length; i += maxBatchSize) {
    batches.push(targets.slice(i, i + maxBatchSize));
  }
  return batches;
}

/** Optional pre-flight checks before sending a sweep tx. */
export interface SweeperPrecheck {
  /** Returns true if the contract is paused (skip sweep). */
  paused: () => Promise<boolean>;
  /** Returns true if current gas price is above cap (skip sweep). */
  gasPriceOverCap: () => Promise<boolean>;
}

/** Stuck-tx retry parameters. */
export interface RetryOptions {
  /** ms to wait for a receipt before declaring the tx stuck. Default 60_000. */
  receiptTimeoutMs?: number;
  /** Gas multiplier per retry (1.5x default per §5). */
  gasBumpMultiplier?: number;
  /** Hard cap on retry rounds (replace-by-fee). Default 3. */
  maxRetries?: number;
}

/**
 * Send `sweepExpiredBatch(targets)` with **replace-by-fee** retry.
 *
 * Strategy per §5/§6:
 *   1. Simulate to get the encoded request (and check the call would succeed).
 *   2. Snapshot the wallet's pending nonce so retries can re-broadcast at the
 *      same slot — the second tx supersedes the first instead of queueing.
 *   3. Submit with explicit gasPrice = current * gasBumpMultiplier ^ attempt.
 *   4. Wait up to `receiptTimeoutMs` for a receipt; on timeout, bump and retry
 *      up to `maxRetries` times.
 *
 * Returns the totalCleaned value reported on-chain, or `null` on any failure
 * (revert, all retries exhausted, simulation failure). On null, the caller
 * re-queues the entries — contract idempotency makes a late-arriving original
 * tx safe.
 */
export async function sendSweepBatch(
  publicClient: PublicClient,
  walletClient: WalletClient,
  escrowAddress: `0x${string}`,
  targets: SweepTarget[],
  precheck?: SweeperPrecheck,
  retry?: RetryOptions,
): Promise<bigint | null> {
  if (targets.length === 0) return 0n;

  if (precheck) {
    if (await precheck.paused()) {
      logger.warn('Escrow paused — skipping sweep batch');
      return null;
    }
    if (await precheck.gasPriceOverCap()) {
      logger.warn('Gas price above cap — skipping sweep batch');
      return null;
    }
  }

  const receiptTimeoutMs = retry?.receiptTimeoutMs ?? 60_000;
  const gasBump = retry?.gasBumpMultiplier ?? 1.5;
  const maxRetries = retry?.maxRetries ?? 3;

  if (!walletClient.account) {
    logger.error('Wallet client has no account configured');
    return null;
  }
  const account = walletClient.account;

  // 1) Simulate once — gives us the encoded args + a quick revert check.
  let simulationResult: bigint;
  let request: Parameters<WalletClient['writeContract']>[0];
  try {
    const sim = await publicClient.simulateContract({
      address: escrowAddress,
      abi: escrowAbi,
      functionName: 'sweepExpiredBatch',
      args: [targets],
      account,
    });
    simulationResult = sim.result as bigint;
    request = sim.request as typeof request;
  } catch (err) {
    logger.error('sweepExpiredBatch simulation failed:', err);
    return null;
  }

  // 2) Snapshot the pending nonce so each retry uses the same slot.
  let baseNonce: number;
  try {
    baseNonce = await publicClient.getTransactionCount({
      address: account.address,
      blockTag: 'pending',
    });
  } catch (err) {
    logger.error('Failed to read keeper nonce:', err);
    return null;
  }

  // 3) Read initial gas price from the chain.
  let baseGasPrice: bigint;
  try {
    baseGasPrice = await publicClient.getGasPrice();
  } catch (err) {
    logger.error('Failed to read gas price:', err);
    return null;
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const bumpedGasPrice = bumpGas(baseGasPrice, gasBump, attempt);
    let txHash: `0x${string}`;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      txHash = await (walletClient as any).writeContract({
        ...request,
        nonce: baseNonce,
        gasPrice: bumpedGasPrice,
      });
    } catch (err) {
      logger.error(`sweepExpiredBatch send (attempt ${attempt}) failed:`, err);
      return null;
    }
    logger.info(
      `sweepExpiredBatch sent attempt=${attempt} nonce=${baseNonce} ` +
        `gasPrice=${bumpedGasPrice} tx=${txHash}`,
    );
    const receipt = await waitForReceiptWithTimeout(publicClient, txHash, receiptTimeoutMs);
    if (receipt) {
      if (receipt.status !== 'success') {
        logger.error(`sweepExpiredBatch tx ${txHash} reverted`);
        return null;
      }
      logger.info(
        `sweepExpiredBatch ok: targets=${targets.length} ` +
          `cleaned=${simulationResult} tx=${txHash}`,
      );
      return simulationResult;
    }
    logger.warn(
      `sweepExpiredBatch tx ${txHash} not mined within ${receiptTimeoutMs}ms — replacing-by-fee`,
    );
  }
  logger.error(`sweepExpiredBatch exhausted ${maxRetries} retries — giving up`);
  return null;
}

/** Multiply a gas price by `multiplier ^ exponent`, rounded to nearest wei. */
export function bumpGas(base: bigint, multiplier: number, exponent: number): bigint {
  if (exponent <= 0) return base;
  const factor = Math.round(Math.pow(multiplier, exponent) * 1_000_000);
  return (base * BigInt(factor)) / 1_000_000n;
}

/** Resolves to the receipt or `null` on timeout. Never rejects. */
async function waitForReceiptWithTimeout(
  publicClient: PublicClient,
  hash: `0x${string}`,
  timeoutMs: number,
): Promise<Awaited<ReturnType<PublicClient['waitForTransactionReceipt']>> | null> {
  let cancelTimer: (() => void) | undefined;
  const timeoutPromise = new Promise<null>((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    cancelTimer = () => clearTimeout(t);
  });
  try {
    return await Promise.race([
      publicClient.waitForTransactionReceipt({ hash }).catch((err) => {
        logger.debug('waitForTransactionReceipt threw, treating as timeout:', err);
        return null;
      }),
      timeoutPromise,
    ]);
  } finally {
    cancelTimer?.();
  }
}

/**
 * Build a precheck bundle from a viem PublicClient. Reads `paused()` from
 * the escrow and the current gas price; both wrapped in try/catch so a
 * transient RPC failure surfaces as "skip this tick" rather than a crash.
 */
export function makePrecheck(
  publicClient: PublicClient,
  escrowAddress: `0x${string}`,
  gasPriceCapWei: bigint,
): SweeperPrecheck {
  return {
    paused: async () => {
      try {
        return (await publicClient.readContract({
          address: escrowAddress,
          abi: escrowAbi,
          functionName: 'paused',
        })) as boolean;
      } catch (err) {
        logger.warn('paused() read failed, assuming paused for safety:', err);
        return true;
      }
    },
    gasPriceOverCap: async () => {
      try {
        const price = await publicClient.getGasPrice();
        return price > gasPriceCapWei;
      } catch (err) {
        logger.warn('getGasPrice failed, assuming over cap for safety:', err);
        return true;
      }
    },
  };
}
