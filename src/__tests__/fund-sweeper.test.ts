import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FundSweeper } from '../services/fund-sweeper.js';
vi.mock('../services/sweep-intents.js', () => ({
  ensureSweepIntent: vi.fn().mockResolvedValue(true), recoverSweepIntents: vi.fn(),
}));

/**
 * Regression coverage for the stale-job retry trap.
 *
 * Bug shape: queueSweep() used a stable jobId (`sweep-${orderId}`) plus
 * `removeOnFail: 200`, so a permanently-failed sweep job sat in the BullMQ
 * failed set indefinitely. BullMQ's jobId dedup then silently swallowed
 * every subsequent admin retrySweep() call until the failed job was
 * evicted (up to 200 entries later). The user saw "sweep queued" in the
 * event log but no new job ever ran, and the funds stayed locked.
 *
 * Fix: queueSweep() now asks BullMQ for the live job state and removes
 * any non-in-flight stale slot before re-enqueueing.
 */

// Stub the db layer — queueSweep() does two reads (orders, addresses) and
// one insert (orderEvents). We just need them to resolve to the right
// shape; nothing in this test exercises real SQL.
const orderRow = { address: 'TFakeAddress' };
const addrRowNoSweep: { sweepTxHash: string | null } = { sweepTxHash: null };

vi.mock('../db/index.js', () => {
  const selectChain = (row: unknown) => ({
    from: () => ({ where: () => Promise.resolve(row ? [row] : []) }),
  });
  return {
    getDb: () => ({
      // First select() call returns orderRow, second returns addrRow.
      // We swap behaviour per-call via a counter on the mock.
      select: vi
        .fn()
        .mockImplementationOnce(() => selectChain(orderRow))
        .mockImplementationOnce(() => selectChain(addrRowNoSweep))
        .mockImplementation(() => selectChain(null)),
      insert: () => ({ values: () => Promise.resolve() }),
    }),
  };
});

describe('FundSweeper.queueSweep stale-job handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('removes a stale failed job before re-enqueueing on retry', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const getState = vi.fn().mockResolvedValue('failed');
    const staleJob = { remove, getState };

    const add = vi.fn().mockResolvedValue({ id: 'sweep-order-1' });
    const getJob = vi.fn().mockResolvedValue(staleJob);

    // Build a sweeper with sweep enabled (HOT_WALLET_KEY + COLD_WALLET_ADDRESS
    // are required for isSweepEnabled to return true). We bypass init() and
    // inject the fake queue directly so we don't need a real Redis.
    const sweeper = new FundSweeper({} as never, {} as never, 'redis://unused');
    Object.defineProperty(sweeper, 'isSweepEnabled', { value: () => true });
    (sweeper as unknown as { queue: unknown }).queue = { getJob, add };

    await sweeper.queueSweep('order-1');

    expect(getJob).toHaveBeenCalledWith('sweep-order-1');
    expect(getState).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]?.[2]).toMatchObject({ jobId: 'sweep-order-1' });
  });

  it('skips re-enqueue when an in-flight job already exists', async () => {
    const remove = vi.fn();
    const getState = vi.fn().mockResolvedValue('delayed');
    const liveJob = { remove, getState };

    const add = vi.fn();
    const getJob = vi.fn().mockResolvedValue(liveJob);

    const sweeper = new FundSweeper({} as never, {} as never, 'redis://unused');
    Object.defineProperty(sweeper, 'isSweepEnabled', { value: () => true });
    (sweeper as unknown as { queue: unknown }).queue = { getJob, add };

    await sweeper.queueSweep('order-1');

    expect(remove).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });
});
