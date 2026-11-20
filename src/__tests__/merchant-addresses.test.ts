/**
 * Static-address admin routes via Fastify inject: real adminAuthMiddleware
 * (signed cookie), real global error handler (coded errors → HTTP status),
 * recording fake DB, stubbed OrderEngine. Verifies auth, validation, state
 * transitions, contract shape and the status mapping for every new route.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

type Scope = 'db' | 'tx';
const queue: unknown[] = [];
const calls: Array<{ method: string; args: unknown[]; scope: Scope }> = [];

function builder(scope: Scope): unknown {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve(queue.length > 0 ? queue.shift() : []);
        }
        return (...args: unknown[]) => {
          calls.push({ method: String(prop), args, scope });
          return proxy;
        };
      },
    },
  );
  return proxy;
}
function makeDb(scope: Scope) {
  const rec = (method: string, args: unknown[]) => {
    calls.push({ method, args, scope });
    return builder(scope);
  };
  return {
    select: (...args: unknown[]) => rec('select', args),
    insert: (...args: unknown[]) => rec('insert', args),
    update: (...args: unknown[]) => rec('update', args),
    delete: (...args: unknown[]) => rec('delete', args),
    execute: async (...args: unknown[]) => {
      calls.push({ method: 'execute', args, scope });
      return undefined;
    },
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(fakeTx),
  };
}
const fakeTx = makeDb('tx');
const fakeDb = makeDb('db');
vi.mock('../db/index.js', () => ({ getDb: () => fakeDb }));

const { default: Fastify } = await import('fastify');
const cookie = (await import('@fastify/cookie')).default;
const { registerMerchantAddressRoutes } = await import('../api/routes/merchant-addresses.js');
const { errorHandler } = await import('../api/middleware/error-handler.js');
const { signAdminToken } = await import('../utils/jwt.js');

const MERCHANT = '11111111-1111-4111-8111-111111111111';
const ADDRESS_ID = '22222222-2222-4222-8222-222222222222';
const ORDER_ID = '33333333-3333-4333-8333-333333333333';
const UNMATCHED_ID = '44444444-4444-4444-8444-444444444444';
const ADDR = 'TACBmCJj8xFqUjVqYx9TFhX5acU7zD5Win';

const claimUnmatched = vi.fn().mockResolvedValue(undefined);
const registerWatchedAddress = vi.fn().mockResolvedValue(undefined);
const orderEngine = { claimUnmatched, registerWatchedAddress };

const app = Fastify({ logger: false });
let authCookie: string;

const dialect = new PgDialect();
function whereParams(): unknown[][] {
  return calls
    .filter((c) => c.method === 'where')
    .map((c) => dialect.sqlToQuery(c.args[0] as SQL).params);
}
function setCalls(): Record<string, unknown>[] {
  return calls.filter((c) => c.method === 'set').map((c) => c.args[0] as Record<string, unknown>);
}
function valuesCalls(): Record<string, unknown>[] {
  return calls
    .filter((c) => c.method === 'values')
    .map((c) => c.args[0] as Record<string, unknown>);
}

const now = new Date('2026-09-06T00:00:00Z');
function addressRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ADDRESS_ID,
    merchantId: MERCHANT,
    address: ADDR,
    label: null,
    role: 'sub',
    status: 'pending_confirm',
    confirmedAt: null,
    testTxHash: null,
    activatedAt: null,
    disabledAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function assertSnakeCase(value: unknown, path = '$'): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) return value.forEach((v, i) => assertSnakeCase(v, `${path}[${i}]`));
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (/[A-Z]/.test(key)) throw new Error(`Non-snake_case key at ${path}.${key}`);
    assertSnakeCase((value as Record<string, unknown>)[key], `${path}.${key}`);
  }
}

beforeAll(async () => {
  await app.register(cookie);
  app.setErrorHandler(errorHandler);
  registerMerchantAddressRoutes(app, { orderEngine: orderEngine as never });
  await app.ready();
  authCookie = `admin_token=${signAdminToken()}`;
});
afterAll(async () => app.close());
beforeEach(() => {
  queue.length = 0;
  calls.length = 0;
  claimUnmatched.mockClear();
  registerWatchedAddress.mockClear();
});
afterEach(() => {
  expect(queue, 'every queued DB result must be consumed').toHaveLength(0);
});

const inject = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
  withAuth = true,
) =>
  app.inject({
    method,
    url,
    payload: payload as never,
    headers: withAuth ? { cookie: authCookie } : {},
  });

describe('auth', () => {
  it.each([
    ['GET', `/api/v1/admin/merchants/${MERCHANT}/addresses`],
    ['POST', `/api/v1/admin/merchants/${MERCHANT}/addresses`],
    ['POST', `/api/v1/admin/merchants/${MERCHANT}/addresses/${ADDRESS_ID}/confirm`],
    ['PUT', `/api/v1/admin/merchants/${MERCHANT}/addresses/${ADDRESS_ID}`],
    ['DELETE', `/api/v1/admin/merchants/${MERCHANT}/addresses/${ADDRESS_ID}`],
    ['GET', `/api/v1/admin/merchants/${MERCHANT}/addresses/export`],
    ['GET', '/api/v1/admin/unmatched-transfers'],
    ['POST', `/api/v1/admin/unmatched-transfers/${UNMATCHED_ID}/claim`],
  ] as const)('%s %s → 401 without the admin cookie', async (method, url) => {
    const res = await inject(method, url, {}, false);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'ADMIN_UNAUTHORIZED' });
  });
});

describe('POST /addresses', () => {
  it('rejects a malformed TRON address with 400 VALIDATION_ERROR before touching the DB write path', async () => {
    queue.push([{ id: MERCHANT }]);
    const res = await inject('POST', `/api/v1/admin/merchants/${MERCHANT}/addresses`, {
      address: 'TACBmCJj8xFqUjVqYx9TFhX5acU7zD5Wiz',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(calls.filter((c) => c.method === 'insert')).toHaveLength(0);
  });

  it('404s an unknown merchant', async () => {
    queue.push([]);
    const res = await inject('POST', `/api/v1/admin/merchants/${MERCHANT}/addresses`, {
      address: ADDR,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('registers as pending_confirm and returns 201 snake_case', async () => {
    queue.push([{ id: MERCHANT }]);
    queue.push([addressRow()]); // insert → returning
    const res = await inject('POST', `/api/v1/admin/merchants/${MERCHANT}/addresses`, {
      address: ADDR,
      label: 'shop',
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    assertSnakeCase(body);
    expect(body).toMatchObject({ address: ADDR, status: 'pending_confirm', merchant_id: MERCHANT });
    expect(valuesCalls()).toContainEqual(
      expect.objectContaining({ address: ADDR, status: 'pending_confirm', role: 'sub' }),
    );
    expect(calls.filter((c) => c.method === 'execute')).toHaveLength(1); // advisory lock
  });

  it('demotes the current default when registering a new default', async () => {
    queue.push([{ id: MERCHANT }]);
    queue.push(undefined); // demote update
    queue.push([addressRow({ role: 'default' })]);
    const res = await inject('POST', `/api/v1/admin/merchants/${MERCHANT}/addresses`, {
      address: ADDR,
      role: 'default',
    });
    expect(res.statusCode).toBe(201);
    expect(setCalls()).toContainEqual(expect.objectContaining({ role: 'sub' }));
  });

  it('maps a duplicate address (insert conflict) to 409 ADDRESS_EXISTS', async () => {
    queue.push([{ id: MERCHANT }]);
    queue.push([]); // onConflictDoNothing → nothing returned
    const res = await inject('POST', `/api/v1/admin/merchants/${MERCHANT}/addresses`, {
      address: ADDR,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'ADDRESS_EXISTS' });
  });
});

describe('POST /addresses/:id/confirm', () => {
  it('moves pending_confirm → pending_test and starts watching the address', async () => {
    queue.push([addressRow()]);
    queue.push([addressRow({ status: 'pending_test', confirmedAt: now })]);
    const res = await inject(
      'POST',
      `/api/v1/admin/merchants/${MERCHANT}/addresses/${ADDRESS_ID}/confirm`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'pending_test', confirmed_at: now.toISOString() });
    expect(registerWatchedAddress).toHaveBeenCalledWith(ADDR);
    // Address lookup is scoped to the merchant in the URL.
    expect(whereParams()).toContainEqual(expect.arrayContaining([ADDRESS_ID, MERCHANT]));
  });

  it('409s when the address is not pending_confirm', async () => {
    queue.push([addressRow({ status: 'active' })]);
    const res = await inject(
      'POST',
      `/api/v1/admin/merchants/${MERCHANT}/addresses/${ADDRESS_ID}/confirm`,
    );
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'INVALID_STATE' });
  });

  it('404s an address that belongs to another merchant', async () => {
    queue.push([]);
    const res = await inject(
      'POST',
      `/api/v1/admin/merchants/${MERCHANT}/addresses/${ADDRESS_ID}/confirm`,
    );
    expect(res.statusCode).toBe(404);
  });

  it('still succeeds when the pending-set registration fails', async () => {
    registerWatchedAddress.mockRejectedValueOnce(new Error('redis down'));
    queue.push([addressRow()]);
    queue.push([addressRow({ status: 'pending_test' })]);
    const res = await inject(
      'POST',
      `/api/v1/admin/merchants/${MERCHANT}/addresses/${ADDRESS_ID}/confirm`,
    );
    expect(res.statusCode).toBe(200);
  });
});

describe('PUT /addresses/:id', () => {
  const url = `/api/v1/admin/merchants/${MERCHANT}/addresses/${ADDRESS_ID}`;

  it('rejects an empty patch with 400', async () => {
    queue.push([addressRow({ status: 'active' })]);
    const res = await inject('PUT', url, {});
    expect(res.statusCode).toBe(400);
  });

  it('disables an active address and clears a default role', async () => {
    queue.push([addressRow({ status: 'active', role: 'default', activatedAt: now })]);
    queue.push([addressRow({ status: 'disabled', role: 'sub', disabledAt: now })]);
    const res = await inject('PUT', url, { status: 'disabled' });
    expect(res.statusCode).toBe(200);
    expect(setCalls()).toContainEqual(
      expect.objectContaining({ status: 'disabled', role: 'sub', disabledAt: expect.any(Date) }),
    );
  });

  it('allows disabling an address that was never activated', async () => {
    queue.push([addressRow({ status: 'pending_test' })]);
    queue.push([addressRow({ status: 'disabled' })]);
    const res = await inject('PUT', url, { status: 'disabled' });
    expect(res.statusCode).toBe(200);
  });

  it('refuses to re-enable an address that was never activated', async () => {
    queue.push([addressRow({ status: 'disabled', activatedAt: null })]);
    const res = await inject('PUT', url, { status: 'active' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'INVALID_STATE' });
  });

  it('re-enables a previously activated address', async () => {
    queue.push([addressRow({ status: 'disabled', activatedAt: now })]);
    queue.push([addressRow({ status: 'active', activatedAt: now })]);
    const res = await inject('PUT', url, { status: 'active' });
    expect(res.statusCode).toBe(200);
    expect(setCalls()).toContainEqual(
      expect.objectContaining({ status: 'active', disabledAt: null }),
    );
  });

  it('refuses to make a non-active address the default', async () => {
    queue.push([addressRow({ status: 'pending_confirm' })]);
    const res = await inject('PUT', url, { role: 'default' });
    expect(res.statusCode).toBe(409);
  });

  it('makes an active address the default and demotes the others', async () => {
    queue.push([addressRow({ status: 'active', activatedAt: now })]);
    queue.push(undefined); // demote others
    queue.push([addressRow({ status: 'active', role: 'default' })]);
    const res = await inject('PUT', url, { role: 'default' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ role: 'default' });
    expect(setCalls()[0]).toMatchObject({ role: 'sub' });
    expect(setCalls()[1]).toMatchObject({ role: 'default' });
  });
});

describe('DELETE /addresses/:id', () => {
  const url = `/api/v1/admin/merchants/${MERCHANT}/addresses/${ADDRESS_ID}`;

  it('deletes a never-activated address', async () => {
    queue.push([addressRow({ status: 'pending_test' })]);
    queue.push(undefined); // delete
    const res = await inject('DELETE', url);
    expect(res.statusCode).toBe(204);
    expect(calls.filter((c) => c.method === 'delete')).toHaveLength(1);
  });

  it('refuses to delete an active or disabled address', async () => {
    queue.push([addressRow({ status: 'active' })]);
    const res = await inject('DELETE', url);
    expect(res.statusCode).toBe(409);
    expect(calls.filter((c) => c.method === 'delete')).toHaveLength(0);
  });
});

describe('GET /addresses/export', () => {
  const url = `/api/v1/admin/merchants/${MERCHANT}/addresses/export`;

  it('exports only active addresses, versioned by the newest change across all rows', async () => {
    const later = new Date('2026-09-06T12:00:00Z');
    queue.push([{ id: MERCHANT }]);
    queue.push([
      addressRow({ id: 'a', address: ADDR, status: 'active', role: 'default', updatedAt: now }),
      addressRow({
        id: 'b',
        address: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf',
        status: 'disabled',
        updatedAt: later,
      }),
    ]);
    const res = await inject('GET', url);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    assertSnakeCase(body);
    expect(body.addresses).toEqual([{ address: ADDR, label: null, role: 'default' }]);
    expect(body.version).toBe(later.toISOString()); // the disabled row bumped the version
  });

  it('returns a null version when the merchant has no addresses', async () => {
    queue.push([{ id: MERCHANT }]);
    queue.push([]);
    const res = await inject('GET', url);
    expect(res.json()).toMatchObject({ version: null, addresses: [] });
  });
});

describe('GET /unmatched-transfers', () => {
  const row = {
    id: UNMATCHED_ID,
    txHash: 'tx-u',
    merchantId: MERCHANT,
    address: ADDR,
    amount: '100.000000',
    fromAddress: 'TQ1zZmDXbX6qeQfambjkyqbHzDZLQqnWcA',
    blockNumber: 1,
    blockTimestamp: now,
    reason: 'no_pending_order_for_tail',
    claimedOrderId: null,
    claimedBy: null,
    claimedAt: null,
    createdAt: now,
  };

  it('lists unclaimed transfers by default with pagination metadata', async () => {
    queue.push([row]);
    queue.push([{ count: 1 }]);
    const res = await inject('GET', '/api/v1/admin/unmatched-transfers');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    assertSnakeCase(body);
    expect(body).toMatchObject({ total: 1, limit: 50, offset: 0 });
    expect(body.data[0]).toMatchObject({ tx_hash: 'tx-u', reason: 'no_pending_order_for_tail' });
  });

  it('rejects an invalid claimed filter', async () => {
    const res = await inject('GET', '/api/v1/admin/unmatched-transfers?claimed=maybe');
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /unmatched-transfers/:id/claim', () => {
  const url = `/api/v1/admin/unmatched-transfers/${UNMATCHED_ID}/claim`;

  it('passes order_id and force through to the engine', async () => {
    const res = await inject('POST', url, { order_id: ORDER_ID, force: true });
    expect(res.statusCode).toBe(200);
    expect(claimUnmatched).toHaveBeenCalledWith(UNMATCHED_ID, ORDER_ID, {
      claimedBy: 'admin',
      force: true,
    });
  });

  it('maps engine error codes to HTTP status', async () => {
    for (const [code, status] of [
      ['ALREADY_CLAIMED', 409],
      ['AMOUNT_MISMATCH', 409],
      ['ADDRESS_MISMATCH', 409],
      ['INVALID_STATE', 409],
      ['NOT_FOUND', 404],
    ] as const) {
      claimUnmatched.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
      const res = await inject('POST', url, { order_id: ORDER_ID });
      expect(res.statusCode, code).toBe(status);
      expect(res.json()).toMatchObject({ code });
    }
  });

  it('rejects a non-uuid order_id with 400', async () => {
    const res = await inject('POST', url, { order_id: 'nope' });
    expect(res.statusCode).toBe(400);
    expect(claimUnmatched).not.toHaveBeenCalled();
  });
});
