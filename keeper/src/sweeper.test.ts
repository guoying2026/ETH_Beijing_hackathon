import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { bumpGas, groupAndChunk, mapBatchToEntries } from './sweeper.js';
import { AssetType, makeOrderKey, type ScheduleEntry } from './types.js';

const MA: Address = '0x1111111111111111111111111111111111111111';
const MB: Address = '0x2222222222222222222222222222222222222222';

function entry(
  merchant: Address,
  productId: bigint,
  assetType: AssetType,
  orderId: bigint,
  deadline = 0n,
): ScheduleEntry {
  return {
    orderKey: makeOrderKey(merchant, productId, assetType, orderId),
    merchant,
    productId,
    assetType,
    orderId,
    deadline,
  };
}

describe('sweeper — groupAndChunk', () => {
  it('returns no batches for empty input', () => {
    expect(groupAndChunk([], 20)).toEqual([]);
  });

  it('groups entries with same (merchant, productId, assetType)', () => {
    const entries = [
      entry(MA, 0n, AssetType.CRYPTO, 0n),
      entry(MA, 0n, AssetType.CRYPTO, 1n),
      entry(MA, 0n, AssetType.CRYPTO, 2n),
    ];
    const batches = groupAndChunk(entries, 20);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(batches[0][0].maxSteps).toBe(3n);
  });

  it('separates groups by productId', () => {
    const entries = [entry(MA, 0n, AssetType.CRYPTO, 0n), entry(MA, 1n, AssetType.CRYPTO, 0n)];
    const batches = groupAndChunk(entries, 20);
    expect(batches[0]).toHaveLength(2);
    expect(batches[0].map((t) => t.productId).sort()).toEqual([0n, 1n]);
  });

  it('separates groups by assetType', () => {
    const entries = [entry(MA, 0n, AssetType.CRYPTO, 0n), entry(MA, 0n, AssetType.FIAT, 0n)];
    const batches = groupAndChunk(entries, 20);
    expect(batches[0]).toHaveLength(2);
    expect(batches[0].map((t) => t.assetType).sort()).toEqual([0, 1]);
  });

  it('separates groups by merchant', () => {
    const entries = [entry(MA, 0n, AssetType.CRYPTO, 0n), entry(MB, 0n, AssetType.CRYPTO, 0n)];
    const batches = groupAndChunk(entries, 20);
    expect(batches[0]).toHaveLength(2);
  });

  it('chunks targets when group count exceeds maxBatchSize', () => {
    // 25 distinct (merchant, productId, assetType) groups → 2 batches of 20 + 5
    const entries: ScheduleEntry[] = [];
    for (let i = 0; i < 25; i++) {
      entries.push(entry(MA, BigInt(i), AssetType.CRYPTO, 0n));
    }
    const batches = groupAndChunk(entries, 20);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(20);
    expect(batches[1]).toHaveLength(5);
  });

  it('maxSteps equals the number of entries in the group', () => {
    const entries: ScheduleEntry[] = [];
    for (let i = 0; i < 7; i++) {
      entries.push(entry(MA, 0n, AssetType.CRYPTO, BigInt(i)));
    }
    const batches = groupAndChunk(entries, 20);
    expect(batches[0][0].maxSteps).toBe(7n);
  });

  it('respects MAX_SWEEP_BATCH=20 by default config', () => {
    const entries: ScheduleEntry[] = [];
    for (let i = 0; i < 21; i++) {
      entries.push(entry(MA, BigInt(i), AssetType.CRYPTO, 0n));
    }
    const batches = groupAndChunk(entries, 20);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(20);
    expect(batches[1]).toHaveLength(1);
  });
});

describe('bumpGas (replace-by-fee math)', () => {
  it('returns base when exponent is 0', () => {
    expect(bumpGas(100_000_000_000n, 1.5, 0)).toBe(100_000_000_000n);
  });

  it('multiplies by 1.5 once at exponent=1', () => {
    expect(bumpGas(100_000_000_000n, 1.5, 1)).toBe(150_000_000_000n);
  });

  it('compounds — 1.5^2 = 2.25', () => {
    expect(bumpGas(100_000_000_000n, 1.5, 2)).toBe(225_000_000_000n);
  });

  it('handles zero base', () => {
    expect(bumpGas(0n, 1.5, 5)).toBe(0n);
  });
});

describe('mapBatchToEntries (re-queue helper)', () => {
  it('returns entries belonging to the batch', () => {
    const popped = [
      entry(MA, 0n, AssetType.CRYPTO, 0n),
      entry(MA, 0n, AssetType.CRYPTO, 1n),
      entry(MB, 0n, AssetType.CRYPTO, 0n),
    ];
    const batch = [{ merchant: MA, productId: 0n, assetType: 0 }];
    const re = mapBatchToEntries(batch, popped);
    expect(re).toHaveLength(2);
    expect(re.map((e) => e.orderKey)).toContain(popped[0].orderKey);
    expect(re.map((e) => e.orderKey)).toContain(popped[1].orderKey);
  });

  it('case-insensitive merchant address match', () => {
    const popped = [entry(MA, 0n, AssetType.CRYPTO, 0n)];
    const batch = [{ merchant: MA.toUpperCase(), productId: 0n, assetType: 0 }];
    expect(mapBatchToEntries(batch, popped)).toHaveLength(1);
  });
});
