/**
 * Admin API contract test.
 *
 * Verifies that every response from /api/v1/admin/* uses snake_case JSON
 * (per paywarden/CODING_STANDARDS.md) and that request bodies accept both
 * camelCase and snake_case during the transition.
 *
 * Strategy: boot a minimal Fastify instance, register the admin routes, and
 * mock the DB layer + external services so the test is hermetic (no Postgres,
 * no Redis, no TronGrid). We only verify contract shape, not business logic.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Each `getDb()` call returns a fresh Proxy-based query builder that resolves
// to the next queued result when awaited. Tests push results in the order the
// route's promises resolve.
const queryQueue: unknown[] = [];
function pushResult(result: unknown): void {
  queryQueue.push(result);
}
function pushResults(results: unknown[]): void {
  for (const r of results) queryQueue.push(r);
}
function nextResult(): unknown {
  if (queryQueue.length === 0) return [];
  return queryQueue.shift();
}

function makeQueryBuilder(): unknown {
  const builder: Record<string | symbol, unknown> = {};
  const proxy: unknown = new Proxy(builder, {
    get(_target, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => void) => resolve(nextResult());
      }
      // Any chain method returns the same proxy.
      return () => proxy;
    },
  });
  return proxy;
}

const fakeDb = {
  select: () => makeQueryBuilder(),
  insert: () => makeQueryBuilder(),
  update: () => makeQueryBuilder(),
  delete: () => makeQueryBuilder(),
  execute: async () => nextResult(),
};

vi.mock('../db/index.js', () => ({
  getDb: () => fakeDb,
  getPool: () => ({}),
  checkDbConnection: async () => undefined,
  closeDb: async () => undefined,
}));

// Import AFTER the mock is set up.
const { default: Fastify } = await import('fastify');
const cookie = (await import('@fastify/cookie')).default;
const rateLimit = (await import('@fastify/rate-limit')).default;
const { registerAdminRoutes } = await import('../api/routes/admin.js');

type InjectResponse = Awaited<ReturnType<ReturnType<typeof Fastify>['inject']>>;

const app = Fastify({ logger: false });

beforeAll(async () => {
  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  // Stubbed service deps — admin routes only touch these in a few spots
  // (wallet endpoint + retry handlers). None of our contract tests exercise
  // those code paths, so empty stubs are enough.
  const gasManager = {
    tronWeb: { trx: { getBalance: async () => 0 } },
  } as unknown as Parameters<typeof registerAdminRoutes>[1]['gasManager'];
  const fundSweeper = {
    getQueueCounts: async () => ({ waiting: 0, active: 0, failed: 0, completed: 0 }),
  } as unknown as Parameters<typeof registerAdminRoutes>[1]['fundSweeper'];
  const orderEngine = {
    retryWebhook: async () => undefined,
    retrySweep: async () => undefined,
  } as unknown as Parameters<typeof registerAdminRoutes>[1]['orderEngine'];

  registerAdminRoutes(app, { gasManager, fundSweeper, orderEngine });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

async function login(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/auth/login',
    payload: { password: process.env.ADMIN_PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  const setCookie = res.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
  const token = cookies
    .map((c) => /admin_token=([^;]+)/.exec(c ?? '')?.[1])
    .find(Boolean);
  expect(token).toBeTruthy();
  return `admin_token=${token}`;
}

function isSnakeCaseKey(key: string): boolean {
  // Allow all lowercase letters, digits, and underscores. Reject any key
  // containing an uppercase letter.
  return !/[A-Z]/.test(key);
}

function assertAllSnakeCase(value: unknown, path = '$'): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertAllSnakeCase(v, `${path}[${i}]`));
    return;
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (!isSnakeCaseKey(key)) {
      throw new Error(`Non-snake_case key found at ${path}.${key}`);
    }
    assertAllSnakeCase((value as Record<string, unknown>)[key], `${path}.${key}`);
  }
}

describe('Admin API contract (snake_case)', () => {
  let authCookie: string;

  beforeAll(async () => {
    authCookie = await login();
  });

  it('POST /api/v1/admin/merchants accepts camelCase body and returns snake_case', async () => {
    // One insert → returning() → [merchant row]
    pushResult([
      {
        id: '11111111-1111-1111-1111-111111111111',
        name: 'Acme',
        apiKeyHash: 'h',
        apiKeyPrefix: 'abcd1234',
        webhookSecret: 'whsec_camel_case_test',
        isActive: true,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/merchants',
      headers: { cookie: authCookie },
      payload: { name: 'Acme', webhookSecret: 'whsec_camel_case_test' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    assertAllSnakeCase(body);
    expect(body).toMatchObject({
      api_key_prefix: 'abcd1234',
      is_active: true,
    });
    expect(typeof body.api_key).toBe('string');
  });

  it('POST /api/v1/admin/merchants accepts snake_case body and returns snake_case', async () => {
    pushResult([
      {
        id: '22222222-2222-2222-2222-222222222222',
        name: 'Beta',
        apiKeyHash: 'h',
        apiKeyPrefix: 'beta5678',
        webhookSecret: 'whsec_snake_case_test',
        isActive: true,
        createdAt: new Date('2026-01-02T00:00:00Z'),
      },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/merchants',
      headers: { cookie: authCookie },
      payload: { name: 'Beta', webhook_secret: 'whsec_snake_case_test' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    assertAllSnakeCase(body);
    expect(body.api_key_prefix).toBe('beta5678');
  });

  it('GET /api/v1/admin/merchants returns all snake_case fields', async () => {
    // Route calls two queries in Promise.all: rows, then orderCounts.
    pushResults([
      [
        {
          id: '33333333-3333-3333-3333-333333333333',
          name: 'Gamma',
          apiKeyPrefix: 'gamma999',
          isActive: true,
          createdAt: new Date('2026-01-03T00:00:00Z'),
        },
      ],
      [{ merchantId: '33333333-3333-3333-3333-333333333333', c: 42 }],
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/merchants',
      headers: { cookie: authCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    assertAllSnakeCase(body);
    expect(body.data[0]).toMatchObject({
      id: '33333333-3333-3333-3333-333333333333',
      name: 'Gamma',
      api_key_prefix: 'gamma999',
      is_active: true,
      order_count: 42,
    });
  });

  it('GET /api/v1/admin/stats returns all snake_case fields', async () => {
    // Route calls 5 queries in Promise.all:
    //   today, week, total, pool, merchantCount
    const statsRow = [{ orderCount: 10, completedCount: 7, totalReceived: '700.000000' }];
    pushResults([
      statsRow,
      statsRow,
      statsRow,
      [{ total: 100, free: 80, allocated: 20 }],
      [{ c: 5 }],
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/stats',
      headers: { cookie: authCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    assertAllSnakeCase(body);
    expect(body).toHaveProperty('today');
    expect(body).toHaveProperty('address_pool');
    expect((body.total as Record<string, unknown>).merchant_count).toBe(5);
    expect((body.today as Record<string, unknown>).order_count).toBe(10);
    expect((body.today as Record<string, unknown>).success_rate).toBe('70.00');
  });
});

function pushResultForSideEffect(_: InjectResponse): void {
  // Satisfies noUnusedLocals if the type import is otherwise unused.
}
void pushResultForSideEffect;
