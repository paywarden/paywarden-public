/**
 * HD-mode (ADDRESS_MODE=hd, the default) regression coverage for the
 * OrderEngine paths that were restructured by the static-address work:
 * createOrder allocation and onPaymentDetected crediting. Same recording
 * fake-DB approach as order-engine-static.test.ts.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubEnv('ADDRESS_MODE', 'hd');

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
const { EVENT_TYPE } = await import('../config/constants.js');

const ADDR = 'TACBmCJj8xFqUjVqYx9TFhX5acU7zD5Win';
const PAYER = 'TQ1zZmDXbX6qeQfambjkyqbHzDZLQqnWcA';

function valuesCalls(scope?: Scope): Record<string, unknown>[] {
  return calls
    .filter((c) => c.method === 'values' && (scope === undefined || c.scope === scope))
    .map((c) => c.args[0] as Record<string, unknown>);
}
function setCalls(): Record<string, unknown>[] {
  return calls.filter((c) => c.method === 'set').map((c) => c.args[0] as Record<string, unknown>);
}

function makeEngine() {
  const deriveAddresses = vi.fn();
  const notify = vi.fn().mockResolvedValue(undefined);
  const notifyWebhook = vi.fn().mockResolvedValue(undefined);
  const engine = new OrderEngine(
    { deriveAddresses } as never,
    { notify: notifyWebhook } as never,
    { queueSweep: vi.fn() } as never,
  );
  engine.setNotifier({ notify } as never);
  return { engine, deriveAddresses, notify, notifyWebhook };
}

const pendingOrder = {
  id: 'ord-1',
  merchantId: 'm-1',
  address: ADDR,
  tail: null,
  amountExpected: '100.000000',
  amountPayable: null,
  status: 'pending',
  createdAt: new Date('2026-09-06T00:00:00Z'),
};

beforeEach(() => {
  queue.length = 0;
  calls.length = 0;
});
afterEach(() => {
  expect(queue, 'every queued DB result must be consumed').toHaveLength(0);
});
afterAll(() => vi.unstubAllEnvs());

describe('createOrder (hd)', () => {
  it('allocates from the derived-address pool and records the derivation index, no tail', async () => {
    const { engine, deriveAddresses } = makeEngine();
    queue.push([]); // existing order by external_id
    queue.push([{ count: 30 }]); // free pool count (≥ ADDRESS_POOL_MIN → no refill)
    queue.push([{ id: 'a-7', address: ADDR, derivationIdx: 7 }]); // FOR UPDATE SKIP LOCKED
    queue.push([{ id: 'ord-new', address: ADDR, tail: null, amountPayable: null }]); // insert order
    queue.push(undefined); // update addresses allocated
    queue.push(undefined); // order_created event

    const { order } = await engine.createOrder({
      externalId: 'ext-1',
      amount: '100',
      callbackUrl: 'https://merchant.example/webhook',
      merchantId: 'm-1',
      webhookSecret: 'whsec_test',
    });

    expect(order.id).toBe('ord-new');
    expect(deriveAddresses).not.toHaveBeenCalled();
    const inserted = valuesCalls('tx').find((v) => v.externalId === 'ext-1')!;
    expect(inserted).toMatchObject({
      address: ADDR,
      derivationIdx: 7,
      tail: null,
      amountPayable: null,
    });
    expect(setCalls()).toContainEqual(
      expect.objectContaining({ isAllocated: true, allocatedTo: 'ord-new' }),
    );
    expect(valuesCalls('tx')).toContainEqual(
      expect.objectContaining({
        eventType: EVENT_TYPE.ORDER_CREATED,
        payload: expect.objectContaining({ address: ADDR, tail: null, amount_payable: null }),
      }),
    );
  });
});

describe('onPaymentDetected (hd)', () => {
  it('credits the single pending order on the address', async () => {
    const { engine } = makeEngine();
    queue.push([pendingOrder]); // pending order by address
    queue.push([{ id: 't-1' }]); // transactions insert
    queue.push([{ id: 'ord-1' }]); // guarded update
    queue.push(undefined); // payment_detected

    await engine.onPaymentDetected(
      'tx-1',
      ADDR,
      '100.000000',
      PAYER,
      0,
      Date.parse('2026-09-06T00:05:00Z'),
    );

    expect(setCalls()).toContainEqual(
      expect.objectContaining({ status: 'detected', txHash: 'tx-1' }),
    );
    expect(valuesCalls('tx')).toContainEqual(
      expect.objectContaining({ eventType: EVENT_TYPE.PAYMENT_DETECTED }),
    );
  });

  it('records a late payment when the order left pending during the credit', async () => {
    const { engine, notify } = makeEngine();
    queue.push([pendingOrder]);
    queue.push([{ id: 't-1' }]); // transactions insert (rolled back with the tx)
    queue.push([]); // guarded update → 0 rows
    queue.push([{ id: 't-1' }]); // recordLatePayment: transactions insert
    queue.push(undefined); // late_payment_detected event

    await engine.onPaymentDetected(
      'tx-1',
      ADDR,
      '100.000000',
      PAYER,
      0,
      Date.parse('2026-09-06T00:05:00Z'),
    );

    expect(valuesCalls('tx')).toContainEqual(
      expect.objectContaining({
        eventType: EVENT_TYPE.LATE_PAYMENT_DETECTED,
        payload: expect.objectContaining({ reason: 'order_left_pending' }),
      }),
    );
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'late_payment', orderId: 'ord-1' }),
    );
  });

  it('does not flip the order when the tx_hash is already recorded', async () => {
    const { engine, notify } = makeEngine();
    queue.push([pendingOrder]);
    queue.push([]); // transactions insert conflict

    await engine.onPaymentDetected('tx-dup', ADDR, '100.000000', PAYER, 0);

    expect(setCalls()).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('records a late payment to an expired order on an issued HD address', async () => {
    const { engine, notify } = makeEngine();
    queue.push([{ ...pendingOrder, status: 'expired' }]);
    queue.push([{ id: 't-late' }]);
    queue.push(undefined);

    await engine.onPaymentDetected('tx-late', ADDR, '100.000000', PAYER, 200);

    expect(setCalls()).toHaveLength(0);
    expect(valuesCalls('tx')).toContainEqual(
      expect.objectContaining({
        orderId: pendingOrder.id,
        eventType: EVENT_TYPE.LATE_PAYMENT_DETECTED,
        payload: expect.objectContaining({ reason: 'order_not_pending' }),
      }),
    );
    expect(notify).toHaveBeenCalledOnce();
  });

  it('leaves a payment to a historically reused address for manual review', async () => {
    const { engine } = makeEngine();
    queue.push([pendingOrder, { ...pendingOrder, id: 'ord-prior', status: 'expired' }]);
    queue.push([{ id: 't-ambiguous' }]);
    queue.push(undefined);

    await engine.onPaymentDetected('tx-ambiguous', ADDR, '100.000000', PAYER, 200);

    expect(setCalls()).toHaveLength(0);
    expect(valuesCalls('tx')).toContainEqual(
      expect.objectContaining({
        eventType: EVENT_TYPE.LATE_PAYMENT_DETECTED,
        payload: expect.objectContaining({ reason: 'reused_address' }),
      }),
    );
  });

  it('does nothing when the address has no order history', async () => {
    const { engine } = makeEngine();
    queue.push([]);

    await engine.onPaymentDetected('tx-none', ADDR, '100.000000', PAYER, 0);

    expect(calls.filter((c) => c.method === 'insert')).toHaveLength(0);
  });
});

describe('onPaymentConfirmed', () => {
  it('queues one webhook when confirmation workers race', async () => {
    const { engine, notifyWebhook } = makeEngine();
    const detectedOrder = {
      ...pendingOrder,
      status: 'detected',
      amountReceived: '100.000000',
      txHash: 'tx-confirmed',
    };
    queue.push([detectedOrder], [{ id: pendingOrder.id }], [{ fromAddress: PAYER }], undefined, undefined);
    queue.push([detectedOrder], []); // Another worker read the old state and lost the update.

    await engine.onPaymentConfirmed('tx-confirmed', 19, 81);
    await engine.onPaymentConfirmed('tx-confirmed', 19, 81);

    expect(notifyWebhook).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: pendingOrder.id, status: 'confirmed' }),
      'payment.confirmed',
    );
    expect(valuesCalls('tx').filter((value) => value.eventType === EVENT_TYPE.PAYMENT_CONFIRMED))
      .toHaveLength(1);
  });
});
