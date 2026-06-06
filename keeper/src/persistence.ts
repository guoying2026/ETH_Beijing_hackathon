import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';
import { Schedule, type SerializedEntry } from './schedule.js';

/** On-disk snapshot schema. `version` lets us migrate later. */
export interface PersistedState {
  version: 1;
  lastProcessedBlock: string; // bigint stringified
  schedule: SerializedEntry[];
}

const CURRENT_VERSION = 1 as const;

/**
 * Load `state.json`. Returns:
 *   - parsed state on a clean read
 *   - null if the file is missing, empty, malformed, or carries an unknown
 *     version — caller treats that as "first run, rebuild from chain"
 *
 * Never throws: corruption is a recoverable condition by design.
 */
export async function loadState(filePath: string): Promise<PersistedState | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      logger.info(`State file ${filePath} not found, starting fresh`);
      return null;
    }
    logger.warn(`Failed to read state file ${filePath}, starting fresh:`, err);
    return null;
  }
  if (raw.trim() === '') {
    logger.warn(`State file ${filePath} is empty, starting fresh`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn(`State file ${filePath} not valid JSON, starting fresh:`, err);
    return null;
  }
  if (!isPersistedState(parsed)) {
    logger.warn(`State file ${filePath} schema invalid, starting fresh`);
    return null;
  }
  return parsed;
}

/** Hydrate a Schedule + lastProcessedBlock from a loaded snapshot. */
export function applyState(state: PersistedState): {
  schedule: Schedule;
  lastProcessedBlock: bigint;
} {
  return {
    schedule: Schedule.fromSerialized(state.schedule),
    lastProcessedBlock: BigInt(state.lastProcessedBlock),
  };
}

/**
 * Atomically persist state to disk. Strategy:
 *   1. ensure parent dir exists
 *   2. write to `<path>.tmp`
 *   3. fsync data + close
 *   4. `rename(.tmp -> path)` — atomic on POSIX, best-effort on Windows
 *
 * Any error is logged but not thrown so a transient disk issue doesn't crash
 * the keeper — the next save attempt (every ~60s) will retry.
 */
export async function saveState(
  filePath: string,
  schedule: Schedule,
  lastProcessedBlock: bigint,
): Promise<boolean> {
  const dir = path.dirname(filePath);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    logger.error(`Failed to mkdir ${dir}:`, err);
    return false;
  }
  const state: PersistedState = {
    version: CURRENT_VERSION,
    lastProcessedBlock: lastProcessedBlock.toString(),
    schedule: schedule.serialize(),
  };
  const tmp = `${filePath}.tmp`;
  try {
    const handle = await fs.open(tmp, 'w');
    try {
      await handle.writeFile(JSON.stringify(state, null, 2), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, filePath);
    return true;
  } catch (err) {
    logger.error(`Failed to save state to ${filePath}:`, err);
    // Clean up the partial tmp file; ignore failures.
    try {
      await fs.unlink(tmp);
    } catch {
      /* noop */
    }
    return false;
  }
}

// ── Type guards ─────────────────────────────────────────────────────────────

function isPersistedState(v: unknown): v is PersistedState {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.version !== CURRENT_VERSION) return false;
  if (typeof o.lastProcessedBlock !== 'string') return false;
  if (!Array.isArray(o.schedule)) return false;
  return o.schedule.every(isSerializedEntry);
}

function isSerializedEntry(v: unknown): v is SerializedEntry {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.orderKey === 'string' &&
    typeof o.merchant === 'string' &&
    typeof o.productId === 'string' &&
    typeof o.assetType === 'number' &&
    typeof o.orderId === 'string' &&
    typeof o.deadline === 'string'
  );
}
