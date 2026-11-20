/**
 * chain-watcher address-scan mode against the real module: BullMQ and
 * TronGrid (undici fetch) are mocked, the DB is a recording fake, and the
 * worker processor captured from the Worker constructor is invoked directly.
 * Covers what static-address mode changed: one scan per shared address with
 * the earliest timestamp, pending_test addresses being watched, and the
 * amount/timestamp handed to the engine.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubEnv('ADDRESS_MODE', 'static');
vi.stubEnv('SCAN_MODE', 'address');

const queue: unknown[] = [];
const calls: Array<{ method: string; args: unknown[] }> = [];

function builder(): unknown {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve(queue.length > 0 ? queue.shift() : []);
        }
        return (...args: unknown[]) => {
          calls.push({ method: String(prop), args });
          return proxy;
        };
      },
    },
  );
  return proxy;
}
const fakeDb = {
  select: (...args: unknown[]) => {
    calls.push({ method: 'select', args });
    return builder();
  },
  insert: (...args: unknown[]) => {
    calls.push({ method: 'insert', args });
    return builder();
  },
};
vi.mock('../db/index.js', () => ({ getDb: () => fakeDb }));

let capturedProcessor: ((job: { name: string }) => Promise<void>) | null = null;
vi.mock('bullmq', () => ({
  Queue: class {
    async getRepeatableJobs() {
      return [];
    }
    async removeRepeatableByKey() {}
    async add() {}
  },
  Worker: class {
    closing = false;
    constructor(_name: string, processor: (job: { name: string }) => Promise<void>) {
      capturedProcessor = processor;
    }
    on() {}
  },
}));

const fetchMock = vi.fn();
vi.mock('undici', () => ({ fetch: (...args: unknown[]) => fetchMock(...args) }));

const { initChainWatcher, rebuildPendingAddressSet } = await import('../services/chain-watcher.js');
const { env } = await import('../config/env.js');
const { REDIS_KEYS } = await import('../config/constants.js');

const ADDR = 'TACBmCJj8xFqUjVqYx9TFhX5acU7zD5Win';
const ADDR2 = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf';
const PAYER = 'TQ1zZmDXbX6qeQfambjkyqbHzDZLQqnWcA';
const usdtTransfer = { type: 'Transfer', token_info: { address: env.USDT_CONTRACT } };

function tronGridResponse(data: unknown[], fingerprint?: string) {
  return { ok: true, status: 200, json: async () => ({ success: true, data, meta: { fingerprint } }) };
}

const onPaymentDetected = vi.fn().mockResolvedValue(undefined);
const engine = { onPaymentDetected, alertStuckDetected: vi.fn() };

beforeEach(() => {
  queue.length = 0;
  calls.length = 0;
  fetchMock.mockReset();
  onPaymentDetected.mockClear();
  initChainWatcher('redis://localhost:6379', engine as never);
  expect(capturedProcessor).toBeTypeOf('function');
});
afterEach(() => {
  expect(queue, 'every queued DB result must be consumed').toHaveLength(0);
});
afterAll(() => vi.unstubAllEnvs());

describe('rebuildPendingAddressSet (static)', () => {
  it('adds each watched address once, including pending_test merchant addresses', async () => {
    const redis = { del: vi.fn().mockResolvedValue(1), sadd: vi.fn().mockResolvedValue(1) };
    queue.push([
      { address: ADDR, createdAt: new Date('2026-09-06T00:00:00Z') },
      { address: ADDR, createdAt: new Date('2026-09-06T00:10:00Z') },
    ]); // pending orders (two on the same address)
    queue.push([{ address: ADDR2, confirmedAt: new Date('2026-09-06T00:05:00Z') }]); // pending_test

    await rebuildPendingAddressSet(redis as never);

    expect(redis.del).toHaveBeenCalledTimes(1);
    expect(redis.sadd).toHaveBeenCalledTimes(1);
    const added = redis.sadd.mock.calls[0].slice(1);
    expect(added).toHaveLength(2);
    expect(added).toEqual(expect.arrayContaining([ADDR, ADDR2]));
  });
});

describe('address scan (static)', () => {
  it('follows every page so older payments cannot be hidden behind a full page', async () => {
    queue.push([{ address: ADDR, createdAt: new Date('2026-09-06T00:00:00Z') }], []);
    const transfer = (hash: string) => ({
      ...usdtTransfer, transaction_id: hash, from: PAYER, to: ADDR,
      value: '100001370', block_timestamp: 1_800_000_000_000,
    });
    fetchMock
      .mockResolvedValueOnce(tronGridResponse(Array.from({ length: 200 }, (_, i) => transfer(`recent-${i}`)), 'next'))
      .mockResolvedValueOnce(tronGridResponse([transfer('older-payment')]));

    await capturedProcessor!({ name: 'scan' });

    expect(onPaymentDetected.mock.calls.some(([hash]) => hash === 'older-payment')).toBe(true);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('fingerprint=next');
    const first = new URL(String(fetchMock.mock.calls[0][0]));
    const second = new URL(String(fetchMock.mock.calls[1][0]));
    second.searchParams.delete('fingerprint');
    expect(second.toString()).toBe(first.toString());
  });

  it('stops a repeated pagination cursor instead of looping forever', async () => {
    queue.push([{ address: ADDR, createdAt: new Date('2026-09-06T00:00:00Z') }], []);
    fetchMock.mockResolvedValue(tronGridResponse([], 'repeated'));
    await capturedProcessor!({ name: 'scan' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onPaymentDetected).not.toHaveBeenCalled();
  });

  it('scans a shared address once from the earliest pending order and hands each transfer to the engine', async () => {
    queue.push([
      { address: ADDR, createdAt: new Date('2026-09-06T00:10:00Z') },
      { address: ADDR, createdAt: new Date('2026-09-06T00:00:00Z') },
    ]);
    queue.push([]); // no pending_test addresses
    fetchMock.mockResolvedValueOnce(
      tronGridResponse([
        { ...usdtTransfer, transaction_id: 'approval', type: 'Approval', to: ADDR, value: '100001370' },
        {
          ...usdtTransfer,
          transaction_id: 'tx-a',
          from: PAYER,
          to: ADDR,
          value: '100001370',
          block_timestamp: 1_800_000_000_000,
        },
        { ...usdtTransfer, transaction_id: 'tx-other', from: PAYER, to: ADDR2, value: '1', block_timestamp: 1 },
      ]),
    );

    await capturedProcessor!({ name: 'scan' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain(`/v1/accounts/${ADDR}/transactions/trc20`);
    expect(url).toContain('only_confirmed=true');
    expect(url).toContain('limit=200');
    expect(url).toContain(`min_timestamp=${Date.parse('2026-09-06T00:00:00Z')}`);

    // Only the USDT transfer to the watched address reaches the engine.
    expect(onPaymentDetected).toHaveBeenCalledTimes(1);
    expect(onPaymentDetected).toHaveBeenCalledWith(
      'tx-a',
      ADDR,
      '100.001370',
      PAYER,
      0,
      1_800_000_000_000,
    );
  });

  it('scans pending_test addresses so the activation transfer is seen', async () => {
    queue.push([]); // no pending orders
    queue.push([{ address: ADDR2, confirmedAt: new Date('2026-09-06T00:05:00Z') }]);
    fetchMock.mockResolvedValueOnce(
      tronGridResponse([
        { ...usdtTransfer, transaction_id: 'tx-test', from: PAYER, to: ADDR2, value: '500000', block_timestamp: 5 },
      ]),
    );

    await capturedProcessor!({ name: 'scan' });

    expect(String(fetchMock.mock.calls[0][0])).toContain(
      `/v1/accounts/${ADDR2}/transactions/trc20`,
    );
    expect(onPaymentDetected).toHaveBeenCalledWith('tx-test', ADDR2, '0.500000', PAYER, 0, 5);
  });

  it('does nothing when nothing is watched', async () => {
    queue.push([]);
    queue.push([]);

    await capturedProcessor!({ name: 'scan' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(onPaymentDetected).not.toHaveBeenCalled();
  });

  it('keeps scanning the remaining addresses when TronGrid errors on one', async () => {
    queue.push([
      { address: ADDR, createdAt: new Date('2026-09-06T00:00:00Z') },
      { address: ADDR2, createdAt: new Date('2026-09-06T00:00:00Z') },
    ]);
    queue.push([]);
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) })
      .mockResolvedValueOnce(
        tronGridResponse([
          { ...usdtTransfer, transaction_id: 'tx-b', from: PAYER, to: ADDR2, value: '2000000', block_timestamp: 9 },
        ]),
      );

    await capturedProcessor!({ name: 'scan' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onPaymentDetected).toHaveBeenCalledTimes(1);
    expect(onPaymentDetected).toHaveBeenCalledWith('tx-b', ADDR2, '2.000000', PAYER, 0, 9);
  });
});

describe('block scan checkpoint', () => {
  const redis = { set: vi.fn().mockResolvedValue('OK') };
  const confirmedHead = {
    ok: true,
    json: async () => ({ block_header: { raw_data: { number: 42 } } }),
  };
  const checkpointWrites = () => calls
    .filter((call) => call.method === 'values')
    .map((call) => (call.args[0] as { value: string }).value);

  beforeEach(() => {
    env.SCAN_MODE = 'block';
    redis.set.mockClear();
    initChainWatcher('redis://localhost:6379', engine as never, redis as never);
  });

  afterEach(() => {
    env.SCAN_MODE = 'address';
    vi.restoreAllMocks();
  });

  it('keeps the PostgreSQL checkpoint on pagination failure and retries from it', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    queue.push([{ value: '41' }]);
    fetchMock
      .mockResolvedValueOnce(confirmedHead)
      .mockResolvedValueOnce(tronGridResponse([])) // delayed replay of block 37
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: [], meta: { fingerprint: 'next' } }),
      })
      .mockResolvedValueOnce({ ok: false, status: 429 });

    await capturedProcessor!({ name: 'scan' });
    expect(checkpointWrites()).toEqual([]);
    expect(redis.set).toHaveBeenCalledExactlyOnceWith(REDIS_KEYS.LAST_SCANNED_BLOCK, 41);

    await capturedProcessor!({ name: 'scan' }); // retry backoff has not elapsed
    expect(fetchMock).toHaveBeenCalledTimes(4);

    clock.mockReturnValue(13_000);
    queue.push([{ value: '41' }]);
    fetchMock
      .mockResolvedValueOnce(confirmedHead)
      .mockResolvedValueOnce(tronGridResponse([]))
      .mockResolvedValueOnce(tronGridResponse([]));

    await capturedProcessor!({ name: 'scan' });
    expect(fetchMock.mock.calls[5]?.[0]).toContain('block_number=37');
    expect(fetchMock.mock.calls[6]?.[0]).toContain('block_number=42');
    expect(checkpointWrites()).toEqual(['42']);
    expect(redis.set).toHaveBeenLastCalledWith(REDIS_KEYS.LAST_SCANNED_BLOCK, 42);
  });

  it('starts from the checkpoint established by a concurrent worker', async () => {
    queue.push([], [{ value: '40' }]); // Another worker inserts after our initial read.
    fetchMock
      .mockResolvedValueOnce(confirmedHead)
      .mockResolvedValue(tronGridResponse([]));

    await capturedProcessor!({ name: 'scan' });

    expect(fetchMock.mock.calls[2]?.[0]).toContain('block_number=41');
    expect(fetchMock.mock.calls[4]?.[0]).toContain('block_number=42');
    expect(redis.set).toHaveBeenNthCalledWith(1, REDIS_KEYS.LAST_SCANNED_BLOCK, 40);
    expect(redis.set).toHaveBeenLastCalledWith(REDIS_KEYS.LAST_SCANNED_BLOCK, 42);
  });
});
