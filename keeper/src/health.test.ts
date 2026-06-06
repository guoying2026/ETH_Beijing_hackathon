import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { startHealthServer, type HealthSnapshot } from './health.js';

const KEEPER_ADDR = '0xcccccccccccccccccccccccccccccccccccccccc';

function snapshot(overrides: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    status: 'ok',
    scheduleSize: 0,
    lastProcessedBlock: '0',
    keeperAddress: KEEPER_ADDR,
    balanceWei: '1000000000000000000',
    lowBalance: false,
    lastTickAt: new Date().toISOString(),
    ...overrides,
  };
}

async function fetchJson(
  port: number,
  path = '/health',
): Promise<{ status: number; body: HealthSnapshot }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: (await res.json()) as HealthSnapshot };
}

describe('health endpoint', () => {
  let server: Server | undefined;
  let port: number;

  beforeEach(async () => {
    // Bind to ephemeral port — let the OS pick.
    port = 0;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
  });

  it('returns 200 + JSON when status is ok', async () => {
    server = startHealthServer(0, () => snapshot());
    await new Promise<void>((r) => server!.once('listening', () => r()));
    port = (server.address() as { port: number }).port;
    const { status, body } = await fetchJson(port);
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.keeperAddress).toBe(KEEPER_ADDR);
  });

  it('returns 503 when status is degraded', async () => {
    server = startHealthServer(0, () => snapshot({ status: 'degraded', lowBalance: true }));
    await new Promise<void>((r) => server!.once('listening', () => r()));
    port = (server.address() as { port: number }).port;
    const { status, body } = await fetchJson(port);
    expect(status).toBe(503);
    expect(body.lowBalance).toBe(true);
  });

  it('returns 404 on unknown paths', async () => {
    server = startHealthServer(0, () => snapshot());
    await new Promise<void>((r) => server!.once('listening', () => r()));
    port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
  });

  it('returns 405 on POST', async () => {
    server = startHealthServer(0, () => snapshot());
    await new Promise<void>((r) => server!.once('listening', () => r()));
    port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/health`, { method: 'POST' });
    expect(res.status).toBe(405);
  });

  it('provider is called on every request (live snapshot)', async () => {
    let calls = 0;
    server = startHealthServer(0, () => {
      calls++;
      return snapshot({ scheduleSize: calls });
    });
    await new Promise<void>((r) => server!.once('listening', () => r()));
    port = (server.address() as { port: number }).port;
    const a = await fetchJson(port);
    const b = await fetchJson(port);
    expect(a.body.scheduleSize).toBe(1);
    expect(b.body.scheduleSize).toBe(2);
  });
});
