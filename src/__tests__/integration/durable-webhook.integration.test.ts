import { createServer } from 'node:http';
import { once } from 'node:events';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const url = process.env.INTEGRATION_DATABASE_URL;
const redisUrl = process.env.INTEGRATION_REDIS_URL;
if (url) process.env.DATABASE_URL = url;
vi.stubEnv('ALLOW_PRIVATE_CALLBACKS', 'true');

describe.skipIf(!url || !redisUrl)('durable webhooks with real PostgreSQL, Redis and HTTP', () => {
  let db: ReturnType<(typeof import('../../db/index.js'))['getDb']>;
  let schema: typeof import('../../db/schema.js');
  let closeDb: () => Promise<void>;
  let worker: typeof import('../../services/webhook-notifier.js');
  let outbox: typeof import('../../services/webhook-outbox.js');
  let notifier: InstanceType<(typeof import('../../services/webhook-notifier.js'))['WebhookNotifier']>;
  let engine: InstanceType<(typeof import('../../services/order-engine.js'))['OrderEngine']>;
  let redis: Redis;
  let callback: string;
  let orderId: string;
  let httpStatus = 200;
  const requests: Array<{ key: string; body: string; signature: string; url: string }> = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    requests.push({ key: String(req.headers['x-idempotency-key']), body, signature: String(req.headers['x-signature']), url: req.url! });
    res.writeHead(httpStatus).end();
  });

  beforeAll(async () => {
    const module = await import('../../db/index.js');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    const { OrderEngine } = await import('../../services/order-engine.js');
    schema = await import('../../db/schema.js');
    worker = await import('../../services/webhook-notifier.js');
    outbox = await import('../../services/webhook-outbox.js');
    db = module.getDb(); closeDb = module.closeDb;
    await migrate(db, { migrationsFolder: './src/db/migrations' });
    redis = new Redis(redisUrl!);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    callback = `http://127.0.0.1:${(server.address() as { port: number }).port}/webhook`;
    notifier = new worker.WebhookNotifier();
    engine = new OrderEngine({} as never, notifier, { queueSweep: async () => undefined } as never);
  });
  beforeEach(async () => {
    await worker.closeWebhookWorker();
    await redis.flushdb(); // INTEGRATION_REDIS_URL must be disposable.
    await db.execute(sql`TRUNCATE merchants CASCADE`);
    requests.length = 0; httpStatus = 200;
    const [merchant] = await db.insert(schema.merchants).values({
      name: 'durable', apiKeyHash: 'durable', apiKeyPrefix: 'durable', webhookSecret: 'durable-secret',
    }).returning();
    const [order] = await db.insert(schema.orders).values({
      merchantId: merchant.id, externalId: 'durable', address: 'TACBmCJj8xFqUjVqYx9TFhX5acU7zD5Win',
      derivationIdx: null, amountExpected: '100.000000', amountReceived: '1.000000', status: 'detected',
      txHash: 'durable-payment', callbackUrl: callback, webhookSecret: 'durable-secret', expiresAt: new Date(),
    }).returning();
    orderId = order.id;
  });
  afterAll(async () => {
    await worker?.closeWebhookWorker();
    await redis?.quit();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDb?.();
  });
  const read = async () => (await db.select().from(schema.webhookDeliveries))[0];
  const dispatch = () => outbox.dispatchWebhookOutbox((id) => notifier.enqueueDelivery(id));
  const start = (
    onSuccess = (id: string, context: Parameters<typeof engine.markWebhookCompleted>[1]) => engine.markWebhookCompleted(id, context),
    onFailure = (id: string, context: Parameters<typeof engine.markWebhookFailed>[1]) => engine.markWebhookFailed(id, context),
  ) => worker.initWebhookWorker(redisUrl!, onSuccess, onFailure);
  const awaitDelivery = async () => vi.waitFor(async () => {
    await dispatch(); expect((await read()).status).toBe('delivered');
  }, { timeout: 5000, interval: 50 });

  it('recovers an enqueue outage and preserves underpaid facts after real HTTP delivery', async () => {
    await engine.onPaymentConfirmed('durable-payment', 19, 81); // No worker/queue yet.
    expect((await read()).status).toBe('pending');
    start(); await awaitDelivery();
    expect(requests).toHaveLength(1);
    const { hmacSha256 } = await import('../../utils/crypto.js');
    expect(requests[0].signature).toBe(`sha256=${hmacSha256(requests[0].body, 'durable-secret')}`);
    const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
    expect(order).toMatchObject({ status: 'underpaid', paymentStatus: 'underpaid' });
  });

  it('retries only bookkeeping after acknowledgement and worker restart', async () => {
    start(vi.fn().mockRejectedValue(new Error('bookkeeping unavailable')));
    await engine.onPaymentConfirmed('durable-payment', 19, 81);
    await vi.waitFor(async () => expect((await read()).status).toBe('acknowledged'));
    await worker.closeWebhookWorker();
    expect(requests).toHaveLength(1);
    start(); await awaitDelivery();
    expect(requests).toHaveLength(1);
    const events = await db.select().from(schema.orderEvents).where(eq(schema.orderEvents.eventType, 'webhook_sent'));
    expect(events).toHaveLength(1);
  });

  it('retains the exact payload and idempotency key across HTTP retries', async () => {
    httpStatus = 503; start();
    await engine.onPaymentConfirmed('durable-payment', 19, 81);
    await vi.waitFor(async () => expect((await read()).attempt).toBe(1));
    httpStatus = 200;
    await db.update(schema.webhookDeliveries).set({ nextAttemptAt: new Date(0) });
    await awaitDelivery();
    expect(requests).toHaveLength(2);
    expect(requests[1].key).toBe(requests[0].key);
    expect(requests[1].body).toBe(requests[0].body);
  });

  it('recreates delivery jobs after disposable Redis data is lost', async () => {
    await engine.onPaymentConfirmed('durable-payment', 19, 81);
    await redis.flushdb();
    start(); await awaitDelivery();
    expect(requests).toHaveLength(1);
  });

  it('retains the Redis acknowledgement when PostgreSQL acknowledgement persistence fails', async () => {
    await db.execute(sql`ALTER TABLE webhook_deliveries ADD CONSTRAINT test_reject_ack CHECK (status <> 'acknowledged') NOT VALID`);
    try {
      start(); await engine.onPaymentConfirmed('durable-payment', 19, 81);
      await vi.waitFor(async () => expect(await redis.zcard('bull:webhooks:failed')).toBe(1));
      expect((await read()).status).toBe('pending');
      expect(requests).toHaveLength(1);
      await worker.closeWebhookWorker();
    } finally {
      await db.execute(sql`ALTER TABLE webhook_deliveries DROP CONSTRAINT test_reject_ack`);
    }
    start(); await awaitDelivery();
    expect(requests).toHaveLength(1);
  });

  it('recovers terminal failure bookkeeping and allows an explicit retry with the same event identity', async () => {
    await engine.onPaymentConfirmed('durable-payment', 19, 81);
    await db.update(schema.webhookDeliveries).set({ attempt: 9 });
    httpStatus = 503;
    start(undefined, vi.fn().mockRejectedValue(new Error('failure bookkeeping unavailable')));
    await dispatch();
    await vi.waitFor(async () => expect((await read()).status).toBe('failure_pending'));
    await worker.closeWebhookWorker();
    expect(requests).toHaveLength(1);
    start();
    await vi.waitFor(async () => { await dispatch(); expect((await read()).status).toBe('failed'); });
    expect(requests).toHaveLength(1);
    const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
    expect(order.status).toBe('underpaid');
    httpStatus = 200;
    await engine.retryWebhook(orderId);
    await awaitDelivery();
    expect(requests).toHaveLength(2);
    expect(requests[1].key).toBe(requests[0].key);
  });

  it('does not steal an active lease and recovers after its expiry', async () => {
    await engine.onPaymentConfirmed('durable-payment', 19, 81);
    await db.update(schema.webhookDeliveries).set({ leaseUntil: new Date(Date.now() + 60_000) });
    start(); await dispatch();
    expect(requests).toHaveLength(0);
    await db.update(schema.webhookDeliveries).set({ leaseUntil: new Date(0) });
    await awaitDelivery();
    expect(requests).toHaveLength(1);
  });

  it('delivers to a replacement callback instead of reusing the old target acknowledgement', async () => {
    await db.execute(sql`ALTER TABLE webhook_deliveries ADD CONSTRAINT test_reject_retarget_ack CHECK (status <> 'acknowledged') NOT VALID`);
    try {
      start(); await engine.onPaymentConfirmed('durable-payment', 19, 81);
      await vi.waitFor(async () => expect(await redis.zcard('bull:webhooks:failed')).toBe(1));
      await worker.closeWebhookWorker();
    } finally { await db.execute(sql`ALTER TABLE webhook_deliveries DROP CONSTRAINT test_reject_retarget_ack`); }
    const replacement = callback + '/replacement';
    const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
    await outbox.retryWebhookIntent(order, replacement);
    start(); await awaitDelivery();
    expect(requests).toHaveLength(2);
    expect(requests[1].url).toBe('/webhook/replacement');
    expect((await read()).receipt?.callbackUrl).toBe(replacement);
  });

  it('rejects a stale acknowledgement even when a queued job bypasses enqueue validation', async () => {
    await engine.onPaymentConfirmed('durable-payment', 19, 81);
    const delivery = await read();
    const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
    await outbox.retryWebhookIntent(order, callback + '/new');
    const ack = { callbackUrl: callback, deliveryGeneration: 0, idempotencyKey: `evt_${delivery.id}`,
      statusCode: 200, attempt: 1, durationMs: 1, deliveredAt: new Date().toISOString() };
    await engine.markWebhookCompleted(orderId, ack);
    await engine.markWebhookFailed(orderId, { ...ack, statusCode: 503, reason: 'old target failed', failedAt: new Date().toISOString() });
    expect((await read()).status).toBe('pending');
    const direct = new Queue('webhooks', { connection: { url: redisUrl! } });
    try {
      await direct.add('webhooks', { deliveryId: delivery.id, ack });
      start(); await awaitDelivery();
      expect(requests).toHaveLength(1); expect(requests[0].url).toBe('/webhook/new');
      expect((await read()).receipt?.deliveryGeneration).toBe(1);
    } finally { await direct.close(); }
  });

  it('does not reuse an old acknowledgement when a target changes A to B to A', async () => {
    await engine.onPaymentConfirmed('durable-payment', 19, 81);
    const delivery = await read();
    const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
    await outbox.retryWebhookIntent(order, callback + '/other');
    await outbox.retryWebhookIntent(order, callback);
    const direct = new Queue('webhooks', { connection: { url: redisUrl! } });
    try {
      await direct.add('webhooks', { deliveryId: delivery.id, ack: { callbackUrl: callback, deliveryGeneration: 0,
        idempotencyKey: `evt_${delivery.id}`, statusCode: 200, attempt: 1, durationMs: 1, deliveredAt: new Date().toISOString() } });
      start(); await awaitDelivery();
      expect(requests).toHaveLength(1); expect(requests[0].url).toBe('/webhook');
      expect((await read()).receipt?.deliveryGeneration).toBe(2);
    } finally { await direct.close(); }
  });

  it('does not deliver old Redis jobs for quarantined historical intents', async () => {
    await engine.onPaymentConfirmed('durable-payment', 19, 81);
    await db.update(schema.webhookDeliveries).set({ status: 'legacy_review' });
    const oldQueue = new Queue('webhooks', { connection: { url: redisUrl! } });
    try {
      const job = await oldQueue.add('webhooks', { orderId, callbackUrl: callback, webhookSecret: 'durable-secret',
        payload: { event: 'payment.underpaid' }, attempt: 0 });
      start();
      await vi.waitFor(async () => expect(await job.getState()).toBe('completed'));
      expect(requests).toHaveLength(0);
      expect((await read()).status).toBe('legacy_review');
    } finally { await oldQueue.close(); }
  });

  it('blocks an unsafe stored callback before HTTP and records terminal failure once', async () => {
    await engine.onPaymentConfirmed('durable-payment', 19, 81);
    await db.update(schema.webhookDeliveries).set({ callbackUrl: 'file:///etc/passwd' });
    const { env } = await import('../../config/env.js');
    const previous = env.ALLOW_PRIVATE_CALLBACKS;
    env.ALLOW_PRIVATE_CALLBACKS = false; // Other cases explicitly allow the local HTTP receiver.
    try {
      start();
      await vi.waitFor(async () => { await dispatch(); expect((await read()).status).toBe('failed'); });
      await dispatch();
      expect(requests).toHaveLength(0);
      expect((await read()).failure?.reason).toContain('unsafe_callback_url');
      const events = await db.select().from(schema.orderEvents).where(eq(schema.orderEvents.eventType, 'webhook_failed'));
      expect(events).toHaveLength(1);
    } finally { await worker.closeWebhookWorker(); env.ALLOW_PRIVATE_CALLBACKS = previous; }
  });
});
