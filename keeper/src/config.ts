import { config as dotenvConfig } from 'dotenv';
import { isHex, parseEther, type Address, type Hex } from 'viem';
import { resolveEscrow } from './deployments.js';

// Honour DOTENV_CONFIG_PATH so a second keeper instance can pass a different
// env file (e.g. `.env.demo`) without rebuilding. Falls back to the default
// `.env` lookup behaviour.
dotenvConfig({ path: process.env.DOTENV_CONFIG_PATH || undefined });

/** Fully validated keeper configuration. */
export interface KeeperConfig {
  rpcUrlHttp: string;
  rpcUrlWs: string;
  chainId: number;
  /** Instance label (multi-keeper deployments use this to namespace state/health). */
  label: string;
  escrowAddress: Address;
  /** Where the escrow address was resolved from — useful for the startup log. */
  escrowSource: 'env' | 'file';
  /** Resolved deployments file path when `escrowSource === 'file'`. */
  deploymentsFile?: string;
  keeperPrivateKey: Hex;
  deploymentBlock: bigint;
  gracePeriodSeconds: number;
  pollIntervalMs: number;
  maxBatchSize: number;
  gasPriceCapWei: bigint;
  stateFilePath: string;
  healthPort: number;
  lowBalanceThresholdWei: bigint;
  logLevel: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
}

const LOG_LEVELS = new Set(['DEBUG', 'INFO', 'WARN', 'ERROR']);

function readRequired(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v.trim();
}

function readOptional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : fallback;
}

function readInt(name: string, fallback?: number): number {
  const raw = fallback === undefined ? readRequired(name) : readOptional(name, String(fallback));
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Env ${name} must be a non-negative integer, got "${raw}"`);
  }
  return n;
}

function readBigInt(name: string, fallback?: bigint): bigint {
  const raw = fallback === undefined ? readRequired(name) : readOptional(name, fallback.toString());
  try {
    const n = BigInt(raw);
    if (n < 0n) throw new Error('negative');
    return n;
  } catch {
    throw new Error(`Env ${name} must be a non-negative bigint, got "${raw}"`);
  }
}

/**
 * Load and validate keeper config from process.env (dotenv pre-loaded).
 * Throws synchronously on any missing or malformed value.
 */
export function loadConfig(): KeeperConfig {
  const rpcUrlHttp = readRequired('RPC_URL_HTTP');
  const rpcUrlWs = readOptional('RPC_URL_WS', rpcUrlHttp.replace(/^http/, 'ws'));
  const chainId = readInt('CHAIN_ID');

  // Escrow address + deployment block: precedence is
  //   ESCROW_ADDRESS env > KEEPER_DEPLOYMENTS_FILE env > default deployments
  // path. The default path is `<label>-<chainId>.json` (label from
  // KEEPER_LABEL, default "web"), with a fallback to legacy `<chainId>.json`.
  const envEscrow = process.env.ESCROW_ADDRESS?.trim();
  const envDeploymentsFile = process.env.KEEPER_DEPLOYMENTS_FILE?.trim();
  const label = readOptional('KEEPER_LABEL', 'web');
  const envDeploymentBlock = readBigInt('KEEPER_DEPLOYMENT_BLOCK', 0n);
  const resolved = resolveEscrow({
    envAddress: envEscrow,
    envDeploymentsFile: envDeploymentsFile || undefined,
    envDeploymentBlock,
    chainId,
    label,
  });
  const escrowAddress = resolved.address;
  const deploymentBlock = resolved.deploymentBlock;

  const keeperPrivateKey = readRequired('KEEPER_PRIVATE_KEY');
  if (!isHex(keeperPrivateKey) || keeperPrivateKey.length !== 66) {
    throw new Error('KEEPER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string');
  }
  const gracePeriodSeconds = readInt('GRACE_PERIOD_SECONDS', 30);
  const pollIntervalMs = readInt('POLL_INTERVAL_MS', 10_000);
  if (pollIntervalMs < 1_000) {
    throw new Error(`POLL_INTERVAL_MS must be >= 1000, got ${pollIntervalMs}`);
  }
  const maxBatchSize = readInt('MAX_BATCH_SIZE', 20);
  if (maxBatchSize < 1 || maxBatchSize > 20) {
    throw new Error(`MAX_BATCH_SIZE must be in [1, 20], got ${maxBatchSize}`);
  }

  const gasPriceCapGwei = readInt('GAS_PRICE_CAP_GWEI', 100);
  const gasPriceCapWei = BigInt(gasPriceCapGwei) * 1_000_000_000n;

  const stateFilePath = readOptional('STATE_FILE_PATH', './data/state.json');
  const healthPort = readInt('HEALTH_PORT', 9091);

  const lowBalanceThresholdEth = readOptional('LOW_BALANCE_THRESHOLD_ETH', '0.01');
  let lowBalanceThresholdWei: bigint;
  try {
    lowBalanceThresholdWei = parseEther(lowBalanceThresholdEth);
  } catch {
    throw new Error(`LOW_BALANCE_THRESHOLD_ETH not a decimal string: ${lowBalanceThresholdEth}`);
  }

  const logLevel = readOptional('LOG_LEVEL', 'INFO').toUpperCase();
  if (!LOG_LEVELS.has(logLevel)) {
    throw new Error(`LOG_LEVEL must be one of DEBUG|INFO|WARN|ERROR, got "${logLevel}"`);
  }

  return {
    rpcUrlHttp,
    rpcUrlWs,
    chainId,
    label,
    escrowAddress,
    escrowSource: resolved.source,
    deploymentsFile: resolved.filePath,
    keeperPrivateKey: keeperPrivateKey as Hex,
    deploymentBlock,
    gracePeriodSeconds,
    pollIntervalMs,
    maxBatchSize,
    gasPriceCapWei,
    stateFilePath,
    healthPort,
    lowBalanceThresholdWei,
    logLevel: logLevel as KeeperConfig['logLevel'],
  };
}
