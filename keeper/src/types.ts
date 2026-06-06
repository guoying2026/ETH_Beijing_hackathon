import type { Address } from 'viem';

/** On-chain AssetType enum (matches C2CTypes.sol). */
export enum AssetType {
  CRYPTO = 0,
  FIAT = 1,
}

/** A single PENDING/WAITING order tracked by the keeper. */
export interface ScheduleEntry {
  /** Composite key — unique per (merchant, productId, assetType, orderId). */
  orderKey: string;
  merchant: Address;
  productId: bigint;
  assetType: AssetType;
  orderId: bigint;
  /** Block timestamp (seconds) at which the order expires on-chain. */
  deadline: bigint;
}

/** Target shape for the on-chain `sweepExpiredBatch(SweepTarget[])` call. */
export interface SweepTarget {
  merchant: Address;
  productId: bigint;
  assetType: AssetType;
  maxSteps: bigint;
}

/** Build the canonical schedule key. */
export function makeOrderKey(
  merchant: Address,
  productId: bigint,
  assetType: AssetType,
  orderId: bigint,
): string {
  return `${merchant.toLowerCase()}:${productId}:${assetType}:${orderId}`;
}
