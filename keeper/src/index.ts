import { loadConfig, type KeeperConfig } from './config.js';
import { initLogger, logger } from './logger.js';
import { makeClients, type ChainClients } from './chain.js';
import { Schedule } from './schedule.js';
import { watchEscrowEvents } from './eventListener.js';
import {
  groupAndChunk,
  makePrecheck,
  mapBatchToEntries,
  sendSweepBatch,
  type SweeperPrecheck,
} from './sweeper.js';
import { applyState, loadState, saveState } from './persistence.js';
import { replayEvents } from './replay.js';
import { startHealthServer, type HealthSnapshot } from './health.js';

const SAVE_STATE_INTERVAL_MS = 60_000;

/**
 * Stage 5 entry point. Lifecycle:
 *   1. load config + init logger
 *   2. make viem clients
 *   3. load persisted state (or start fresh from cfg.deploymentBlock)
 *   4. replay [lastProcessedBlock, head] to catch up the schedule
 *   5. start WS event watcher
 *   6. start health endpoint
 *   7. start the periodic tick (poll + sweep)
 *   8. start the periodic save (atomic JSON snapshot)
 *   9. on SIGINT/SIGTERM: flush state, close server, exit
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  initLogger(cfg);
  const escrowOrigin =
    cfg.escrowSource === 'env' ? 'env(ESCROW_ADDRESS)' : `file(${cfg.deploymentsFile ?? '?'})`;
  logger.info(
    `Keeper[${cfg.label}] starting — chainId=${cfg.chainId} escrow=${cfg.escrowAddress} ` +
      `[from ${escrowOrigin}] deploymentBlock=${cfg.deploymentBlock} ` +
      `poll=${cfg.pollIntervalMs}ms grace=${cfg.gracePeriodSeconds}s batch<=${cfg.maxBatchSize}`,
  );

  const clients = makeClients(cfg);
  logger.info(`Keeper account: ${clients.keeperAddress}`);

  // ── Load persisted state (or first-run defaults) ────────────────────────
  const persisted = await loadState(cfg.stateFilePath);
  let schedule: Schedule;
  let lastProcessedBlock: bigint;
  if (persisted) {
    ({ schedule, lastProcessedBlock } = applyState(persisted));
    logger.info(
      `Loaded state: scheduleSize=${schedule.size()} lastProcessedBlock=${lastProcessedBlock}`,
    );
  } else {
    schedule = new Schedule();
    lastProcessedBlock = cfg.deploymentBlock;
    logger.info(`Fresh start: lastProcessedBlock=${lastProcessedBlock}`);
  }

  // ── Replay missed events ────────────────────────────────────────────────
  // We replay [lastProcessedBlock+1, head] so we don't double-count events
  // that were already applied before the snapshot. For the very first run
  // (cfg.deploymentBlock = 0), this scans the full chain.
  let replayFromBlock = persisted ? lastProcessedBlock + 1n : lastProcessedBlock;
  if (replayFromBlock < 0n) replayFromBlock = 0n;
  const replayResult = await replayEvents(
    clients.publicClient,
    cfg.escrowAddress,
    schedule,
    replayFromBlock,
  );
  lastProcessedBlock = replayResult.upToBlock;

  // ── WS event subscription (head onwards) ────────────────────────────────
  const unwatch = watchEscrowEvents(clients.wsClient, cfg.escrowAddress, schedule);

  // ── Health endpoint ─────────────────────────────────────────────────────
  const state: MutableState = {
    lastTickAt: null,
    lastBalanceWei: 0n,
    lowBalance: false,
    lastProcessedBlock,
  };
  const healthServer = startHealthServer(cfg.healthPort, () =>
    buildSnapshot(clients, schedule, state),
  );

  // ── Tick (poll + sweep) ─────────────────────────────────────────────────
  const precheck = makePrecheck(clients.publicClient, cfg.escrowAddress, cfg.gasPriceCapWei);
  let tickInFlight = false;
  const tickTimer = setInterval(() => {
    if (tickInFlight) return;
    tickInFlight = true;
    runTick(schedule, cfg, clients, precheck, state)
      .catch((err) => logger.error('Tick failed:', err))
      .finally(() => {
        tickInFlight = false;
      });
  }, cfg.pollIntervalMs);

  // ── Periodic state save (every 60s) ─────────────────────────────────────
  const saveTimer = setInterval(() => {
    void saveState(cfg.stateFilePath, schedule, state.lastProcessedBlock);
  }, SAVE_STATE_INTERVAL_MS);

  // ── Graceful shutdown ───────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, flushing state and shutting down`);
    clearInterval(tickTimer);
    clearInterval(saveTimer);
    unwatch();
    await saveState(cfg.stateFilePath, schedule, state.lastProcessedBlock);
    await new Promise<void>((resolve) => healthServer.close(() => resolve()));
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/** Mutable runtime state that's read by the health endpoint provider. */
interface MutableState {
  lastTickAt: Date | null;
  lastBalanceWei: bigint;
  lowBalance: boolean;
  lastProcessedBlock: bigint;
}

function buildSnapshot(
  clients: ChainClients,
  schedule: Schedule,
  state: MutableState,
): HealthSnapshot {
  const ok = !state.lowBalance && state.lastTickAt !== null;
  return {
    status: ok ? 'ok' : 'degraded',
    scheduleSize: schedule.size(),
    lastProcessedBlock: state.lastProcessedBlock.toString(),
    keeperAddress: clients.keeperAddress,
    balanceWei: state.lastBalanceWei.toString(),
    lowBalance: state.lowBalance,
    lastTickAt: state.lastTickAt ? state.lastTickAt.toISOString() : null,
  };
}

/**
 * One keeper tick. In addition to the §4 sweep flow this also:
 *   - polls the wallet balance and trips `lowBalance` if under threshold
 *   - advances `state.lastProcessedBlock` to the latest head so snapshots
 *     written between ticks resume correctly after a crash
 */
async function runTick(
  schedule: Schedule,
  cfg: KeeperConfig,
  clients: ChainClients,
  precheck: SweeperPrecheck,
  state: MutableState,
): Promise<void> {
  // Balance monitor — never let RPC failure kill the tick.
  try {
    const balance = await clients.publicClient.getBalance({ address: clients.keeperAddress });
    state.lastBalanceWei = balance;
    const wasLow = state.lowBalance;
    state.lowBalance = balance < cfg.lowBalanceThresholdWei;
    if (state.lowBalance && !wasLow) {
      logger.warn(`Keeper balance below threshold: ${balance} wei < ${cfg.lowBalanceThresholdWei}`);
    }
  } catch (err) {
    logger.warn('Balance read failed:', err);
  }

  // Use chain time (latest block.timestamp) rather than wall clock so the
  // keeper's view of "now" matches what `_cleanupExpired` checks on-chain
  // (`o.deadline > block.timestamp`). On a live chain these track within
  // seconds; in tests this lets `evm_increaseTime` advance the keeper's
  // expiry view without depending on real elapsed time.
  let nowSec: bigint;
  try {
    const head = await clients.publicClient.getBlock();
    if (head.number !== null && head.number > state.lastProcessedBlock) {
      state.lastProcessedBlock = head.number;
    }
    nowSec = head.timestamp;
  } catch (err) {
    logger.debug('getBlock failed, falling back to wall clock:', err);
    nowSec = BigInt(Math.floor(Date.now() / 1000));
  }

  state.lastTickAt = new Date();

  const due = schedule.popDue(nowSec, BigInt(cfg.gracePeriodSeconds));
  if (due.length === 0) return;

  logger.info(`Tick: ${due.length} due entries`);
  const batches = groupAndChunk(due, cfg.maxBatchSize);
  for (const batch of batches) {
    const batchEntries = mapBatchToEntries(batch, due);
    const cleaned = await sendSweepBatch(
      clients.publicClient,
      clients.walletClient,
      cfg.escrowAddress,
      batch,
      precheck,
    );
    if (cleaned === null) {
      for (const e of batchEntries) schedule.add(e);
    }
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
