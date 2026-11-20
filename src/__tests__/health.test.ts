import Fastify from 'fastify';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { checkDb, fetchMock, watcherRunning } = vi.hoisted(() => ({
  checkDb: vi.fn(),
  fetchMock: vi.fn(),
  watcherRunning: vi.fn(),
}));
vi.mock('../db/index.js', () => ({ checkDbConnection: checkDb }));
vi.mock('undici', () => ({ fetch: fetchMock }));
vi.mock('../services/chain-watcher.js', () => ({ isChainWatcherRunning: watcherRunning }));
const { registerHealthRoutes } = await import('../api/routes/health.js');
const { env } = await import('../config/env.js');
const originalMode = env.ADDRESS_MODE;
const packageVersion = (createRequire(import.meta.url)('../../package.json') as { version: string }).version;

beforeEach(() => {
  checkDb.mockReset().mockResolvedValue(undefined);
  watcherRunning.mockReset().mockReturnValue(true);
  fetchMock.mockReset().mockResolvedValue({
    ok: true,
    json: async () => ({ block_header: { raw_data: { number: 42 } } }),
  });
});
afterEach(() => {
  env.ADDRESS_MODE = originalMode;
});

async function readiness(initialized: boolean) {
  const app = Fastify();
  const isInitialized = vi.fn().mockReturnValue(initialized);
  registerHealthRoutes(app, {
    redis: { ping: async () => 'PONG' } as never,
    wallet: { isInitialized } as never,
  });
  try {
    return { response: await app.inject('/api/v1/health'), isInitialized };
  } finally {
    await app.close();
  }
}

describe('mode-aware readiness', () => {
  it('reports the actual package version to authenticated administrators', async () => {
    const app = Fastify();
    const { signAdminToken } = await import('../utils/jwt.js');
    const { default: cookie } = await import('@fastify/cookie');
    await app.register(cookie);
    registerHealthRoutes(app, { redis: { ping: async () => 'PONG' } as never, wallet: { isInitialized: () => true } as never });
    try {
      const response = await app.inject({ url: '/api/v1/admin/health', headers: { cookie: 'admin_token=' + signAdminToken() } });
      expect(response.statusCode).toBe(200);
      expect(response.json().version).toBe(packageVersion);
    } finally { await app.close(); }
  });
  it('does not require or inspect an HD wallet in static mode', async () => {
    env.ADDRESS_MODE = 'static';
    const { response, isInitialized } = await readiness(false);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(isInitialized).not.toHaveBeenCalled();
  });

  it('requires an initialized wallet in HD mode', async () => {
    env.ADDRESS_MODE = 'hd';
    expect((await readiness(false)).response.statusCode).toBe(503);
    expect((await readiness(true)).response.statusCode).toBe(200);
  });

  it('still rejects a disconnected database in static mode', async () => {
    env.ADDRESS_MODE = 'static';
    checkDb.mockRejectedValue(new Error('database offline'));
    expect((await readiness(false)).response.statusCode).toBe(503);
  });

  it('still rejects a stopped watcher in static mode', async () => {
    env.ADDRESS_MODE = 'static';
    watcherRunning.mockReturnValue(false);
    expect((await readiness(false)).response.statusCode).toBe(503);
  });
});
