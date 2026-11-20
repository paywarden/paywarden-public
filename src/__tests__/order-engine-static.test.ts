/**
 * Static-address mode (ADDRESS_MODE=static) behaviour of OrderEngine, tested
 * against the real module with a recording fake DB. Each awaited query chain
 * resolves to the next queued result; every chain method call is recorded
 * (with whether it ran on the db or inside a transaction) so tests can
 * assert what was written and where. afterEach asserts the queue was fully
 * consumed, so a test cannot pass by accident on the default `[]`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

vi.stubEnv('ADDRESS_MODE', 'static');

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
    selectDistinct: (...args: unknown[]) => rec('selectDistinct', args),
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

const { OrderEngine } = await import('../services/order-engine.js');
const { EVENT_TYPE, ADDRESS_STATUS } = await import('../config/constants.js');
const { applyTail, formatTail, TAIL_MAX } = await import('../utils/tail.js');

const ADDR = 'TACBmCJj8xFqUjVqYx9TFhX5acU7zD5Win';
const ADDR2 = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf';
const PAYER = 'TQ1zZmDXbX6qeQfambjkyqbHzDZLQqnWcA';

const dialect = new PgDialect();
function whereParams(): unknown[][] {
  return calls
    .filter((c) => c.method === 'where')
    .map((c) => dialect.sqlToQuery(c.args[0] as SQL).params);
}
function valuesCalls(scope?: Scope): Record<string, unknown>[] {
  return calls
    .filter((c) => c.method === 'values' && (scope === undefined || c.scope === scope))
    .map((c) => c.args[0] as Record<string, unknown>);
}
function setCalls(scope?: Scope): Record<string, unknown>[] {
  return calls
    .filter((c) => c.method === 'set' && (scope === undefined || c.scope === scope))
    .map((c) => c.args[0] as Record<string, unknown>);
}

function makeEngine(redis?: { srem: ReturnType<typeof vi.fn>; sadd: ReturnType<typeof vi.fn> }) {
  const notify = vi.fn().mockResolvedValue(undefined);
  const engine = new OrderEngine({} as never, {} as never, { queueSweep: vi.fn() } as never);
  engine.setNotifier({ notify } as never);
  if (redis) engine.setRedis(redis as never);
  return { engine, notify };
}
function makeRedis() {
  return { srem: vi.fn().mockResolvedValue(1), sadd: vi.fn().mockResolvedValue(1) };
}

const pendingOrder = {
  id: 'ord-1',
  merchantId: 'm-1',
  address: ADDR,
  tail: '1370',
  amountExpected: '100.000000',
  amountPayable: '100.001370',
  status: 'pending',
  createdAt: new Date('2026-09-06T00:00:00Z'),
};
const activeAddress = {
  id: 'ma-1',
  merchantId: 'm-1',
  address: ADDR,
  status: ADDRESS_STATUS.ACTIVE,
};
const AFTER = Date.parse('2026-09-06T00:05:00Z');

beforeEach(() => {
  queue.length = 0;
  calls.length = 0;
});
afterEach(() => {
  expect(queue, 'every queued DB result must be consumed').toHaveLength(0);
});
afterAll(() => vi.unstubAllEnvs());

describe('onPaymentDetected (static): matching by address + tail', () => {
  it('finds the order by (address, tail, pending) and credits it inside one transaction', async () => {
    const { engine, notify } = makeEngine();
    queue.push([]); // transactions.tx_hash
    queue.push([]); // unmatched_transfers.tx_hash
    queue.push([activeAddress]);
    queue.push([pendingOrder]); // orders by (address, tail, pending)
    queue.push([{ id: 't-1' }]); // insert transactions → returning
    queue.push([{ id: 'ord-1' }]); // guarded update → detected
    queue.push(undefined); // insert payment_detected

    await engine.onPaymentDetected('tx-1', ADDR, '99.001370', PAYER, 0, AFTER);

    // Historical orders with the same tail must also be considered before crediting.
    expect(whereParams()).toContainEqual(expect.arrayContaining([ADDR, '1370']));
    expect(setCalls('tx')).toContainEqual(
      expect.objectContaining({ status: 'detected', amountReceived: '99.001370', txHash: 'tx-1' }),
    );
    expect(valuesCalls('tx')).toContainEqual(
      expect.objectContaining({ txHash: 'tx-1', orderId: 'ord-1' }),
    );
    expect(valuesCalls('tx')).toContainEqual(
      expect.objectContaining({ eventType: EVENT_TYPE.PAYMENT_DETECTED, orderId: 'ord-1' }),
    );
    expect(notify).not.toHaveBeenCalled();
  });

  it('records an unmatched transfer (reason no_pending_order_for_tail) and alerts once', async () => {
    const { engine, notify } = makeEngine();
    queue.push([]);
    queue.push([]);
    queue.push([activeAddress]);
    queue.push([]); // no order for tail 0000
    queue.push([{ id: 'um-1' }]); // unmatched insert → returning

    await engine.onPaymentDetected('tx-2', ADDR, '100.000000', PAYER, 0, AFTER);

    expect(whereParams()).toContainEqual(expect.arrayContaining([ADDR, '0000']));
    expect(valuesCalls()).toContainEqual(
      expect.objectContaining({
        txHash: 'tx-2',
        merchantId: 'm-1',
        address: ADDR,
        amount: '100.000000',
        reason: 'no_pending_order_for_tail',
      }),
    );
    expect(setCalls()).toHaveLength(0);
    expect(notify).toHaveBeenCalledWith({
      type: 'unmatched_payment',
      address: ADDR,
      txHash: 'tx-2',
      amount: '100.000000',
    });
  });

  it('skips a transfer already recorded as unmatched before any matching (re-scan)', async () => {
    const { engine, notify } = makeEngine();
    queue.push([]);
    queue.push([{ id: 'um-1' }]); // already in unmatched_transfers

    await engine.onPaymentDetected('tx-2', ADDR, '100.000000', PAYER, 0);

    expect(calls.filter((c) => c.method === 'select')).toHaveLength(2);
    expect(calls.filter((c) => c.method === 'insert')).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('records a transfer that predates the order as unmatched (reason predates_order)', async () => {
    const { engine } = makeEngine();
    queue.push([]);
    queue.push([]);
    queue.push([activeAddress]);
    queue.push([pendingOrder]);
    queue.push([{ id: 'um-2' }]);

    await engine.onPaymentDetected(
      'tx-3',
      ADDR,
      '100.001370',
      PAYER,
      0,
      Date.parse('2026-09-05T23:00:00Z'),
    );

    expect(setCalls()).toHaveLength(0);
    expect(valuesCalls()).toContainEqual(
      expect.objectContaining({
        txHash: 'tx-3',
        reason: 'predates_order',
        blockTimestamp: expect.any(Date),
      }),
    );
  });

  it('records the transfer as unmatched when the order left pending during the credit', async () => {
    const { engine } = makeEngine();
    queue.push([]);
    queue.push([]);
    queue.push([activeAddress]);
    queue.push([pendingOrder]);
    queue.push([{ id: 't-4' }]); // transactions insert ok
    queue.push([]); // guarded update matched 0 rows → rollback
    queue.push([{ id: 'um-4' }]); // unmatched insert

    await engine.onPaymentDetected('tx-4', ADDR, '100.001370', PAYER, 0, AFTER);

    expect(valuesCalls('db')).toContainEqual(
      expect.objectContaining({ txHash: 'tx-4', reason: 'order_left_pending' }),
    );
    expect(
      valuesCalls('tx').find((v) => v.eventType === EVENT_TYPE.PAYMENT_DETECTED),
    ).toBeUndefined();
  });

  it('refuses to flip the order when the tx_hash already belongs to something else', async () => {
    const { engine, notify } = makeEngine();
    queue.push([]);
    queue.push([]);
    queue.push([activeAddress]);
    queue.push([pendingOrder]);
    queue.push([]); // transactions insert conflict → nothing inserted

    await engine.onPaymentDetected('tx-dup', ADDR, '100.001370', PAYER, 0, AFTER);

    expect(setCalls()).toHaveLength(0);
    expect(valuesCalls('db')).toHaveLength(0); // not recorded as unmatched either
    expect(notify).not.toHaveBeenCalled();
  });

  it('ignores a transfer already recorded in transactions', async () => {
    const { engine, notify } = makeEngine();
    queue.push([{ id: 't-known' }]);

    await engine.onPaymentDetected('tx-known', ADDR, '100.001370', PAYER, 0);

    expect(calls.filter((c) => c.method === 'insert')).toHaveLength(0);
    expect(setCalls()).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('onPaymentDetected (static): block-scan pending set on a shared address', () => {
  it('keeps the address in the pending set while other orders are still pending', async () => {
    const redis = makeRedis();
    const { engine } = makeEngine(redis);
    queue.push([]);
    queue.push([]);
    queue.push([activeAddress]);
    queue.push([pendingOrder]);
    queue.push([{ id: 't-1' }]);
    queue.push([{ id: 'ord-1' }]);
    queue.push(undefined);
    queue.push([{ count: 2 }]); // other pending orders on ADDR

    await engine.onPaymentDetected('tx-1', ADDR, '100.001370', PAYER, 0, AFTER);

    expect(redis.srem).not.toHaveBeenCalled();
  });

  it('removes the address from the pending set once nothing is waiting on it', async () => {
    const redis = makeRedis();
    const { engine } = makeEngine(redis);
    queue.push([]);
    queue.push([]);
    queue.push([activeAddress]);
    queue.push([pendingOrder]);
    queue.push([{ id: 't-1' }]);
    queue.push([{ id: 'ord-1' }]);
    queue.push(undefined);
    queue.push([{ count: 0 }]);

    await engine.onPaymentDetected('tx-1', ADDR, '100.001370', PAYER, 0, AFTER);

    expect(redis.srem).toHaveBeenCalledWith(expect.any(String), ADDR);
  });
});

describe('onPaymentDetected (static): address activation', () => {
  const pendingTest = {
    ...activeAddress, status: ADDRESS_STATUS.PENDING_TEST,
    confirmedAt: new Date('2026-09-06T00:00:00Z'),
  };

  it('does not activate an address from a transfer without a chain timestamp', async () => {
    const { engine } = makeEngine();
    queue.push([], [], [pendingTest], [{ id: 'unverified' }]);
    await engine.onPaymentDetected('no-timestamp', ADDR, '0.500000', PAYER, 0);
    expect(setCalls()).toHaveLength(0);
    expect(valuesCalls('db')).toContainEqual(expect.objectContaining({
      txHash: 'no-timestamp', reason: 'unverified_test_transfer',
    }));
  });

  it('activates a pending_test address on an inbound transfer ≥ minimum and releases it from the pending set', async () => {
    const redis = makeRedis();
    const { engine } = makeEngine(redis);
    queue.push([]);
    queue.push([]);
    queue.push([pendingTest]);
    queue.push(undefined); // insert transactions (orderId null)
    queue.push([{ id: 'ma-1' }]); // update → active
    queue.push([{ count: 0 }]); // releasePendingAddress count

    await engine.onPaymentDetected('tx-test', ADDR, '0.500000', PAYER, 0, AFTER);

    expect(valuesCalls('tx')).toContainEqual(
      expect.objectContaining({ txHash: 'tx-test', orderId: null }),
    );
    expect(setCalls('tx')).toContainEqual(
      expect.objectContaining({ status: ADDRESS_STATUS.ACTIVE, testTxHash: 'tx-test' }),
    );
    expect(redis.srem).toHaveBeenCalledWith(expect.any(String), ADDR);
  });

  it('keeps a pending_test address watched when the transfer is below the minimum', async () => {
    const redis = makeRedis();
    const { engine } = makeEngine(redis);
    queue.push([]);
    queue.push([]);
    queue.push([pendingTest]);
    queue.push(undefined); // insert transactions — still recorded

    await engine.onPaymentDetected('tx-dust', ADDR, '0.010000', PAYER, 0, AFTER);

    expect(setCalls()).toHaveLength(0);
    expect(valuesCalls('tx')).toContainEqual(
      expect.objectContaining({ txHash: 'tx-dust', orderId: null }),
    );
    expect(redis.srem).not.toHaveBeenCalled();
  });
});

describe('claimUnmatched', () => {
  const unmatched = {
    id: 'um-1',
    txHash: 'tx-u',
    merchantId: 'm-1',
    address: ADDR,
    amount: '100.000000',
    fromAddress: PAYER,
    blockNumber: 0,
    claimedOrderId: null,
  };
  const claim = (engine: InstanceType<typeof OrderEngine>, force = false) =>
    engine.claimUnmatched('um-1', 'ord-1', { claimedBy: 'admin', force });

  it('rejects a transfer that is already claimed', async () => {
    const { engine } = makeEngine();
    queue.push([{ ...unmatched, claimedOrderId: 'ord-x' }]);
    await expect(claim(engine)).rejects.toMatchObject({ code: 'ALREADY_CLAIMED' });
  });

  it('rejects an order that is not pending', async () => {
    const { engine } = makeEngine();
    queue.push([unmatched]);
    queue.push([{ ...pendingOrder, status: 'detected' }]);
    await expect(claim(engine)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('rejects an order on a different address', async () => {
    const { engine } = makeEngine();
    queue.push([unmatched]);
    queue.push([{ ...pendingOrder, address: ADDR2 }]);
    await expect(claim(engine)).rejects.toMatchObject({ code: 'ADDRESS_MISMATCH' });
  });

  it('rejects a >10% amount difference unless forced', async () => {
    const { engine } = makeEngine();
    queue.push([{ ...unmatched, amount: '50.000000' }]);
    queue.push([pendingOrder]);
    await expect(claim(engine)).rejects.toMatchObject({ code: 'AMOUNT_MISMATCH' });
  });

  it('loses a concurrent claim: guarded UPDATE matches 0 rows → ALREADY_CLAIMED, nothing credited', async () => {
    const { engine } = makeEngine();
    queue.push([unmatched]);
    queue.push([pendingOrder]);
    queue.push([]); // UPDATE ... WHERE claimed_order_id IS NULL → 0 rows

    await expect(claim(engine)).rejects.toMatchObject({ code: 'ALREADY_CLAIMED' });

    expect(setCalls('tx').find((s) => s.status === 'detected')).toBeUndefined();
    expect(valuesCalls('tx')).toHaveLength(0);
  });

  it('rolls back when the order left pending between the read and the credit', async () => {
    const { engine } = makeEngine();
    queue.push([unmatched]);
    queue.push([pendingOrder]);
    queue.push([{ id: 'um-1' }]); // claim marked
    queue.push([{ id: 't-u' }]); // transactions insert ok
    queue.push([]); // guarded order update → 0 rows

    await expect(claim(engine)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(
      valuesCalls('tx').find((v) => v.eventType === EVENT_TYPE.PAYMENT_CLAIMED),
    ).toBeUndefined();
  });

  it('claims, credits and writes payment_claimed inside a single transaction', async () => {
    const { engine } = makeEngine();
    queue.push([unmatched]);
    queue.push([pendingOrder]);
    queue.push([{ id: 'um-1' }]); // claim marked (guarded)
    queue.push([{ id: 't-u' }]); // transactions insert
    queue.push([{ id: 'ord-1' }]); // order → detected
    queue.push(undefined); // payment_detected
    queue.push(undefined); // payment_claimed

    await claim(engine);

    // The claim mark is the first write and is guarded on claimed_order_id IS NULL.
    const firstSet = calls.find((c) => c.method === 'set');
    expect(firstSet).toMatchObject({
      scope: 'tx',
      args: [expect.objectContaining({ claimedOrderId: 'ord-1', claimedBy: 'admin' })],
    });
    expect(whereParams()).toContainEqual(expect.arrayContaining(['um-1']));
    expect(setCalls('tx')).toContainEqual(
      expect.objectContaining({ status: 'detected', txHash: 'tx-u' }),
    );
    expect(valuesCalls('tx')).toContainEqual(
      expect.objectContaining({
        eventType: EVENT_TYPE.PAYMENT_CLAIMED,
        payload: expect.objectContaining({
          unmatched_id: 'um-1',
          claimed_by: 'admin',
          forced: false,
        }),
      }),
    );
    expect(calls.filter((c) => c.method === 'transaction')).toHaveLength(0); // sanity: transaction is not a recorded chain call
  });

  it('force bypasses the amount guard and records forced=true', async () => {
    const { engine } = makeEngine();
    queue.push([{ ...unmatched, amount: '50.000000' }]);
    queue.push([pendingOrder]);
    queue.push([{ id: 'um-1' }]);
    queue.push([{ id: 't-u' }]);
    queue.push([{ id: 'ord-1' }]);
    queue.push(undefined);
    queue.push(undefined);

    await claim(engine, true);

    expect(valuesCalls('tx')).toContainEqual(
      expect.objectContaining({
        eventType: EVENT_TYPE.PAYMENT_CLAIMED,
        payload: expect.objectContaining({ forced: true }),
      }),
    );
  });
});

describe('createOrder (static)', () => {
  const input = {
    externalId: 'ext-1',
    amount: '100',
    callbackUrl: 'https://merchant.example/webhook',
    merchantId: 'm-1',
    webhookSecret: 'whsec_test',
  };
  const insertedOrder = () => valuesCalls('tx').find((v) => v.externalId === 'ext-1')!;

  it('allocates the default address plus a free tail and stores amount_payable', async () => {
    const redis = makeRedis();
    const { engine } = makeEngine(redis);
    queue.push([]); // existing order by external_id
    queue.push([{ address: ADDR, role: 'default' }]); // active addresses
    queue.push([{ tail: '0001' }, { tail: '0002' }]); // tails in use
    queue.push([{ id: 'ord-new', address: ADDR, tail: '4242', amountPayable: '100.004242' }]);
    queue.push(undefined); // order_created event

    const { order, reused } = await engine.createOrder(input);

    expect(reused).toBe(false);
    expect(order.id).toBe('ord-new');
    const inserted = insertedOrder();
    expect(inserted.address).toBe(ADDR);
    expect(inserted.derivationIdx).toBeNull();
    expect(inserted.tail).toMatch(/^\d{4}$/);
    expect(['0001', '0002']).not.toContain(inserted.tail);
    expect(inserted.amountPayable).toBe(applyTail('100.000000', inserted.tail as string));
    // order_created carries the payable amount for event-stream projection.
    expect(valuesCalls('tx')).toContainEqual(
      expect.objectContaining({
        eventType: EVENT_TYPE.ORDER_CREATED,
        payload: expect.objectContaining({
          tail: '4242',
          amount_payable: '100.004242',
          address: ADDR,
        }),
      }),
    );
    expect(redis.sadd).toHaveBeenCalledWith(expect.any(String), ADDR);
  });

  it('moves to the next address when the first one is saturated', async () => {
    const { engine } = makeEngine();
    const full = Array.from({ length: TAIL_MAX }, (_, i) => ({ tail: formatTail(i + 1) }));
    queue.push([]);
    queue.push([
      { address: ADDR, role: 'default' },
      { address: ADDR2, role: 'sub' },
    ]);
    queue.push(full); // ADDR: every tail taken
    queue.push([]); // ADDR2: free
    queue.push([{ id: 'ord-new', address: ADDR2 }]);
    queue.push(undefined);

    await engine.createOrder(input);

    expect(insertedOrder().address).toBe(ADDR2);
  });

  it('uses a backup address only when no default/sub address is active', async () => {
    const { engine } = makeEngine();
    queue.push([]);
    queue.push([
      { address: ADDR, role: 'backup' },
      { address: ADDR2, role: 'sub' },
    ]);
    queue.push([]); // tails for ADDR2 (backup ADDR is skipped)
    queue.push([{ id: 'ord-new', address: ADDR2 }]);
    queue.push(undefined);

    await engine.createOrder(input);

    expect(insertedOrder().address).toBe(ADDR2);
    expect(whereParams()).not.toContainEqual(expect.arrayContaining([ADDR]));
  });

  it('falls back to the backup address when it is the only active one', async () => {
    const { engine } = makeEngine();
    queue.push([]);
    queue.push([{ address: ADDR, role: 'backup' }]);
    queue.push([]);
    queue.push([{ id: 'ord-new', address: ADDR }]);
    queue.push(undefined);

    await engine.createOrder(input);

    expect(insertedOrder().address).toBe(ADDR);
  });

  it('rejects amounts with more than two decimals', async () => {
    const { engine } = makeEngine();
    queue.push([]);
    await expect(engine.createOrder({ ...input, amount: '100.123' })).rejects.toMatchObject({
      code: 'INVALID_AMOUNT',
    });
  });

  it('fails with NO_ADDRESSES when the merchant has no active address', async () => {
    const { engine } = makeEngine();
    queue.push([]);
    queue.push([]);
    await expect(engine.createOrder(input)).rejects.toMatchObject({ code: 'NO_ADDRESSES' });
  });

  it('fails with NO_ADDRESSES when every address is saturated', async () => {
    const { engine } = makeEngine();
    const full = Array.from({ length: TAIL_MAX }, (_, i) => ({ tail: formatTail(i + 1) }));
    queue.push([]);
    queue.push([{ address: ADDR, role: 'default' }]);
    queue.push(full);
    await expect(engine.createOrder(input)).rejects.toMatchObject({ code: 'NO_ADDRESSES' });
  });
});
