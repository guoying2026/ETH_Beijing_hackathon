import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isAddress, type Address } from 'viem';

/**
 * Shape of `packages/contracts/deployments/<chainId>.json` written by
 * `deploy-web.ts`. Only the fields the keeper depends on are typed strictly —
 * anything else is ignored on read so the contracts package can evolve the
 * artifact freely.
 */
export interface DeploymentsFile {
  chainId: number;
  deploymentBlock: string; // bigint stringified
  contracts: {
    c2cEscrow: string;
    [k: string]: string;
  };
  [k: string]: unknown;
}

/** Result of resolving the escrow address (and replay starting block). */
export interface ResolvedEscrow {
  address: Address;
  deploymentBlock: bigint;
  /** Where the address came from — useful for the startup banner. */
  source: 'env' | 'file';
  /** Resolved file path when `source === 'file'`. */
  filePath?: string;
}

/**
 * Default lookup path used when `KEEPER_DEPLOYMENTS_FILE` is unset.
 *
 * With multi-keeper support each deploy script writes its own labelled file
 * (e.g. `web-31337.json`, `demo-31337.json`), so the keeper distinguishes
 * instances via `KEEPER_LABEL` (default `'web'`). When `label` is `null` we
 * fall back to the legacy single-deploy filename `<chainId>.json` so
 * pre-multi-keeper setups keep working without env changes.
 */
export function defaultDeploymentsPath(
  chainId: number,
  label: string | null = null,
  cwd = process.cwd(),
): string {
  const base = path.resolve(cwd, '..', 'contracts', 'deployments');
  return label ? path.join(base, `${label}-${chainId}.json`) : path.join(base, `${chainId}.json`);
}

/**
 * Read + parse a deployments file. Returns null for any soft failure
 * (missing, malformed, wrong shape) so the caller can fall through to the
 * "must specify ESCROW_ADDRESS env" error path with a clearer message.
 *
 * Throws only when the file exists AND parses AND has c2cEscrow set but
 * the address itself is malformed — that's a hard misconfiguration.
 */
export function loadDeploymentsFile(filePath: string): DeploymentsFile | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isDeploymentsFile(parsed)) return null;
  return parsed;
}

/**
 * Resolve the escrow address + deployment block using the precedence:
 *   1. explicit env var ESCROW_ADDRESS (full override)
 *   2. KEEPER_DEPLOYMENTS_FILE env var path
 *   3. default `../contracts/deployments/<chainId>.json` relative to cwd
 *
 * `envDeploymentBlock` (KEEPER_DEPLOYMENT_BLOCK) only overrides the file's
 * value when it's set AND > 0 — a default of 0n still falls back to the
 * file so the keeper auto-skips pre-deploy block scans.
 */
export function resolveEscrow(opts: {
  envAddress?: string;
  envDeploymentsFile?: string;
  envDeploymentBlock?: bigint;
  chainId: number;
  /**
   * Keeper instance label (`web` / `demo`). When `envDeploymentsFile` is
   * unset, we resolve `deployments/<label>-<chainId>.json` first, then fall
   * back to the legacy `<chainId>.json` for backwards compat.
   */
  label?: string;
  cwd?: string;
}): ResolvedEscrow {
  // 1) Explicit env override.
  if (opts.envAddress) {
    if (!isAddress(opts.envAddress)) {
      throw new Error(`ESCROW_ADDRESS is not a valid address: ${opts.envAddress}`);
    }
    return {
      address: opts.envAddress as Address,
      deploymentBlock: opts.envDeploymentBlock ?? 0n,
      source: 'env',
    };
  }
  // 2) + 3) Deployments file (env override, labelled default, or legacy default).
  let filePath: string;
  let file: DeploymentsFile | null;
  if (opts.envDeploymentsFile) {
    filePath = opts.envDeploymentsFile;
    file = loadDeploymentsFile(filePath);
  } else {
    // Try labelled file first, then legacy <chainId>.json as fallback.
    const labelledPath = defaultDeploymentsPath(opts.chainId, opts.label ?? 'web', opts.cwd);
    const legacyPath = defaultDeploymentsPath(opts.chainId, null, opts.cwd);
    file = loadDeploymentsFile(labelledPath);
    filePath = labelledPath;
    if (!file) {
      const legacyFile = loadDeploymentsFile(legacyPath);
      if (legacyFile) {
        file = legacyFile;
        filePath = legacyPath;
      }
    }
  }
  if (!file) {
    throw new Error(
      `Neither ESCROW_ADDRESS nor a readable deployments file was provided. ` +
        `Tried ${filePath}. Either set ESCROW_ADDRESS in .env, or run ` +
        `packages/contracts: npm run deploy:web (which writes this file).`,
    );
  }
  if (file.chainId !== opts.chainId) {
    throw new Error(
      `Deployments file ${filePath} is for chainId=${file.chainId} but keeper ` +
        `is configured for chainId=${opts.chainId}`,
    );
  }
  const address = file.contracts.c2cEscrow;
  if (!isAddress(address)) {
    throw new Error(`Deployments file ${filePath} has invalid c2cEscrow address: ${address}`);
  }
  // Env block wins ONLY when explicitly > 0 — the env default (0n) yields
  // to the file's deployment block.
  const fileBlock = BigInt(file.deploymentBlock);
  const deploymentBlock =
    opts.envDeploymentBlock && opts.envDeploymentBlock > 0n ? opts.envDeploymentBlock : fileBlock;
  return { address: address as Address, deploymentBlock, source: 'file', filePath };
}

// ── Type guards ─────────────────────────────────────────────────────────────

function isDeploymentsFile(v: unknown): v is DeploymentsFile {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.chainId !== 'number') return false;
  if (typeof o.deploymentBlock !== 'string') return false;
  if (typeof o.contracts !== 'object' || o.contracts === null) return false;
  const c = o.contracts as Record<string, unknown>;
  if (typeof c.c2cEscrow !== 'string') return false;
  return true;
}
