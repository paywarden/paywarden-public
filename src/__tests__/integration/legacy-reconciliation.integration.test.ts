import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';

const url = process.env.INTEGRATION_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;

describe.skipIf(!url)('legacy payment reconciliation migration', () => {
  let module: typeof import('../../db/index.js');
  let schema: typeof import('../../db/schema.js');
  beforeAll(async () => {
    module = await import('../../db/index.js');
    schema = await import('../../db/schema.js');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await migrate(module.getDb(), { migrationsFolder: './src/db/migrations' });
  });
  afterAll(async () => { await module?.closeDb(); });

  it('repairs false success and quarantines historical broadcasts without proof', async () => {
    const db = module.getDb();
    await db.execute(sql`TRUNCATE merchants CASCADE`);
    const [merchant] = await db.insert(schema.merchants).values({ name: 'legacy', apiKeyHash: 'legacy',
      apiKeyPrefix: 'legacy', webhookSecret: 'legacy-secret' }).returning();
    const make = async (externalId: string, status: string, amount: string, address = externalId) =>
      (await db.insert(schema.orders).values({ merchantId: merchant.id, externalId, address,
        derivationIdx: 0, status, amountExpected: '100.000000', amountReceived: amount,
        txHash: externalId, callbackUrl: 'https://merchant.example/webhook', expiresAt: new Date() }).returning())[0];
    const under = await make('under', 'completed', '1.000000');
    const over = await make('over', 'callback_failed', '110.000000');
    const ambiguous = await make('ambiguous', 'confirmed', '100.000000');
    const audited = await make('audited', 'completed', '100.000000');
    await db.insert(schema.orderEvents).values({ orderId: audited.id, eventType: 'payment_confirmed', payload: { status: 'underpaid' } });
    const known = await make('known', 'completed', '100.000000');
    await db.insert(schema.transactions).values({ txHash: 'known', fromAddress: 'sender', toAddress: known.address,
      amount: '100.000000', contractAddr: 'token', blockNumber: 1, orderId: known.id });
    await db.insert(schema.orderEvents).values({ orderId: known.id, eventType: 'sweep_completed',
      payload: { sweep_tx_hash: 'a'.repeat(64), to: 'cold-wallet' } });
    const migration = readFileSync('src/db/migrations/0008_reconcile_legacy_payment_facts.sql', 'utf8');
    const apply = () => db.transaction(async (tx) => {
      for (const statement of migration.split('--> statement-breakpoint')) await tx.execute(sql.raw(statement));
    });
    await apply(); await apply(); // Data migration is also safe to replay.
    const readOrder = async (id: string) => (await db.select().from(schema.orders).where(eq(schema.orders.id, id)))[0];
    expect(await readOrder(under.id)).toMatchObject({ status: 'underpaid', paymentStatus: 'underpaid' });
    expect(await readOrder(over.id)).toMatchObject({ status: 'overpaid', paymentStatus: 'overpaid' });
    expect(await readOrder(audited.id)).toMatchObject({ status: 'underpaid', paymentStatus: 'underpaid' });
    const events = await db.select().from(schema.orderEvents).where(eq(schema.orderEvents.eventType, 'payment_status_reconciled'));
    expect(events).toHaveLength(3);
    expect(events.find((e) => e.orderId === under.id)?.payload).toMatchObject({ previous_status: 'completed', status: 'underpaid' });
    const deliveries = await db.select().from(schema.webhookDeliveries);
    expect(deliveries).toHaveLength(5);
    expect(deliveries.find((d) => d.orderId === under.id)?.status).toBe('delivered');
    expect(deliveries.find((d) => d.orderId === over.id)?.status).toBe('failed');
    expect(deliveries.find((d) => d.orderId === ambiguous.id)?.status).toBe('legacy_review');
    const sweeps = await db.select().from(schema.sweepJobs);
    expect(sweeps).toHaveLength(5);
    expect(sweeps.find((s) => s.orderId === known.id)).toMatchObject({ status: 'broadcast', txHash: 'a'.repeat(64), signedTransaction: null });
    expect(sweeps.filter((s) => s.status === 'legacy_review')).toHaveLength(4);
  });
});
