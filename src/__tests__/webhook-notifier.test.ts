import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  add: vi.fn(), getJob: vi.fn(), process: vi.fn(), close: vi.fn(),
  deliveries: [] as Array<{ id: string; status: string; callbackUrl: string; generation: number }>,
  processor: null as null | ((job: { id?: string; data: object }) => Promise<void>),
}));
vi.mock('bullmq', () => ({
  Queue: class { add = mocks.add; getJob = mocks.getJob; close = mocks.close; },
  Worker: class {
    constructor(_name: string, process: typeof mocks.processor) { mocks.processor = process; }
    on = vi.fn(); close = mocks.close;
  },
}));
vi.mock('../db/index.js', () => ({ getDb: () => ({ select: () => ({
  from: () => ({ where: async () => mocks.deliveries }),
}) }) }));
vi.mock('../services/durable-webhook.js', () => ({ processDurableWebhook: mocks.process }));
const { WebhookNotifier, initWebhookWorker, closeWebhookWorker } = await import('../services/webhook-notifier.js');
const success = vi.fn(); const failed = vi.fn();
const notifier = new WebhookNotifier();

describe('durable webhook queue routing', () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.deliveries = [{ id: 'delivery', status: 'pending', callbackUrl: 'https://merchant.example', generation: 0 }];
    mocks.getJob.mockResolvedValue(undefined); mocks.process.mockResolvedValue(undefined);
    initWebhookWorker('redis://unused', success, failed);
  });

  it('quarantines legacy Redis payloads instead of sending historical callbacks', async () => {
    await mocks.processor!({ id: 'legacy-job', data: { orderId: 'order', callbackUrl: 'https://merchant.example' } });
    expect(mocks.process).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled();
  });

  it('routes a durable identity to the lease-protected processor', async () => {
    const job = { data: { deliveryId: 'delivery' } };
    await mocks.processor!(job);
    expect(mocks.process).toHaveBeenCalledWith(job, success, failed);
  });

  it('uses a stable queue id and retains failed acknowledgements', async () => {
    await notifier.enqueueDelivery('delivery');
    expect(mocks.add).toHaveBeenCalledWith('webhooks', { deliveryId: 'delivery' }, {
      jobId: 'delivery-delivery', removeOnComplete: true, removeOnFail: false,
    });
  });

  it('does not remove or duplicate an active job', async () => {
    const remove = vi.fn(); mocks.getJob.mockResolvedValue({ getState: async () => 'active', remove });
    await notifier.enqueueDelivery('delivery');
    expect(remove).not.toHaveBeenCalled(); expect(mocks.add).not.toHaveBeenCalled();
  });

  it('carries an observed acknowledgement when replacing a failed queue slot', async () => {
    const ack = { idempotencyKey: 'evt_delivery', callbackUrl: 'https://merchant.example', deliveryGeneration: 0 }; const remove = vi.fn();
    mocks.getJob.mockResolvedValue({ getState: async () => 'failed', remove, data: { ack } });
    await notifier.enqueueDelivery('delivery');
    expect(remove).toHaveBeenCalledOnce();
    expect(mocks.add.mock.calls[0][1]).toEqual({ deliveryId: 'delivery', ack });
  });

  it('does not enqueue delivered or quarantined intents', async () => {
    for (const status of ['delivered', 'failed', 'legacy_review']) {
      mocks.deliveries = [{ ...mocks.deliveries[0], status }];
      await notifier.notify({ id: 'order' } as never, 'payment.confirmed');
    }
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it('requires a committed durable intent and initialized queue', async () => {
    mocks.deliveries = [];
    await expect(notifier.notify({ id: 'order' } as never, 'payment.confirmed')).rejects.toThrow('Missing durable');
    await closeWebhookWorker();
    await expect(notifier.enqueueDelivery('delivery')).rejects.toThrow('not initialized');
  });

  it.each([
    { callbackUrl: 'https://old.example', deliveryGeneration: 0, idempotencyKey: 'evt_delivery' },
    { callbackUrl: 'https://merchant.example', deliveryGeneration: 1, idempotencyKey: 'evt_delivery' },
    { callbackUrl: 'https://merchant.example', deliveryGeneration: 0, idempotencyKey: 'evt_another' },
  ])('discards an acknowledgement from another target, generation or event', async (ack) => {
    mocks.getJob.mockResolvedValue({ getState: async () => 'failed', remove: vi.fn(), data: { ack } });
    await notifier.enqueueDelivery('delivery');
    expect(mocks.add.mock.calls[0][1]).toEqual({ deliveryId: 'delivery' });
  });
});
