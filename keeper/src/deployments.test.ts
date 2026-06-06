import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultDeploymentsPath, loadDeploymentsFile, resolveEscrow } from './deployments.js';

const ESCROW = '0x1234567890123456789012345678901234567890';
const ENV_ESCROW = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';

function file(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    chainId: 31337,
    deployedAt: '2026-05-27T00:00:00Z',
    deploymentBlock: '12345',
    contracts: {
      c2cEscrow: ESCROW,
      c2cAdmin: '0x' + 'b'.repeat(40),
    },
    ...overrides,
  });
}

describe('deployments — defaultDeploymentsPath', () => {
  it('legacy (label=null): <chainId>.json', () => {
    const p = defaultDeploymentsPath(31337, null, '/work/packages/keeper');
    expect(p).toBe(path.resolve('/work/packages/contracts/deployments/31337.json'));
  });

  it('labelled: <label>-<chainId>.json', () => {
    const p = defaultDeploymentsPath(31337, 'web', '/work/packages/keeper');
    expect(p).toBe(path.resolve('/work/packages/contracts/deployments/web-31337.json'));
  });

  it('different label produces different filename', () => {
    const web = defaultDeploymentsPath(31337, 'web', '/work/packages/keeper');
    const demo = defaultDeploymentsPath(31337, 'demo', '/work/packages/keeper');
    expect(web).not.toBe(demo);
    expect(demo).toContain('demo-31337.json');
  });
});

describe('deployments — loadDeploymentsFile', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'keeper-deploy-'));
    filePath = path.join(dir, '31337.json');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null for missing file', () => {
    expect(loadDeploymentsFile(filePath)).toBeNull();
  });

  it('returns null for malformed JSON', async () => {
    await writeFile(filePath, '{not json', 'utf8');
    expect(loadDeploymentsFile(filePath)).toBeNull();
  });

  it('returns null when c2cEscrow missing', async () => {
    await writeFile(
      filePath,
      JSON.stringify({ chainId: 31337, deploymentBlock: '0', contracts: {} }),
      'utf8',
    );
    expect(loadDeploymentsFile(filePath)).toBeNull();
  });

  it('parses a valid file', async () => {
    await writeFile(filePath, file(), 'utf8');
    const f = loadDeploymentsFile(filePath);
    expect(f?.chainId).toBe(31337);
    expect(f?.contracts.c2cEscrow).toBe(ESCROW);
  });
});

describe('deployments — resolveEscrow', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'keeper-deploy-'));
    filePath = path.join(dir, '31337.json');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('env override takes precedence over file', async () => {
    await writeFile(filePath, file(), 'utf8');
    const r = resolveEscrow({
      envAddress: ENV_ESCROW,
      envDeploymentsFile: filePath,
      envDeploymentBlock: 0n,
      chainId: 31337,
    });
    expect(r.source).toBe('env');
    expect(r.address.toLowerCase()).toBe(ENV_ESCROW);
    expect(r.deploymentBlock).toBe(0n);
  });

  it('env override with explicit deployment block honoured', () => {
    const r = resolveEscrow({
      envAddress: ENV_ESCROW,
      envDeploymentBlock: 999n,
      chainId: 31337,
    });
    expect(r.deploymentBlock).toBe(999n);
  });

  it('throws on invalid env address', () => {
    expect(() =>
      resolveEscrow({
        envAddress: '0xnotvalid',
        envDeploymentBlock: 0n,
        chainId: 31337,
      }),
    ).toThrow(/ESCROW_ADDRESS/);
  });

  it('falls through to file when env unset', async () => {
    await writeFile(filePath, file(), 'utf8');
    const r = resolveEscrow({
      envDeploymentsFile: filePath,
      envDeploymentBlock: 0n,
      chainId: 31337,
    });
    expect(r.source).toBe('file');
    expect(r.address.toLowerCase()).toBe(ESCROW);
    expect(r.deploymentBlock).toBe(12345n); // from file
    expect(r.filePath).toBe(filePath);
  });

  it('env deployment block > 0 overrides file value', async () => {
    await writeFile(filePath, file(), 'utf8');
    const r = resolveEscrow({
      envDeploymentsFile: filePath,
      envDeploymentBlock: 50_000n,
      chainId: 31337,
    });
    expect(r.deploymentBlock).toBe(50_000n);
  });

  it('throws with actionable message when neither env nor file available', () => {
    expect(() =>
      resolveEscrow({
        envDeploymentsFile: filePath, // does not exist
        envDeploymentBlock: 0n,
        chainId: 31337,
      }),
    ).toThrow(/Neither ESCROW_ADDRESS nor a readable deployments file/);
  });

  it('throws on chainId mismatch (file is for different chain)', async () => {
    await writeFile(filePath, file({ chainId: 1 }), 'utf8'); // mainnet file
    expect(() =>
      resolveEscrow({
        envDeploymentsFile: filePath,
        envDeploymentBlock: 0n,
        chainId: 31337,
      }),
    ).toThrow(/chainId=1.*chainId=31337/);
  });

  it('throws when file has invalid c2cEscrow address', async () => {
    await writeFile(filePath, file({ contracts: { c2cEscrow: '0xnope' } }), 'utf8');
    expect(() =>
      resolveEscrow({
        envDeploymentsFile: filePath,
        envDeploymentBlock: 0n,
        chainId: 31337,
      }),
    ).toThrow(/invalid c2cEscrow address/);
  });
});
