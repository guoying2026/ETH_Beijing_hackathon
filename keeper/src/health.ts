import http, { type Server } from 'node:http';
import { logger } from './logger.js';

/** Snapshot of keeper-internal state surfaced by /health. */
export interface HealthSnapshot {
  status: 'ok' | 'degraded';
  scheduleSize: number;
  lastProcessedBlock: string;
  keeperAddress: string;
  /** Wallet balance in wei (stringified). */
  balanceWei: string;
  /** Whether the wallet balance is below the configured low-balance threshold. */
  lowBalance: boolean;
  /** Most recent successful poll tick (ISO string, or null before first tick). */
  lastTickAt: string | null;
}

/**
 * Provider function that returns the live snapshot whenever /health is hit.
 * Keeping this as a pull-callback (instead of a pushed snapshot) means the
 * caller doesn't need to write-lock anything when state changes.
 */
export type HealthProvider = () => HealthSnapshot;

/**
 * Start an HTTP server bound to `port` exposing GET /health.
 * Returns the `Server` instance so the caller can `.close()` it on shutdown.
 *
 * /health always responds with the current snapshot — `status === 'ok'` when
 * balance is above the threshold AND a tick has run at least once, otherwise
 * `'degraded'`. Other paths return 404.
 */
export function startHealthServer(port: number, provider: HealthProvider): Server {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain' }).end('method not allowed');
      return;
    }
    if (req.url === '/health' || req.url === '/healthz') {
      const snap = provider();
      const body = JSON.stringify(snap);
      res
        .writeHead(snap.status === 'ok' ? 200 : 503, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        })
        .end(body);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  });
  server.on('error', (err) => logger.error('Health server error:', err));
  server.listen(port, () => logger.info(`Health endpoint listening on :${port}/health`));
  return server;
}
