import type { Address, Log, PublicClient } from 'viem';
import { escrowAbi } from './escrowAbi.js';
import { logger } from './logger.js';
import type { Schedule } from './schedule.js';
import { AssetType, makeOrderKey } from './types.js';

/**
 * Terminal OrderStatus values that mean the order is no longer pending — once
 * observed, the schedule entry should be evicted.
 *   PENDING = 0, EXPIRED = 1, COMPLETED = 2, WAITING = 3
 */
const TERMINAL_STATUSES = new Set<number>([1 /* EXPIRED */, 2 /* COMPLETED */]);

/** Decoded log shape after viem matches the ABI event signature. */
interface OrderPlacedArgs {
  buyer?: Address;
  merchant?: Address;
  orderId?: bigint;
  productId?: bigint;
  assetType?: number;
  amount?: bigint;
  rate?: bigint;
  deadline?: bigint;
  salt?: bigint;
}

interface OrderStatusChangedArgs {
  buyer?: Address;
  merchant?: Address;
  orderId?: bigint;
  productId?: bigint;
  assetType?: number;
  status?: number;
  deadline?: bigint;
}

/**
 * Apply a single OrderPlaced log: insert/refresh a ScheduleEntry.
 * Exported (and free of any client dependency) so unit tests can drive it
 * directly with synthetic logs.
 */
export function handleOrderPlaced(schedule: Schedule, args: OrderPlacedArgs): boolean {
  if (
    !args.merchant ||
    args.orderId === undefined ||
    args.productId === undefined ||
    args.assetType === undefined ||
    args.deadline === undefined
  ) {
    logger.warn('OrderPlaced log missing fields, skipping', args);
    return false;
  }
  const assetType = args.assetType as AssetType;
  const orderKey = makeOrderKey(args.merchant, args.productId, assetType, args.orderId);
  const isNew = schedule.add({
    orderKey,
    merchant: args.merchant,
    productId: args.productId,
    assetType,
    orderId: args.orderId,
    deadline: args.deadline,
  });
  logger.debug(`OrderPlaced ${orderKey} deadline=${args.deadline} (${isNew ? 'new' : 'updated'})`);
  return isNew;
}

/**
 * Apply a single OrderStatusChanged log: evict the entry once status leaves
 * PENDING/WAITING (i.e. EXPIRED or COMPLETED). Re-emits of PENDING/WAITING
 * (which the contract does on placement) are no-ops here because the
 * OrderPlaced handler is authoritative for insertion.
 */
export function handleOrderStatusChanged(
  schedule: Schedule,
  args: OrderStatusChangedArgs,
): boolean {
  if (
    !args.merchant ||
    args.orderId === undefined ||
    args.productId === undefined ||
    args.assetType === undefined ||
    args.status === undefined
  ) {
    logger.warn('OrderStatusChanged log missing fields, skipping', args);
    return false;
  }
  if (!TERMINAL_STATUSES.has(args.status)) return false;
  const orderKey = makeOrderKey(
    args.merchant,
    args.productId,
    args.assetType as AssetType,
    args.orderId,
  );
  const removed = schedule.remove(orderKey);
  logger.debug(
    `OrderStatusChanged ${orderKey} status=${args.status} (${removed ? 'removed' : 'not-tracked'})`,
  );
  return removed;
}

/**
 * Subscribe to OrderPlaced + OrderStatusChanged via the WS client.
 * Returns an unwatch function. Errors from the watcher are logged but do not
 * crash the keeper (viem auto-reconnects WS by default).
 */
export function watchEscrowEvents(
  wsClient: PublicClient,
  escrowAddress: Address,
  schedule: Schedule,
): () => void {
  const unwatchPlaced = wsClient.watchContractEvent({
    address: escrowAddress,
    abi: escrowAbi,
    eventName: 'OrderPlaced',
    onLogs: (logs) => {
      for (const log of logs as Array<Log & { args: OrderPlacedArgs }>) {
        handleOrderPlaced(schedule, log.args);
      }
    },
    onError: (err) => logger.error('OrderPlaced watcher error:', err),
  });

  const unwatchStatus = wsClient.watchContractEvent({
    address: escrowAddress,
    abi: escrowAbi,
    eventName: 'OrderStatusChanged',
    onLogs: (logs) => {
      for (const log of logs as Array<Log & { args: OrderStatusChangedArgs }>) {
        handleOrderStatusChanged(schedule, log.args);
      }
    },
    onError: (err) => logger.error('OrderStatusChanged watcher error:', err),
  });

  return () => {
    unwatchPlaced();
    unwatchStatus();
  };
}
