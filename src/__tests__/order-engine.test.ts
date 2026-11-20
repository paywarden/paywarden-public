import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EVENT_TYPE } from '../config/constants.js';

// update(...).set(...).where(...) is awaited directly in some paths and
// chained with .returning(...) in others — the object shape supports both.
const updateReturning = vi.fn().mockResolvedValue([{ id: 'order-updated' }]);
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn(() => ({ where: updateWhere }));
const updateMock = vi.fn(() => ({ set: updateSet }));
const insertValues = vi.fn().mockResolvedValue(undefined);
const insertMock = vi.fn(() => ({ values: insertValues }));
// Pre-read for markWebhookFailed: select(...).from(...).where(...) → [order]
const selectWhere = vi.fn();
const selectFrom = vi.fn(() => ({ where: (...args: unknown[]) => ({ for: () => selectWhere(...args) }) }));
const selectMock = vi.fn(() => ({ from: selectFrom }));
const fakeDb = {
  update: updateMock, insert: insertMock, select: selectMock,
  transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(fakeDb),
};

vi.mock('../db/index.js', () => ({
  getDb: () => fakeDb,
}));

describe('OrderEngine webhook audit payload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectWhere.mockReset();
  });

  it('records webhook delivery context on webhook_sent events', async () => {
    selectWhere.mockResolvedValueOnce([{ id: 'ord_123', status: 'confirmed',
      amountExpected: '10', amountReceived: '10' }]).mockResolvedValueOnce([]);
    const { OrderEngine } = await import('../services/order-engine.js');

    const queueSweep = vi.fn().mockResolvedValue(undefined);
    const engine = new OrderEngine(
      {} as never,
      {} as never,
      { queueSweep } as never,
    );

    const context = {
      callbackUrl: 'https://merchant.example/webhook',
      statusCode: 202,
      attempt: 2,
      durationMs: 187,
      deliveredAt: '2026-04-08T09:03:56.000Z',
      idempotencyKey: 'evt_ord_123_payment.confirmed_1775648636',
    };

    await engine.markWebhookCompleted('ord_123', context);

    expect(insertValues).toHaveBeenCalledWith({
      orderId: 'ord_123',
      eventType: EVENT_TYPE.WEBHOOK_SENT,
      payload: context,
    });
    expect(queueSweep).toHaveBeenCalledWith('ord_123');
  });

  it('records full failure context on webhook_failed events (symmetric to success)', async () => {
    const { OrderEngine } = await import('../services/order-engine.js');

    selectWhere.mockResolvedValueOnce([{ id: 'ord_456', status: 'underpaid',
      amountExpected: '10', amountReceived: '1' }]).mockResolvedValueOnce([]);

    const queueSweep = vi.fn().mockResolvedValue(undefined);
    const engine = new OrderEngine(
      {} as never,
      {} as never,
      { queueSweep } as never,
    );

    const failure = {
      callbackUrl: 'https://merchant.example/webhook',
      statusCode: 500,
      attempt: 5,
      durationMs: 9871,
      failedAt: '2026-04-08T09:10:11.000Z',
      idempotencyKey: 'evt_ord_456_payment.confirmed_1775649011',
      reason: 'HTTP 500',
    };

    await engine.markWebhookFailed('ord_456', failure);

    expect(insertValues).toHaveBeenCalledWith({
      orderId: 'ord_456',
      eventType: EVENT_TYPE.WEBHOOK_FAILED,
      payload: {
        // Legacy 3 fields preserved for back-compat
        reason: 'HTTP 500',
        attempt: 5,
        previous_status: 'underpaid',
        // 6 new fields mirroring webhook_sent
        callbackUrl: 'https://merchant.example/webhook',
        statusCode: 500,
        durationMs: 9871,
        failedAt: '2026-04-08T09:10:11.000Z',
        idempotencyKey: 'evt_ord_456_payment.confirmed_1775649011',
      },
    });
  });

  it('does not roll back an order that already left webhook-in-flight state', async () => {
    const { OrderEngine } = await import('../services/order-engine.js');

    // Pre-read sees the order, but the guarded UPDATE matches 0 rows —
    // e.g. a second retry chain completed the order in the meantime.
    selectWhere.mockResolvedValueOnce([{ id: 'ord_done', status: 'completed' }]);
    updateReturning.mockResolvedValueOnce([]);

    const queueSweep = vi.fn().mockResolvedValue(undefined);
    const engine = new OrderEngine(
      {} as never,
      {} as never,
      { queueSweep } as never,
    );

    await engine.markWebhookFailed('ord_done');

    // No status flip recorded: no webhook_failed event, no sweep side effect
    expect(insertValues).not.toHaveBeenCalled();
    expect(queueSweep).not.toHaveBeenCalled();
  });

  it('falls back to legacy defaults when failure context is omitted', async () => {
    const { OrderEngine } = await import('../services/order-engine.js');
    selectWhere.mockResolvedValueOnce([{ id: 'ord_789', status: 'underpaid',
      amountExpected: '10', amountReceived: '1' }]).mockResolvedValueOnce([]);

    const engine = new OrderEngine(
      {} as never,
      {} as never,
      { queueSweep: vi.fn() } as never,
    );

    await engine.markWebhookFailed('ord_789');

    expect(insertValues).toHaveBeenCalledWith({
      orderId: 'ord_789',
      eventType: EVENT_TYPE.WEBHOOK_FAILED,
      payload: {
        reason: 'max_attempts_reached',
        attempt: null,
        previous_status: 'underpaid',
        callbackUrl: null,
        statusCode: null,
        durationMs: null,
        failedAt: null,
        idempotencyKey: null,
      },
    });
  });
});
