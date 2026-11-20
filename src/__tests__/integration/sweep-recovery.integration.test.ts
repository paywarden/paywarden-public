import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';

const url = process.env.INTEGRATION_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
vi.stubEnv('ADDRESS_MODE', 'hd');
vi.stubEnv('HOT_WALLET_KEY', '1'.repeat(64));
vi.stubEnv('COLD_WALLET_ADDRESS', 'TQ1zZmDXbX6qeQfambjkyqbHzDZLQqnWcA');

describe.skipIf(!url)('durable sweep recovery on PostgreSQL', () => {
  let dbModule: typeof import('../../db/index.js');
  let schema: typeof import('../../db/schema.js');
  let execute: typeof import('../../services/sweep-executor.js');
  let errors: typeof import('../../services/chain-transactions.js');
  let intents: typeof import('../../services/sweep-intents.js');
  let orderId: string;
  const address = 'TACBmCJj8xFqUjVqYx9TFhX5acU7zD5Win';
  const key = Buffer.alloc(32, 1);
  const signing = vi.fn();
  const inspect = vi.fn();
  const broadcast = vi.fn();
  const wait = vi.fn();
  const build = vi.fn();
  const wallet = { getPrivateKeyForSigning: async () => key };
  const gas = {
    checkAndActivate: async () => undefined, checkHotWalletBalance: async () => undefined,
    checkAndTopup: async () => undefined, getTransactionOutcome: inspect, waitForConfirmation: wait,
    tronWeb: { transactionBuilder: { triggerSmartContract: build }, trx: { sign: signing, sendRawTransaction: broadcast } },
  };
  const read = async () => (await dbModule.getDb().select().from(schema.sweepJobs))[0];
  const run = () => execute.runDurableSweep(orderId, wallet as never, gas as never);

  beforeAll(async () => {
    dbModule = await import('../../db/index.js');
    schema = await import('../../db/schema.js');
    execute = await import('../../services/sweep-executor.js');
    errors = await import('../../services/chain-transactions.js');
    intents = await import('../../services/sweep-intents.js');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await migrate(dbModule.getDb(), { migrationsFolder: './src/db/migrations' });
  });
  afterAll(async () => { vi.restoreAllMocks(); await dbModule?.closeDb(); });
  beforeEach(async () => {
    vi.restoreAllMocks(); key.fill(1);
    inspect.mockReset().mockResolvedValue({ status: 'pending' });
    wait.mockReset().mockRejectedValue(new Error('Receipt timeout'));
    build.mockReset().mockResolvedValue({ result: { result: true }, transaction: {} });
    signing.mockReset().mockResolvedValue({ txID: 'a'.repeat(64), raw_data: { expiration: Date.now() + 60_000 }, signature: ['signed'] });
    broadcast.mockReset().mockImplementation(async (transaction) => {
      const persisted = await read();
      expect(persisted.txHash).toBe(transaction.txID);
      expect(persisted.signedTransaction).toEqual(transaction);
      return { result: true };
    });
    const db = dbModule.getDb();
    await db.execute(sql`TRUNCATE merchants CASCADE`);
    const [merchant] = await db.insert(schema.merchants).values({
      name: 'sweep', apiKeyHash: 'sweep', apiKeyPrefix: 'sweep', webhookSecret: 'sweep-secret',
    }).returning();
    const [order] = await db.insert(schema.orders).values({
      merchantId: merchant.id, externalId: 'sweep', address, derivationIdx: 0,
      amountExpected: '100.000000', amountReceived: '100.000000', paymentStatus: 'confirmed',
      status: 'confirmed', callbackUrl: 'https://merchant.example/webhook', expiresAt: new Date(),
    }).returning();
    orderId = order.id;
    await db.insert(schema.addresses).values({ address, derivationIdx: 0, isAllocated: true, allocatedTo: orderId });
    await db.insert(schema.sweepJobs).values({ orderId, amount: '100.000000' });
  });

  it('persists before broadcasting and resumes the original transaction after restart', async () => {
    await expect(run()).rejects.toThrow('Receipt timeout');
    expect(await read()).toMatchObject({ status: 'unknown', txHash: 'a'.repeat(64) });
    expect(key.every((byte) => byte === 0)).toBe(true);
    await dbModule.closeDb();
    inspect.mockResolvedValue({ status: 'success' });
    await run(); await run();
    expect(signing).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect((await read()).status).toBe('confirmed');
    const events = await dbModule.getDb().select().from(schema.orderEvents).where(eq(schema.orderEvents.eventType, 'sweep_completed'));
    expect(events).toHaveLength(1);
  });

  it('rebroadcasts identical signed bytes after a lost broadcast response', async () => {
    broadcast.mockRejectedValueOnce(new Error('response lost'));
    await expect(run()).rejects.toThrow('response lost');
    wait.mockResolvedValue(undefined);
    await run();
    expect(signing).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[1][0]).toEqual(broadcast.mock.calls[0][0]);
    expect((await read()).status).toBe('confirmed');
  });

  it('does not build a replacement when the original expired but its result is unknown', async () => {
    await expect(run()).rejects.toThrow();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_000);
    await expect(run()).rejects.toThrow('Receipt timeout');
    expect(signing).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect((await read()).status).toBe('unknown');
  });

  it('never marks failed execution complete and requires explicit retry for replacement', async () => {
    wait.mockRejectedValue(new errors.ChainExecutionError('OUT_OF_ENERGY'));
    await expect(run()).rejects.toThrow('OUT_OF_ENERGY');
    expect((await read()).status).toBe('failed');
    await run();
    expect(signing).toHaveBeenCalledTimes(1);
    expect((await dbModule.getDb().select().from(schema.addresses))[0].sweepTxHash).toBeNull();
    expect(await intents.ensureSweepIntent(orderId, true)).toBe(true);
    signing.mockResolvedValue({ txID: 'b'.repeat(64), raw_data: { expiration: Date.now() + 60_000 }, signature: ['replacement'] });
    wait.mockResolvedValue(undefined);
    await run();
    expect((await read()).txHash).toBe('b'.repeat(64));
    const [failure] = await dbModule.getDb().select().from(schema.orderEvents).where(eq(schema.orderEvents.eventType, 'sweep_failed'));
    expect(failure.payload).toMatchObject({ sweep_tx_hash: 'a'.repeat(64) });
  });

  it('serializes preparation and records completion once when workers race', async () => {
    wait.mockResolvedValue(undefined);
    await Promise.all([run(), run()]);
    expect(signing).toHaveBeenCalledTimes(1);
    expect(new Set(broadcast.mock.calls.map(([transaction]) => transaction.txID)).size).toBe(1);
    const events = await dbModule.getDb().select().from(schema.orderEvents).where(eq(schema.orderEvents.eventType, 'sweep_completed'));
    expect(events).toHaveLength(1);
  });
});
