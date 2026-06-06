import type { Address, PublicClient } from 'viem';
import { escrowAbi } from './escrowAbi.js';
import { handleOrderPlaced, handleOrderStatusChanged } from './eventListener.js';
import { logger } from './logger.js';
import type { Schedule } from './schedule.js';

/**
 * Number of blocks per `getContractEvents` call. Most public RPCs cap log
 * range queries at 10k blocks; staying under that with a comfortable margin
 * works against Alchemy, Infura, and a local hardhat node alike.
 */
const REPLAY_CHUNK_SIZE = 5_000n;

export interface ReplayResult {
  /** Highest block consumed by the replay (= toBlock when complete). */
  upToBlock: bigint;
  placedCount: number;
  statusCount: number;
}

/**
 * Catch the schedule up by streaming `OrderPlaced` + `OrderStatusChanged`
 * events from `fromBlock` through the current head. Applied via the same
 * pure handlers the live WS watcher uses, so the schedule end-state matches.
 */
export async function replayEvents(
  publicClient: PublicClient,
  escrowAddress: Address,
  schedule: Schedule,
  fromBlock: bigint,
): Promise<ReplayResult> {
  const head = await publicClient.getBlockNumber();
  if (fromBlock > head) {
    logger.info(`Replay no-op: fromBlock=${fromBlock} > head=${head}`);
    return { upToBlock: head, placedCount: 0, statusCount: 0 };
  }
  logger.info(`Replay: scanning [${fromBlock}, ${head}] (${head - fromBlock + 1n} blocks)`);

  let placedCount = 0;
  let statusCount = 0;
  let cursor = fromBlock;

  while (cursor <= head) {
    const toBlock = cursor + REPLAY_CHUNK_SIZE - 1n < head ? cursor + REPLAY_CHUNK_SIZE - 1n : head;
    const [placedLogs, statusLogs] = await Promise.all([
      publicClient.getContractEvents({
        address: escrowAddress,
        abi: escrowAbi,
        eventName: 'OrderPlaced',
        fromBlock: cursor,
        toBlock,
      }),
      publicClient.getContractEvents({
        address: escrowAddress,
        abi: escrowAbi,
        eventName: 'OrderStatusChanged',
        fromBlock: cursor,
        toBlock,
      }),
    ]);

    // Sort by (blockNumber, logIndex) so a status change for an order that
    // was placed and finalized in the same chunk gets the correct net effect.
    type Tagged =
      | { kind: 'placed'; log: (typeof placedLogs)[number] }
      | { kind: 'status'; log: (typeof statusLogs)[number] };
    const merged: Tagged[] = [
      ...placedLogs.map((log) => ({ kind: 'placed' as const, log })),
      ...statusLogs.map((log) => ({ kind: 'status' as const, log })),
    ];
    merged.sort((a, b) => {
      const da = (a.log.blockNumber ?? 0n) - (b.log.blockNumber ?? 0n);
      if (da !== 0n) return da < 0n ? -1 : 1;
      return (a.log.logIndex ?? 0) - (b.log.logIndex ?? 0);
    });

    for (const m of merged) {
      if (m.kind === 'placed') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handleOrderPlaced(schedule, m.log.args as any);
        placedCount++;
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handleOrderStatusChanged(schedule, m.log.args as any);
        statusCount++;
      }
    }
    cursor = toBlock + 1n;
  }

  logger.info(
    `Replay done: placed=${placedCount} statusChanged=${statusCount} ` +
      `scheduleSize=${schedule.size()}`,
  );
  return { upToBlock: head, placedCount, statusCount };
}
