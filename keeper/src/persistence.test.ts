import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Address } from 'viem';
import { applyState, loadState, saveState, type PersistedState } from './persistence.js';
import { Schedule } from './schedule.js';
import { AssetType, makeOrderKey, type ScheduleEntry } from './types.js';

const MERCHANT: Address = '0x1111111111111111111111111111111111111111';

function entry(orderId: bigint, deadline: bigint): ScheduleEntry {
  return {
    orderKey: makeOrderKey(MERCHANT, 0n, AssetType.CRYPTO, orderId),
    merchant: MERCHANT,
    productId: 0n,
    assetType: AssetType.CRYPTO,
    orderId,
    deadline,
  };
}

describe('persistence', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'keeper-persist-'));
    filePath = path.join(dir, 'state.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('saveState + loadState', () => {
    it('round-trips an empty schedule', async () => {
      const ok = await saveState(filePath, new Schedule(), 0n);
      expect(ok).toBe(true);
      const loaded = await loadState(filePath);
      expect(loaded).not.toBeNull();
      expect(loaded!.lastProcessedBlock).toBe('0');
      expect(loaded!.schedule).toEqual([]);
    });

    it('round-trips a populated schedule with deadlines + block', async () => {
      const s = new Schedule();
      s.add(entry(0n, 1000n));
      s.add(entry(1n, 2000n));
      await saveState(filePath, s, 12_345n);
      const loaded = await loadState(filePath);
      const { schedule, lastProcessedBlock } = applyState(loaded!);
      expect(lastProcessedBlock).toBe(12_345n);
      expect(schedule.size()).toBe(2);
      expect(schedule.popDue(100_000n, 0n).map((e) => e.orderId)).toEqual([0n, 1n]);
    });

    it('creates the parent directory if missing', async () => {
      const nested = path.join(dir, 'nested', 'deeper', 'state.json');
      const ok = await saveState(nested, new Schedule(), 0n);
      expect(ok).toBe(true);
      expect((await loadState(nested))!.version).toBe(1);
    });

    it('atomically replaces an existing file (no torn writes)', async () => {
      // First write
      const s1 = new Schedule();
      s1.add(entry(0n, 1000n));
      await saveState(filePath, s1, 1n);
      // Second write with completely different content
      const s2 = new Schedule();
      s2.add(entry(99n, 9999n));
      await saveState(filePath, s2, 2n);
      const loaded = await loadState(filePath);
      expect(loaded!.lastProcessedBlock).toBe('2');
      expect(loaded!.schedule).toHaveLength(1);
      expect(loaded!.schedule[0].orderId).toBe('99');
    });
  });

  describe('loadState — recoverable corruption', () => {
    it('returns null when file is missing', async () => {
      expect(await loadState(filePath)).toBeNull();
    });

    it('returns null on empty file', async () => {
      await writeFile(filePath, '', 'utf8');
      expect(await loadState(filePath)).toBeNull();
    });

    it('returns null on malformed JSON', async () => {
      await writeFile(filePath, '{not json', 'utf8');
      expect(await loadState(filePath)).toBeNull();
    });

    it('returns null on wrong version', async () => {
      const wrongVersion = {
        version: 99,
        lastProcessedBlock: '0',
        schedule: [],
      };
      await writeFile(filePath, JSON.stringify(wrongVersion), 'utf8');
      expect(await loadState(filePath)).toBeNull();
    });

    it('returns null on missing fields', async () => {
      await writeFile(filePath, JSON.stringify({ version: 1 }), 'utf8');
      expect(await loadState(filePath)).toBeNull();
    });

    it('returns null when schedule entry has wrong type', async () => {
      const bad: unknown = {
        version: 1,
        lastProcessedBlock: '0',
        schedule: [
          {
            orderKey: 'x',
            merchant: 'x',
            productId: 'x',
            assetType: 'CRYPTO', // wrong: should be number
            orderId: 'x',
            deadline: 'x',
          },
        ],
      };
      await writeFile(filePath, JSON.stringify(bad), 'utf8');
      expect(await loadState(filePath)).toBeNull();
    });
  });

  describe('schema sanity', () => {
    it('persisted JSON has stringified bigints (no BigInt serialization errors)', async () => {
      const s = new Schedule();
      s.add(entry(0n, 1000n));
      await saveState(filePath, s, 999n);
      const raw = await (await import('node:fs/promises')).readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedState;
      expect(typeof parsed.lastProcessedBlock).toBe('string');
      expect(typeof parsed.schedule[0].deadline).toBe('string');
    });
  });
});
