import { describe, expect, it } from 'vitest';
import { handleOrderPlaced, handleOrderStatusChanged } from './eventListener.js';
import { Schedule } from './schedule.js';
import { AssetType, makeOrderKey } from './types.js';

const MERCHANT = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const BUYER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;

function placedArgs(orderId: bigint, deadline: bigint, productId = 0n, assetType = 0) {
  return {
    buyer: BUYER,
    merchant: MERCHANT,
    orderId,
    productId,
    assetType,
    amount: 1n,
    rate: 1n,
    deadline,
    salt: 0n,
  };
}

function statusArgs(orderId: bigint, status: number, productId = 0n, assetType = 0) {
  return {
    buyer: BUYER,
    merchant: MERCHANT,
    orderId,
    productId,
    assetType,
    status,
    deadline: 0n,
  };
}

describe('eventListener — handleOrderPlaced', () => {
  it('inserts a new entry into the schedule', () => {
    const s = new Schedule();
    expect(handleOrderPlaced(s, placedArgs(0n, 1234n))).toBe(true);
    expect(s.size()).toBe(1);
    expect(s.get(makeOrderKey(MERCHANT, 0n, AssetType.CRYPTO, 0n))?.deadline).toBe(1234n);
  });

  it('returns false on duplicate (re-emitted) event', () => {
    const s = new Schedule();
    handleOrderPlaced(s, placedArgs(0n, 1234n));
    expect(handleOrderPlaced(s, placedArgs(0n, 1234n))).toBe(false);
    expect(s.size()).toBe(1);
  });

  it('handles FIAT (assetType=1) and CRYPTO (assetType=0) independently', () => {
    const s = new Schedule();
    handleOrderPlaced(s, placedArgs(0n, 100n, 0n, 0));
    handleOrderPlaced(s, placedArgs(0n, 200n, 0n, 1));
    expect(s.size()).toBe(2);
  });

  it('returns false and does not throw on malformed args', () => {
    const s = new Schedule();
    expect(handleOrderPlaced(s, { merchant: MERCHANT } as never)).toBe(false);
    expect(s.size()).toBe(0);
  });
});

describe('eventListener — handleOrderStatusChanged', () => {
  it('evicts entry on EXPIRED (status=1)', () => {
    const s = new Schedule();
    handleOrderPlaced(s, placedArgs(0n, 1234n));
    expect(handleOrderStatusChanged(s, statusArgs(0n, 1))).toBe(true);
    expect(s.size()).toBe(0);
  });

  it('evicts entry on COMPLETED (status=2)', () => {
    const s = new Schedule();
    handleOrderPlaced(s, placedArgs(0n, 1234n));
    expect(handleOrderStatusChanged(s, statusArgs(0n, 2))).toBe(true);
    expect(s.size()).toBe(0);
  });

  it('does not evict on PENDING (status=0) re-emit', () => {
    const s = new Schedule();
    handleOrderPlaced(s, placedArgs(0n, 1234n));
    expect(handleOrderStatusChanged(s, statusArgs(0n, 0))).toBe(false);
    expect(s.size()).toBe(1);
  });

  it('does not evict on WAITING (status=3) re-emit', () => {
    const s = new Schedule();
    handleOrderPlaced(s, placedArgs(0n, 1234n));
    expect(handleOrderStatusChanged(s, statusArgs(0n, 3))).toBe(false);
    expect(s.size()).toBe(1);
  });

  it('returns false (not-tracked) when no matching entry exists', () => {
    const s = new Schedule();
    expect(handleOrderStatusChanged(s, statusArgs(999n, 1))).toBe(false);
  });
});
