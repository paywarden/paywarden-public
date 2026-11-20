import type { FastifyInstance } from 'fastify';
import { createRequire } from 'node:module';
import type { Redis } from 'ioredis';
import { fetch } from 'undici';
import { checkDbConnection } from '../../db/index.js';
import { env } from '../../config/env.js';
import { NETWORK } from '../../config/constants.js';
import { logger } from '../../utils/logger.js';
import { isChainWatcherRunning } from '../../services/chain-watcher.js';
import type { WalletService } from '../../services/wallet.js';
import { adminAuthMiddleware } from '../middleware/admin-auth.js';

let startTime = Date.now();
const packageVersion = (createRequire(import.meta.url)('../../../package.json') as { version: string }).version;

interface HealthCheckResult {
  healthy: boolean;
  checks: Record<string, string>;
  currentBlock: number | null;
}

async function runHealthChecks(
  redis: Redis,
  wallet: WalletService,
): Promise<HealthCheckResult> {
  const checks: Record<string, string> = {
    database: 'disconnected',
    redis: 'disconnected',
    trongrid: 'disconnected',
    watcher: isChainWatcherRunning() ? 'running' : 'stopped',
    wallet:
      env.ADDRESS_MODE === 'static'
        ? 'not_applicable'
        : wallet.isInitialized()
          ? 'initialized'
          : 'uninitialized',
  };

  let healthy = true;
  let currentBlock: number | null = null;

  try {
    await checkDbConnection();
    checks.database = 'connected';
  } catch {
    healthy = false;
    logger.warn('Health check: database disconnected');
  }

  try {
    const pong = await redis.ping();
    checks.redis = pong === 'PONG' ? 'connected' : 'degraded';
    if (pong !== 'PONG') healthy = false;
  } catch {
    healthy = false;
    logger.warn('Health check: redis disconnected');
  }

  try {
    const response = await fetch(`${NETWORK.trongridUrl}/wallet/getnowblock`, {
      headers: { 'TRON-PRO-API-KEY': env.TRONGRID_API_KEY },
      signal: AbortSignal.timeout(3_000),
    });

    if (!response.ok) {
      healthy = false;
      logger.warn({ status: response.status }, 'Health check: TronGrid returned non-200');
    } else {
      const body = (await response.json()) as {
        block_header?: { raw_data?: { number?: number } };
      };
      currentBlock = body.block_header?.raw_data?.number ?? null;
      checks.trongrid = currentBlock !== null ? 'reachable' : 'degraded';
      if (currentBlock === null) healthy = false;
    }
  } catch {
    healthy = false;
    logger.warn('Health check: TronGrid unreachable');
  }

  if (env.ADDRESS_MODE === 'hd' && !wallet.isInitialized()) {
    healthy = false;
    logger.warn('Health check: wallet uninitialized');
  }

  if (!isChainWatcherRunning()) {
    healthy = false;
    logger.warn('Health check: chain watcher stopped');
  }

  return { healthy, checks, currentBlock };
}

export function registerHealthRoutes(
  app: FastifyInstance,
  deps: { redis: Redis; wallet: WalletService },
): void {
  startTime = Date.now();
  const { redis, wallet } = deps;

  // Liveness probe: only signals "the process is up and can serve HTTP".
  // Does NOT check DB, Redis, wallet, or chain — those belong in readiness.
  // Used by Docker HEALTHCHECK; must not return 503 during first-deploy
  // bootstrap. Cheap, no external calls. Safe to keep public.
  app.get('/api/v1/health/live', async (_req, reply) => {
    reply.code(200).send({ status: 'alive' });
  });

  // Readiness probe — public but minimal. Returns ONLY ok|degraded so
  // external monitoring can hit it without exposing internal infrastructure
  // details (DB host, Redis host, TronGrid block height, wallet status,
  // sweep configuration). The detailed version is /api/v1/admin/health and
  // requires admin authentication.
  //
  // This endpoint still exercises DB / Redis / TronGrid on every call so a
  // single LB probe is enough to fail over a degraded instance. If the
  // request volume becomes a concern, layer caching here — never expand
  // the public response shape.
  app.get('/api/v1/health', async (_req, reply) => {
    const { healthy } = await runHealthChecks(redis, wallet);
    reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
    });
  });

  // Admin-only detailed health: full check breakdown + chain state +
  // configured sweep mode. Used by the dashboard / on-call operators to
  // diagnose a degraded instance after the public probe flips to 503.
  app.get(
    '/api/v1/admin/health',
    { preHandler: adminAuthMiddleware },
    async (_req, reply) => {
      const { healthy, checks, currentBlock } = await runHealthChecks(redis, wallet);
      reply.code(healthy ? 200 : 503).send({
        status: healthy ? 'ok' : 'degraded',
        version: packageVersion,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        checks,
        system: {
          tronNetwork: env.TRON_NETWORK,
          currentBlock,
          scanMode: env.SCAN_MODE,
          minConfirmations: env.MIN_CONFIRMATIONS,
          sweepEnabled: env.ADDRESS_MODE === 'hd' && !!(env.HOT_WALLET_KEY && env.COLD_WALLET_ADDRESS),
        },
      });
    },
  );
}
