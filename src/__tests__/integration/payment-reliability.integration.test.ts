import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';

const url = process.env.INTEGRATION_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
vi.stubEnv('ADDRESS_MODE', 'hd');
vi.stubEnv('HOT_WALLET_KEY', '1'.repeat(64));
vi.stubEnv('COLD_WALLET_ADDRESS', 'TQ1zZmDXbX6qeQfambjkyqbHzDZLQqnWcA');

describe.skipIf(!url)('payment facts and durable notification intent', () => {
  let db: ReturnType<(typeof import('../../db/index.js'))['getDb']>;
  let schema: typeof import('../../db/schema.js');
  let closeDb: () => Promise<void>;
  let engine: InstanceType<(typeof import('../../services/order-engine.js'))['OrderEngine']>;
  const notify = vi.fn();
  let orderId: string;

  beforeAll(async () => {
    const dbModule = await import('../../db/index.js');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    const { OrderEngine } = await import('../../services/order-engine.js');
    schema = await import('../../db/schema.js');
    db = dbModule.getDb();
    closeDb = dbModule.closeDb;
    await migrate(db, { migrationsFolder: './src/db/migrations' });
    const { ensureSweepIntent } = await import('../../services/sweep-intents.js');
    engine = new OrderEngine({} as never, { notify } as never, { isSweepEnabled: () => true,
      queueSweep: async (id: string, options?: { retry?: boolean }) => {
        if (options?.retry) await ensureSweepIntent(id, true);
      },
    } as never);
  });
  afterAll(async () => { await closeDb?.(); });
  beforeEach(async () => {
    notify.mockReset().mockResolvedValue(undefined);
    await db.execute(sql`TRUNCATE merchants CASCADE`);
    const [merchant] = await db.insert(schema.merchants).values({
      name: 'p0', apiKeyHash: 'p0', apiKeyPrefix: 'p0', webhookSecret: 'p0-test-secret',
    }).returning();
    const [order] = await db.insert(schema.orders).values({
      merchantId: merchant.id, externalId: 'p0', address: 'TACBmCJj8xFqUjVqYx9TFhX5acU7zD5Win',
      derivationIdx: 0, amountExpected: '100.000000', amountReceived: '1.000000',
      status: 'detected', txHash: 'payment-hash', callbackUrl: 'https://merchant.example/webhook',
      expiresAt: new Date(Date.now() + 60_000),
    }).returning();
    orderId = order.id;
    await db.insert(schema.transactions).values({ txHash: 'payment-hash', orderId,
      fromAddress: 'sender', toAddress: order.address, amount: '1.000000', blockNumber: 0, contractAddr: 'token' });
  });
  const readOrder = async () => (await db.select().from(schema.orders).where(eq(schema.orders.id, orderId)))[0];

  it('persists receipt height atomically with confirmation and does not repeat side effects', async () => {
    await engine.onPaymentConfirmed('payment-hash', 19, 81);
    expect((await db.select().from(schema.transactions))[0]).toMatchObject({ blockNumber: 81, confirmations: 19 });
    await engine.onPaymentConfirmed('payment-hash', 20, 82);
    expect((await db.select().from(schema.transactions))[0].blockNumber).toBe(81);
    expect(await db.select().from(schema.webhookDeliveries)).toHaveLength(1);
    expect(await db.select().from(schema.sweepJobs)).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('preserves a previously recorded nonzero height', async () => {
    await db.update(schema.transactions).set({ blockNumber: 80 });
    await engine.onPaymentConfirmed('payment-hash', 19, 81);
    expect((await db.select().from(schema.transactions))[0].blockNumber).toBe(80);
  });

  it('preserves underpayment after successful and repeated webhook bookkeeping', async () => {
    await engine.onPaymentConfirmed('payment-hash', 19, 81);
    const receipt = {
      callbackUrl: 'https://merchant.example/webhook', statusCode: 200, attempt: 1,
      durationMs: 1, deliveredAt: new Date().toISOString(), idempotencyKey: 'p0-delivery',
    };
    await engine.markWebhookCompleted(orderId, receipt);
    await engine.markWebhookCompleted(orderId, receipt);
    expect((await readOrder()).status).toBe('underpaid');
    expect((await readOrder()).paymentStatus).toBe('underpaid');
    const events = await db.select().from(schema.orderEvents)
      .where(eq(schema.orderEvents.eventType, 'webhook_sent'));
    expect(events).toHaveLength(1);
    const { default: Fastify } = await import('fastify');
    const { registerCheckoutRoutes } = await import('../../api/routes/checkout.js');
    const app = Fastify();
    registerCheckoutRoutes(app);
    try {
      const response = await app.inject(`/api/v1/checkout/${orderId}/status`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'underpaid', payment_status: 'underpaid', confirmations: 19 });
    } finally { await app.close(); }
  });

  it.each([
    ['100.000000', 'confirmed', 'completed'], ['110.000000', 'overpaid', 'overpaid'],
  ])('preserves the %s payment fact after successful callback', async (amountReceived, paymentStatus, status) => {
    await db.update(schema.orders).set({ amountReceived }).where(eq(schema.orders.id, orderId));
    await engine.onPaymentConfirmed('payment-hash', 19, 81);
    await engine.markWebhookCompleted(orderId, {
      callbackUrl: 'https://merchant.example/webhook', statusCode: 200, attempt: 1,
      durationMs: 1, deliveredAt: new Date().toISOString(), idempotencyKey: 'p0-matrix',
    });
    expect(await readOrder()).toMatchObject({ status, paymentStatus });
    expect((await db.select().from(schema.webhookDeliveries))[0].payload.status).toBe(paymentStatus);
  });

  it('commits a recoverable webhook intent even when Redis enqueue fails', async () => {
    notify.mockRejectedValue(new Error('Redis unavailable'));
    await expect(engine.onPaymentConfirmed('payment-hash', 19, 81)).resolves.toBeUndefined();
    expect((await readOrder()).status).toBe('underpaid');
    const rows = await db.select().from(schema.webhookDeliveries);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ orderId, status: 'pending', eventType: 'payment.underpaid' });
    expect(await db.select().from(schema.sweepJobs)).toMatchObject([{ orderId, status: 'pending', amount: '1.000000' }]);
    await engine.onPaymentConfirmed('payment-hash', 20, 81);
    expect(await db.select().from(schema.webhookDeliveries)).toHaveLength(1);
  });

  it('rolls back confirmation, audit and sweep intent when durable delivery persistence fails', async () => {
    await db.execute(sql`ALTER TABLE webhook_deliveries ADD CONSTRAINT test_reject_intent CHECK (false) NOT VALID`);
    try {
      await expect(engine.onPaymentConfirmed('payment-hash', 19, 81)).rejects.toThrow();
      expect(await readOrder()).toMatchObject({ status: 'detected', paymentStatus: null });
      expect(await db.select().from(schema.webhookDeliveries)).toHaveLength(0);
      expect(await db.select().from(schema.sweepJobs)).toHaveLength(0);
      expect(await db.select().from(schema.orderEvents)).toHaveLength(0);
      expect((await db.select().from(schema.transactions))[0]).toMatchObject({ confirmedAt: null, blockNumber: 0 });
      expect(notify).not.toHaveBeenCalled();
    } finally {
      await db.execute(sql`ALTER TABLE webhook_deliveries DROP CONSTRAINT test_reject_intent`);
    }
  });

  it.each(['1.000000', '110.000000'])('exposes real failed-step recovery in the admin API for amount %s', async (amountReceived) => {
    await db.update(schema.orders).set({ amountReceived }).where(eq(schema.orders.id, orderId));
    await engine.onPaymentConfirmed('payment-hash', 19, 81);
    await engine.markWebhookFailed(orderId);
    await db.update(schema.sweepJobs).set({ status: 'failed' }).where(eq(schema.sweepJobs.orderId, orderId));
    const { default: Fastify } = await import('fastify');
    const { default: cookie } = await import('@fastify/cookie');
    const { registerAdminRoutes } = await import('../../api/routes/admin.js');
    const { signAdminToken } = await import('../../utils/jwt.js');
    const app = Fastify(); await app.register(cookie);
    registerAdminRoutes(app, { gasManager: {} as never, fundSweeper: {} as never, orderEngine: engine });
    const request = () => app.inject({ url: `/api/v1/admin/orders/${orderId}`, headers: { cookie: `admin_token=${signAdminToken()}` } });
    try {
      const response = await request(); expect(response.statusCode).toBe(200);
      expect(response.json().recovery).toEqual({ webhook: { status: 'failed', can_retry: true }, sweep: { status: 'failed', can_retry: true } });
      const post = (action: string) => app.inject({ method: 'POST', url: `/api/v1/admin/orders/${orderId}/${action}`,
        headers: { cookie: `admin_token=${signAdminToken()}` } });
      expect((await post('retry-webhook')).statusCode).toBe(200);
      expect((await post('retry-sweep')).statusCode).toBe(200);
      expect((await db.select().from(schema.webhookDeliveries))[0].status).toBe('pending');
      expect((await db.select().from(schema.sweepJobs))[0].status).toBe('pending');
      await db.update(schema.webhookDeliveries).set({ status: 'delivered' });
      await db.update(schema.sweepJobs).set({ status: 'confirmed' });
      expect((await request()).json().recovery).toMatchObject({ webhook: { can_retry: false }, sweep: { can_retry: false } });
    } finally { await app.close(); }
  });
});
