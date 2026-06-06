import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const VALID_KEY = '0x' + 'a'.repeat(64);
const VALID_ADDR = '0x' + 'b'.repeat(40);

const GOOD: Record<string, string> = {
  RPC_URL_HTTP: 'http://localhost:8545',
  CHAIN_ID: '31337',
  ESCROW_ADDRESS: VALID_ADDR,
  KEEPER_PRIVATE_KEY: VALID_KEY,
};

const SAVED = new Map<string, string | undefined>();
const CFG_KEYS = [
  'RPC_URL_HTTP',
  'RPC_URL_WS',
  'CHAIN_ID',
  'ESCROW_ADDRESS',
  'KEEPER_DEPLOYMENTS_FILE',
  'KEEPER_PRIVATE_KEY',
  'KEEPER_DEPLOYMENT_BLOCK',
  'GRACE_PERIOD_SECONDS',
  'POLL_INTERVAL_MS',
  'MAX_BATCH_SIZE',
  'GAS_PRICE_CAP_GWEI',
  'STATE_FILE_PATH',
  'HEALTH_PORT',
  'LOW_BALANCE_THRESHOLD_ETH',
  'LOG_LEVEL',
];

function setEnv(env: Record<string, string | undefined>) {
  for (const k of CFG_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) process.env[k] = v;
  }
}

beforeEach(() => {
  for (const k of CFG_KEYS) SAVED.set(k, process.env[k]);
});

afterEach(() => {
  for (const k of CFG_KEYS) {
    if (SAVED.get(k) === undefined) delete process.env[k];
    else process.env[k] = SAVED.get(k);
  }
});

describe('loadConfig', () => {
  it('loads with defaults; escrow comes from env when ESCROW_ADDRESS set', () => {
    setEnv(GOOD);
    const cfg = loadConfig();
    expect(cfg.chainId).toBe(31337);
    expect(cfg.escrowAddress.toLowerCase()).toBe(VALID_ADDR);
    expect(cfg.escrowSource).toBe('env');
    expect(cfg.gracePeriodSeconds).toBe(30);
    expect(cfg.pollIntervalMs).toBe(10_000);
    expect(cfg.maxBatchSize).toBe(20);
    expect(cfg.gasPriceCapWei).toBe(100n * 1_000_000_000n);
    expect(cfg.logLevel).toBe('INFO');
    expect(cfg.rpcUrlWs).toBe('ws://localhost:8545'); // derived from HTTP
  });

  it('throws when RPC_URL_HTTP missing', () => {
    setEnv({ ...GOOD, RPC_URL_HTTP: undefined });
    expect(() => loadConfig()).toThrow(/RPC_URL_HTTP/);
  });

  it('throws on invalid ESCROW_ADDRESS', () => {
    setEnv({ ...GOOD, ESCROW_ADDRESS: '0xnotvalid' });
    expect(() => loadConfig()).toThrow(/ESCROW_ADDRESS/);
  });

  it('throws with actionable error when neither ESCROW_ADDRESS nor deployments file', () => {
    setEnv({
      ...GOOD,
      ESCROW_ADDRESS: undefined,
      KEEPER_DEPLOYMENTS_FILE: '/no/such/path/31337.json',
    });
    expect(() => loadConfig()).toThrow(/Neither ESCROW_ADDRESS nor a readable deployments file/);
  });

  it('throws on malformed private key', () => {
    setEnv({ ...GOOD, KEEPER_PRIVATE_KEY: '0xdeadbeef' });
    expect(() => loadConfig()).toThrow(/KEEPER_PRIVATE_KEY/);
  });

  it('throws when POLL_INTERVAL_MS < 1000', () => {
    setEnv({ ...GOOD, POLL_INTERVAL_MS: '500' });
    expect(() => loadConfig()).toThrow(/POLL_INTERVAL_MS/);
  });

  it('throws when MAX_BATCH_SIZE > 20', () => {
    setEnv({ ...GOOD, MAX_BATCH_SIZE: '21' });
    expect(() => loadConfig()).toThrow(/MAX_BATCH_SIZE/);
  });

  it('throws on unknown LOG_LEVEL', () => {
    setEnv({ ...GOOD, LOG_LEVEL: 'verbose' });
    expect(() => loadConfig()).toThrow(/LOG_LEVEL/);
  });

  it('LOG_LEVEL is case-insensitive', () => {
    setEnv({ ...GOOD, LOG_LEVEL: 'debug' });
    expect(loadConfig().logLevel).toBe('DEBUG');
  });
});
