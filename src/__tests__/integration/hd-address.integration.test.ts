import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';

const url = process.env.INTEGRATION_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
let runWatcherJob: (job: { name: string }) => Promise<void>;
vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class {
    constructor(_name: string, process: typeof runWatcherJob) { runWatcherJob = process; }
    on() {}
  },
}));
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('undici', () => ({ fetch: fetchMock }));

describe.skipIf(!url)('HD address lifetime on PostgreSQL', () => {
  it('reserves historical addresses, issues distinct addresses, and audits late payments once', async () => {
    const { getDb, closeDb } = await import('../../db/index.js');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    const { env } = await import('../../config/env.js');
    const { OrderEngine } = await import('../../services/order-engine.js');
    const { addresses, merchants, orders, orderEvents, transactions } = await import('../../db/schema.js');
    const db = getDb();
    const savedMode = env.ADDRESS_MODE;
    env.ADDRESS_MODE = 'hd';
    try {
      await migrate(db, { migrationsFolder: './src/db/migrations' });
      await db.execute(
        sql`TRUNCATE unmatched_transfers, transactions, order_events, orders, merchant_addresses, addresses, merchants RESTART IDENTITY CASCADE`,
      );
      const [merchant] = await db.insert(merchants).values({
        name: 'hd-it', apiKeyHash: 'k'.repeat(64), apiKeyPrefix: 'pw_hd', webhookSecret: 's',
      }).returning();
      const oldAddress = 'HD-INTEGRATION-ADDRESS-0';
      await db.insert(addresses).values({ address: oldAddress, derivationIdx: 0 });
      const [oldOrder] = await db.insert(orders).values({
        merchantId: merchant.id,
        externalId: 'historical',
        address: oldAddress,
        derivationIdx: 0,
        amountExpected: '10.000001',
        callbackUrl: 'https://merchant.example/webhook',
        expiresAt: new Date(Date.now() - 60_000),
        status: 'expired',
      }).returning();
      const migration = readFileSync(
        new URL('../../db/migrations/0005_reserve_issued_hd_addresses.sql', import.meta.url),
        'utf8',
      );
      await db.execute(sql.raw(migration)); // Replay the upgrade on pre-migration data.
      const [reserved] = await db.select().from(addresses).where(eq(addresses.address, oldAddress));
      expect(reserved).toMatchObject({ isAllocated: true, allocatedTo: oldOrder.id });

      await db.insert(addresses).values(Array.from({ length: 40 }, (_, index) => ({
        address: `HD-INTEGRATION-ADDRESS-${index + 1}`,
        derivationIdx: index + 1,
      })));
      const engine = new OrderEngine({} as never, {} as never, {} as never);
      const create = (externalId: string, ttl: number) => engine.createOrder({
        externalId,
        amount: '10.000001',
        callbackUrl: 'https://merchant.example/webhook',
        merchantId: merchant.id,
        webhookSecret: 's',
        ttl,
      });
      const created = await Promise.all(Array.from({ length: 10 }, (_, i) => create(`hd-${i}`, -1)));
      const issued = created.map(({ order }) => order.address);
      expect(new Set(issued).size).toBe(10);
      expect(issued).not.toContain(oldAddress);
      expect(await engine.processExpiredOrders()).toBe(10);

      const next = await create('next', 60);
      expect(issued).not.toContain(next.order.address);
      await engine.onPaymentDetected('hd-late', issued[0], '10.000001', 'payer', 42);
      await engine.onPaymentDetected('hd-late', issued[0], '10.000001', 'payer', 42);

      const [payment] = await db.select().from(transactions).where(eq(transactions.txHash, 'hd-late'));
      expect(payment.orderId).toBe(created[0].order.id);
      const [expiredOrder] = await db.select().from(orders).where(eq(orders.id, payment.orderId!));
      expect(expiredOrder.status).toBe('expired');
      const events = await db.select().from(orderEvents).where(eq(orderEvents.eventType, 'late_payment_detected'));
      expect(events).toHaveLength(1);
    } finally {
      env.ADDRESS_MODE = savedMode;
      await closeDb();
    }
  });
});

describe.skipIf(!url)('HD payment evidence on PostgreSQL', () => {
  it('keeps the order pending without a webhook until a matching USDT Transfer arrives', async () => {
    const { getDb, closeDb } = await import('../../db/index.js');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    const { env } = await import('../../config/env.js');
    const { merchants, orders, transactions } = await import('../../db/schema.js');
    const { OrderEngine } = await import('../../services/order-engine.js');
    const { initChainWatcher } = await import('../../services/chain-watcher.js');
    const db = getDb();
    const webhook = { notify: vi.fn().mockResolvedValue(undefined) };
    const previousModes = { ADDRESS_MODE: env.ADDRESS_MODE, SCAN_MODE: env.SCAN_MODE };
    const address = 'TACBmCJj8xFqUjVqYx9TFhX5acU7zD5Win';
    try {
      env.ADDRESS_MODE = 'hd';
      env.SCAN_MODE = 'address';
      await migrate(db, { migrationsFolder: './src/db/migrations' });
      await db.execute(sql`TRUNCATE merchants CASCADE`);
      const [merchant] = await db.insert(merchants).values({
        name: 'scan-test', apiKeyHash: 'h'.repeat(64), apiKeyPrefix: 'pw_scan', webhookSecret: 's',
      }).returning();
      const [order] = await db.insert(orders).values({
        merchantId: merchant.id, externalId: 'hd-scan', address, derivationIdx: 0,
        amountExpected: '1.000000', callbackUrl: 'https://merchant.example/webhook',
        expiresAt: new Date(Date.now() + 60_000),
      }).returning();
      const engine = new OrderEngine({} as never, webhook as never, {} as never);
      initChainWatcher('redis://localhost:6379', engine);
      const readOrder = () => db.select().from(orders).where(eq(orders.id, order.id));
      const valid = {
        type: 'Transfer', token_info: { address: env.USDT_CONTRACT },
        transaction_id: 'valid', value: '1000000', to: address,
        from: 'TQ1zZmDXbX6qeQfambjkyqbHzDZLQqnWcA', block_timestamp: Date.now(),
      };
      let page: unknown[];
      fetchMock.mockImplementation(async (request: string) => {
        if (request.includes('/transactions/trc20')) {
          return { ok: true, json: async () => ({ success: true, data: page }) };
        }
        if (request.endsWith('/getnowblock')) {
          return { ok: true, json: async () => ({ block_header: { raw_data: { number: 1000 } } }) };
        }
        if (request.endsWith('/gettransactioninfobyid')) {
          return { ok: true, json: async () => ({ blockNumber: 100 }) };
        }
        throw new Error('Unexpected chain request');
      });
      for (const record of [
        { ...valid, transaction_id: 'approval', type: 'Approval' },
        { ...valid, transaction_id: 'missing-type', type: undefined },
        { ...valid, transaction_id: 'unknown-type', type: 'Unknown' },
        { ...valid, transaction_id: 'wrong-contract', token_info: { address } },
        { ...valid, transaction_id: 'missing-contract', token_info: undefined },
      ]) {
        page = [record];
        await runWatcherJob({ name: 'scan' });
        await runWatcherJob({ name: 'check-confirmations' });
        expect((await readOrder())[0], record.transaction_id).toMatchObject({ status: 'pending', txHash: null });
        expect(await db.select().from(transactions).where(eq(transactions.orderId, order.id))).toHaveLength(0);
        expect(webhook.notify).not.toHaveBeenCalled();
      }
      page = [valid];
      await runWatcherJob({ name: 'scan' });
      await runWatcherJob({ name: 'check-confirmations' });
      expect((await readOrder())[0]).toMatchObject({ status: 'confirmed', txHash: 'valid' });
      expect((await db.select().from(transactions).where(eq(transactions.orderId, order.id)))[0].blockNumber).toBe(100);
      expect(webhook.notify).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: order.id }), 'payment.confirmed',
      );
    } finally {
      Object.assign(env, previousModes);
      fetchMock.mockReset();
      await closeDb();
    }
  });
});
