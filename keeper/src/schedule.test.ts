import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { Schedule } from './schedule.js';
import { AssetType, makeOrderKey, type ScheduleEntry } from './types.js';

const MERCHANT_A: Address = '0x1111111111111111111111111111111111111111';
const MERCHANT_B: Address = '0x2222222222222222222222222222222222222222';

function entry(
  merchant: Address,
  productId: bigint,
  assetType: AssetType,
  orderId: bigint,
  deadline: bigint,
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

describe('Schedule', () => {
  describe('add / remove / get', () => {
    it('add() returns true for new key, false on update', () => {
      const s = new Schedule();
      const e = entry(MERCHANT_A, 0n, AssetType.CRYPTO, 0n, 1000n);
      expect(s.add(e)).toBe(true);
      expect(s.add(e)).toBe(false);
      expect(s.size()).toBe(1);
    });

    it('remove() returns true only when present', () => {
      const s = new Schedule();
      const e = entry(MERCHANT_A, 0n, AssetType.CRYPTO, 0n, 1000n);
      expect(s.remove(e.orderKey)).toBe(false);
      s.add(e);
      expect(s.remove(e.orderKey)).toBe(true);
      expect(s.size()).toBe(0);
    });

    it('get() returns the live entry or undefined', () => {
      const s = new Schedule();
      const e = entry(MERCHANT_A, 0n, AssetType.CRYPTO, 0n, 1000n);
      expect(s.get(e.orderKey)).toBeUndefined();
      s.add(e);
      expect(s.get(e.orderKey)).toEqual(e);
    });
  });

  describe('dedup', () => {
    it('updating an entry replaces its deadline', () => {
      const s = new Schedule();
      const e1 = entry(MERCHANT_A, 0n, AssetType.CRYPTO, 0n, 1000n);
      const e2 = { ...e1, deadline: 500n };
      s.add(e1);
      s.add(e2);
      expect(s.size()).toBe(1);
      expect(s.get(e1.orderKey)?.deadline).toBe(500n);
    });

    it('two different keys are tracked independently', () => {
      const s = new Schedule();
      s.add(entry(MERCHANT_A, 0n, AssetType.CRYPTO, 0n, 1000n));
      s.add(entry(MERCHANT_B, 0n, AssetType.CRYPTO, 0n, 1000n));
      expect(s.size()).toBe(2);
    });
  });

  describe('heap order (popDue)', () => {
    it('pops nothing when deadline + grace exceeds now', () => {
      const s = new Schedule();
      s.add(entry(MERCHANT_A, 0n, AssetType.CRYPTO, 0n, 1000n));
      expect(s.popDue(900n, 30n)).toEqual([]);
      expect(s.size()).toBe(1);
    });

    it('pops in earliest-deadline-first order', () => {
      const s = new Schedule();
      s.add(entry(MERCHANT_A, 0n, AssetType.CRYPTO, 2n, 300n));
      s.add(entry(MERCHANT_A, 0n, AssetType.CRYPTO, 0n, 100n));
      s.add(entry(MERCHANT_A, 0n, AssetType.CRYPTO, 1n, 200n));
      const due = s.popDue(1000n, 0n);
      expect(due.map((e) => e.orderId)).toEqual([0n, 1n, 2n]);
      expect(s.size()).toBe(0);
    });

    it('respects grace period (deadline + grace must be <= now)', () => {
      const s = new Schedule();
      s.add(entry(MERCHANT_A, 0n, AssetType.CRYPTO, 0n, 100n));
      // deadline=100, grace=30, exact boundary now=130 — should pop
      expect(s.popDue(130n, 30n)).toHaveLength(1);
      s.add(entry(MERCHANT_A, 0n, AssetType.CRYPTO, 1n, 200n));
      expect(s.popDue(229n, 30n)).toHaveLength(0); // 200+30=230, now=229
    });

    it('skips stale heap slots after remove', () => {
      const s = new Schedule();
      const e1 = entry(MERCHANT_A, 0n, AssetType.CRYPTO, 0n, 100n);
      const e2 = entry(MERCHANT_A, 0n, AssetType.CRYPTO, 1n, 200n);
      s.add(e1);
      s.add(e2);
      s.remove(e1.orderKey);
      const due = s.popDue(1000n, 0n);
      expect(due.map((e) => e.orderId)).toEqual([1n]);
    });

    it('update before pop reflects new deadline', () => {
      const s = new Schedule();
      const e1 = entry(MERCHANT_A, 0n, AssetType.CRYPTO, 0n, 1000n);
      s.add(e1);
      s.add({ ...e1, deadline: 50n });
      expect(s.popDue(100n, 0n)).toHaveLength(1);
    });
  });

  describe('peekDeadline', () => {
    it('returns undefined when empty', () => {
      expect(new Schedule().peekDeadline()).toBeUndefined();
    });

    it('returns earliest deadline ignoring stale slots', () => {
      const s = new Schedule();
      const e1 = entry(MERCHANT_A, 0n, AssetType.CRYPTO, 0n, 100n);
      const e2 = entry(MERCHANT_A, 0n, AssetType.CRYPTO, 1n, 200n);
      s.add(e1);
      s.add(e2);
      s.remove(e1.orderKey);
      expect(s.peekDeadline()).toBe(200n);
    });
  });

  describe('serialization', () => {
    it('serialize -> fromSerialized round-trips', () => {
      const s = new Schedule();
      s.add(entry(MERCHANT_A, 3n, AssetType.FIAT, 5n, 1234n));
      s.add(entry(MERCHANT_B, 0n, AssetType.CRYPTO, 0n, 5678n));
      const snap = s.serialize();
      const restored = Schedule.fromSerialized(snap);
      expect(restored.size()).toBe(2);
      expect(
        restored
          .popDue(10_000n, 0n)
          .map((e) => e.orderKey)
          .sort(),
      ).toEqual(
        s
          .toArray()
          .map((e) => e.orderKey)
          .sort(),
      );
    });

    it('serialized entries have stringified bigints (JSON-safe)', () => {
      const s = new Schedule();
      s.add(entry(MERCHANT_A, 0n, AssetType.CRYPTO, 0n, 1000n));
      const snap = s.serialize();
      expect(typeof snap[0].productId).toBe('string');
      expect(typeof snap[0].deadline).toBe('string');
      // Must survive JSON.stringify without "Do not know how to serialize a BigInt"
      expect(() => JSON.stringify(snap)).not.toThrow();
    });
  });
});
