/**
 * Static-address mode against a REAL Postgres: migration 0004, the partial
 * unique index, advisory-lock tail allocation under concurrency, and the
 * atomic claim. Skipped unless INTEGRATION_DATABASE_URL points at a
 * disposable PG16 database (it is migrated and truncated by this file):
 *
 *   INTEGRATION_DATABASE_URL=postgresql://paywarden:paywarden@localhost:5432/paywarden_test \
 *     ./node_modules/.bin/vitest run src/__tests__/integration
 *
 * No Redis is needed (the engine runs with redis unset).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';

const url = process.env.INTEGRATION_DATABASE_URL;
if (url) {
  process.env.DATABASE_URL = url;
}
vi.stubEnv('ADDRESS_MODE', 'static');

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

describe.skipIf(!url)('static-address mode on Postgres', () => {
  // Imported lazily so a missing INTEGRATION_DATABASE_URL never opens a pool.
  let db: Awaited<typeof import('../../db/index.js')>['getDb'] extends () => infer D ? D : never;
  let closeDb: () => Promise<void>;
  let schema: typeof import('../../db/schema.js');
  let engine: InstanceType<(typeof import('../../services/order-engine.js'))['OrderEngine']>;

  const ADDR = 'TACBmCJj8xFqUjVqYx9TFhX5acU7zD5Win';
  const PAYER = 'TQ1zZmDXbX6qeQfambjkyqbHzDZLQqnWcA';
  let merchantId: string;

  beforeAll(async () => {
    const dbModule = await import('../../db/index.js');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    schema = await import('../../db/schema.js');
    const { OrderEngine } = await import('../../services/order-engine.js');

    db = dbModule.getDb();
    closeDb = dbModule.closeDb;
    await migrate(db, { migrationsFolder: './src/db/migrations' });

    const webhook = { notify: vi.fn().mockResolvedValue(undefined) };
    const sweeper = {
      queueSweep: vi.fn().mockResolvedValue(undefined),
      isSweepEnabled: () => false,
    };
    engine = new OrderEngine({} as never, webhook as never, sweeper as never);
  });

  afterAll(async () => {
    await closeDb?.();
  });

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE unmatched_transfers, transactions, order_events, orders, merchant_addresses, addresses, merchants RESTART IDENTITY CASCADE`,
    );
    const [m] = await db
      .insert(schema.merchants)
      .values({ name: 'it', apiKeyHash: 'h'.repeat(64), apiKeyPrefix: 'pw_it', webhookSecret: 's' })
      .returning({ id: schema.merchants.id });
    merchantId = m.id;
    await db.insert(schema.merchantAddresses).values({
      merchantId,
      address: ADDR,
      role: 'default',
      status: 'active',
      activatedAt: new Date(),
    });
  });

  const create = (externalId: string, amount = '100') =>
    engine.createOrder({
      externalId,
      amount,
      callbackUrl: 'https://merchant.example/webhook',
      merchantId,
      webhookSecret: 's',
    });

  it('migration 0004 applied: new tables, columns and the partial unique index exist', async () => {
    const idx = await db.execute(
      sql`SELECT indexname FROM pg_indexes WHERE tablename = 'orders' AND indexname = 'orders_pending_address_tail_uq'`,
    );
    expect(idx.rows).toHaveLength(1);
    const cols = await db.execute(
      sql`SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'orders' AND column_name IN ('tail','amount_payable','derivation_idx')`,
    );
    expect(cols.rows.map((r) => `${r.column_name}:${r.is_nullable}`).sort()).toEqual([
      'amount_payable:YES',
      'derivation_idx:YES',
      'tail:YES',
    ]);
  });

  it('allocates distinct tails to concurrent orders on one address', async () => {
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => create(`ext-${i}`)));
    const tails = results.map((r) => r.order.tail);
    expect(new Set(tails).size).toBe(40);
    for (const r of results) {
      expect(r.order.address).toBe(ADDR);
      expect(r.order.derivationIdx).toBeNull();
      expect(r.order.amountPayable).toBe(`100.00${r.order.tail}`);
    }
  });

  it('the partial unique index rejects a second pending order with the same tail', async () => {
    const { order } = await create('ext-a');
    await expect(
      db.insert(schema.orders).values({
        externalId: 'ext-dup',
        merchantId,
        address: ADDR,
        tail: order.tail,
        amountExpected: '100.000000',
        amountPayable: order.amountPayable,
        callbackUrl: 'https://merchant.example/webhook',
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toMatchObject({
      cause: { code: '23505', constraint: 'orders_pending_address_tail_uq' },
    });
  });

  it('credits a transfer by tail, then refuses the same tx_hash a second time', async () => {
    const { order } = await create('ext-b');
    await engine.onPaymentDetected('tx-1', ADDR, order.amountPayable!, PAYER, 1, Date.now());
    const [after] = await db.select().from(schema.orders).where(eq(schema.orders.id, order.id));
    expect(after.status).toBe('detected');
    expect(after.txHash).toBe('tx-1');

    // Re-scan of the same transfer: no second transactions row, no unmatched row.
    await engine.onPaymentDetected('tx-1', ADDR, order.amountPayable!, PAYER, 1, Date.now());
    const txRows = await db.select().from(schema.transactions);
    expect(txRows).toHaveLength(1);
    const unmatched = await db.select().from(schema.unmatchedTransfers);
    expect(unmatched).toHaveLength(0);
  });

  it('records a rounded payment as unmatched and lets exactly one of two concurrent claims win', async () => {
    const { order } = await create('ext-c');
    await engine.onPaymentDetected('tx-round', ADDR, '100.000000', PAYER, 1, Date.now());
    const [um] = await db.select().from(schema.unmatchedTransfers);
    expect(um).toMatchObject({ txHash: 'tx-round', reason: 'no_pending_order_for_tail' });

    const { order: other } = await create('ext-d');
    const results = await Promise.allSettled([
      engine.claimUnmatched(um.id, order.id, { claimedBy: 'a' }),
      engine.claimUnmatched(um.id, other.id, { claimedBy: 'b' }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toMatchObject({ code: 'ALREADY_CLAIMED' });

    const detected = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.status, 'detected'));
    expect(detected).toHaveLength(1);
    const events = await db
      .select()
      .from(schema.orderEvents)
      .where(eq(schema.orderEvents.eventType, 'payment_claimed'));
    expect(events).toHaveLength(1);
  });

  it('keeps a tail reserved for 24h after the order leaves pending', async () => {
    const { order } = await create('ext-e');
    await engine.onPaymentDetected('tx-e', ADDR, order.amountPayable!, PAYER, 1, Date.now());
    const later = await Promise.all(Array.from({ length: 20 }, (_, i) => create(`ext-e-${i}`)));
    expect(later.map((r) => r.order.tail)).not.toContain(order.tail);
  });

  it('leaves reused historical tails unmatched instead of crediting the new order', async () => {
    const { order: old } = await create('old');
    await db.update(schema.orders).set({
      status: 'expired', updatedAt: new Date(Date.now() - 2 * 86400_000),
    }).where(eq(schema.orders.id, old.id));
    const { order: current } = await create('current');
    await db.update(schema.orders).set({ tail: old.tail, amountPayable: old.amountPayable })
      .where(eq(schema.orders.id, current.id));

    await engine.onPaymentDetected('late-for-old', ADDR, old.amountPayable!, PAYER, 42, Date.now());

    const [after] = await db.select().from(schema.orders).where(eq(schema.orders.id, current.id));
    expect(after.status).toBe('pending');
    const [unmatched] = await db.select().from(schema.unmatchedTransfers);
    expect(unmatched).toMatchObject({ txHash: 'late-for-old', reason: 'ambiguous_tail' });
    await engine.claimUnmatched(unmatched.id, current.id, { claimedBy: 'operator' });
    const [claimed] = await db.select().from(schema.orders).where(eq(schema.orders.id, current.id));
    expect(claimed.status).toBe('detected');
  });

  it('records a late payment with no pending orders in address mode', async () => {
    const { initChainWatcher } = await import('../../services/chain-watcher.js');
    const { order } = await create('expired-address-scan');
    await db.update(schema.orders).set({ status: 'expired' }).where(eq(schema.orders.id, order.id));
    initChainWatcher('redis://unused', engine);
    fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({
      success: true, data: [{
        type: 'Transfer', token_info: { address: process.env.USDT_CONTRACT },
        transaction_id: 'late-address', from: PAYER, to: ADDR,
        value: '100000000', block_timestamp: Date.now(),
      }],
    }) });

    await runWatcherJob({ name: 'scan' });
    await runWatcherJob({ name: 'scan' });

    const unmatched = await db.select().from(schema.unmatchedTransfers);
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]).toMatchObject({ txHash: 'late-address', merchantId });
  });

  it('records late payments to a previously activated disabled address in block mode', async () => {
    const { TronWeb } = await import('tronweb');
    const { scanConfirmedBlock } = await import('../../services/block-scanner.js');
    await db.update(schema.merchantAddresses).set({ status: 'disabled' });
    const hex = (address: string) => '0x' + TronWeb.address.toHex(address).slice(2);
    fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({
      success: true, data: [{
        event_name: 'Transfer', contract_address: process.env.USDT_CONTRACT,
        block_number: 42, block_timestamp: Date.now(), transaction_id: 'late-block',
        result: { from: hex(PAYER), to: hex(ADDR), value: '100000000' },
      }],
    }) });

    await scanConfirmedBlock(42, engine);

    const [unmatched] = await db.select().from(schema.unmatchedTransfers);
    expect(unmatched).toMatchObject({ txHash: 'late-block', merchantId });
  });

  it('requires a test transfer after the address confirmation', async () => {
    const confirmedAt = new Date();
    await db.update(schema.merchantAddresses).set({ status: 'pending_test', confirmedAt, activatedAt: null });
    await engine.onPaymentDetected('old-test', ADDR, '0.100000', PAYER, 42, confirmedAt.getTime() - 60_000);
    expect((await db.select().from(schema.merchantAddresses))[0].status).toBe('pending_test');
    await engine.onPaymentDetected('fresh-test', ADDR, '0.100000', PAYER, 43, confirmedAt.getTime() + 1_000);
    expect((await db.select().from(schema.merchantAddresses))[0].status).toBe('active');
  });
});
