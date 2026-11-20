import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

const url = process.env.INTEGRATION_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
vi.stubEnv('HOT_WALLET_KEY', '1'.repeat(64));
vi.stubEnv('ADDRESS_MODE', 'hd');
vi.stubEnv('COLD_WALLET_ADDRESS', 'TQ1zZmDXbX6qeQfambjkyqbHzDZLQqnWcA');
const { inspect } = vi.hoisted(() => ({ inspect: vi.fn() }));
vi.mock('../../services/chain-transactions.js', async (original) => ({
  ...await original<typeof import('../../services/chain-transactions.js')>(), getChainOutcome: inspect,
}));

describe.skipIf(!url)('durable native funding on PostgreSQL', () => {
  let module: typeof import('../../db/index.js');
  let schema: typeof import('../../db/schema.js');
  let GasManager: (typeof import('../../services/gas-manager.js'))['GasManager'];
  let scope: { orderId: string; fundingId: string };
  let manager: InstanceType<typeof GasManager>;
  const address = 'TACBmCJj8xFqUjVqYx9TFhX5acU7zD5Win';
  const build = vi.fn(); const sign = vi.fn(); const broadcast = vi.fn();
  const balance = vi.fn(); const account = vi.fn();
  const buildUsdt = vi.fn();
  const tronWeb = { transactionBuilder: { sendTrx: build, triggerSmartContract: buildUsdt }, trx: {
    sign, sendRawTransaction: broadcast, getBalance: balance, getAccount: account,
  } };
  const read = async () => (await module.getDb().select().from(schema.nativeFunding))[0];
  const topup = () => manager.checkAndTopup(address, scope);
  const newManager = () => {
    const result = new GasManager(tronWeb as never);
    vi.spyOn(result, 'waitForConfirmation').mockResolvedValue(undefined);
    return result;
  };
  beforeAll(async () => {
    module = await import('../../db/index.js'); schema = await import('../../db/schema.js');
    ({ GasManager } = await import('../../services/gas-manager.js'));
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await migrate(module.getDb(), { migrationsFolder: './src/db/migrations' });
  });
  afterAll(async () => { vi.restoreAllMocks(); await module?.closeDb(); });
  beforeEach(async () => {
    vi.restoreAllMocks();
    inspect.mockReset().mockResolvedValue({ status: 'pending' });
    balance.mockReset().mockResolvedValue(0); account.mockReset().mockResolvedValue({});
    build.mockReset().mockResolvedValue({});
    buildUsdt.mockReset().mockResolvedValue({ result: { result: true }, transaction: { usdt: true } });
    sign.mockReset().mockResolvedValue({ txID: 'd'.repeat(64), raw_data: { expiration: Date.now() + 60_000 }, signature: ['native'] });
    broadcast.mockReset().mockResolvedValue({ result: true, transaction: { txID: 'd'.repeat(64) } });
    const db = module.getDb(); await db.execute(sql`TRUNCATE merchants CASCADE`);
    const [merchant] = await db.insert(schema.merchants).values({ name: 'native', apiKeyHash: 'native',
      apiKeyPrefix: 'native', webhookSecret: 'native-secret' }).returning();
    const [order] = await db.insert(schema.orders).values({ merchantId: merchant.id, externalId: 'native', address,
      derivationIdx: 0, amountExpected: '100', amountReceived: '100', status: 'confirmed',
      callbackUrl: 'https://merchant.example/webhook', expiresAt: new Date() }).returning();
    scope = { orderId: order.id, fundingId: randomUUID() }; manager = newManager();
  });

  it('resumes the original gas transaction after a lost response and process restart with stale balance', async () => {
    broadcast.mockRejectedValueOnce(new Error('broadcast response lost'));
    await expect(topup()).rejects.toThrow('broadcast response lost');
    await module.closeDb(); manager = newManager();
    await topup();
    expect(build).toHaveBeenCalledTimes(1); expect(sign).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[1][0]).toEqual(broadcast.mock.calls[0][0]);
    expect(await read()).toMatchObject({ status: 'confirmed', txHash: 'd'.repeat(64) });
  });

  it('commits signed bytes before broadcasting even when the caller transaction rolls back', async () => {
    broadcast.mockImplementation(async (transaction) => {
      expect(await read()).toMatchObject({ txHash: transaction.txID, signedTransaction: transaction });
      throw new Error('response lost');
    });
    await expect(module.getDb().transaction(async () => { await topup(); })).rejects.toThrow('response lost');
    expect((await read()).txHash).toBe('d'.repeat(64));
  });

  it('does not fund a confirmed cycle again when the balance endpoint still lags', async () => {
    await topup(); await topup();
    expect(build).toHaveBeenCalledTimes(1); expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('keeps an expired unknown native transaction without creating a replacement', async () => {
    broadcast.mockRejectedValueOnce(new Error('response lost'));
    await expect(topup()).rejects.toThrow();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_000);
    vi.mocked(manager.waitForConfirmation).mockRejectedValue(new Error('outcome unknown'));
    await expect(topup()).rejects.toThrow('outcome unknown');
    expect(build).toHaveBeenCalledTimes(1); expect(broadcast).toHaveBeenCalledTimes(1);
    expect((await read()).status).toBe('unknown');
  });

  it('serializes concurrent funding preparation', async () => {
    await Promise.all([topup(), topup()]);
    expect(build).toHaveBeenCalledTimes(1); expect(sign).toHaveBeenCalledTimes(1);
    const events = await module.getDb().select().from(schema.orderEvents);
    expect(events.filter((e) => e.eventType === 'native_funding_confirmed')).toHaveLength(1);
  });

  it('resumes an activation transfer through the same durable path', async () => {
    broadcast.mockRejectedValueOnce(new Error('activation response lost'));
    await expect(manager.checkAndActivate(address, scope)).rejects.toThrow('activation response lost');
    await manager.checkAndActivate(address, scope);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(await read()).toMatchObject({ purpose: 'activation', status: 'confirmed', amountSun: '100000' });
  });

  it('does not bypass unknown funding by requesting another cycle for the same address', async () => {
    broadcast.mockRejectedValueOnce(new Error('response lost'));
    await expect(topup()).rejects.toThrow('response lost');
    await expect(manager.checkAndTopup(address, { ...scope, fundingId: randomUUID() })).rejects.toThrow('requires reconciliation');
    expect(sign).toHaveBeenCalledTimes(1); expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('does not broadcast when durable persistence fails', async () => {
    await module.getDb().execute(sql`ALTER TABLE native_funding ADD CONSTRAINT test_reject_native CHECK (status <> 'prepared') NOT VALID`);
    try {
      await expect(topup()).rejects.toThrow();
      expect(broadcast).not.toHaveBeenCalled();
      expect(await module.getDb().select().from(schema.nativeFunding)).toHaveLength(0);
    } finally { await module.getDb().execute(sql`ALTER TABLE native_funding DROP CONSTRAINT test_reject_native`); }
  });

  it('skips funding when account activation and sufficient gas are already observed', async () => {
    account.mockResolvedValue({ address }); balance.mockResolvedValue(100_000_000);
    expect(await manager.checkAndActivate(address, scope)).toBe(false);
    expect(await topup()).toBe(false);
    expect(sign).not.toHaveBeenCalled(); expect(broadcast).not.toHaveBeenCalled();
    expect((await module.getDb().select().from(schema.nativeFunding)).map((operation) => operation.status)).toEqual(['skipped', 'skipped']);
  });

  it('recovers gas through the real sweep coordinator without retaining its database lock during network waits', async () => {
    const { runDurableSweep } = await import('../../services/sweep-executor.js');
    const { eq } = await import('drizzle-orm');
    await module.getDb().insert(schema.sweepJobs).values({ ...scope, amount: '100' });
    account.mockResolvedValue({ address });
    sign.mockImplementation(async (unsigned) => ({ txID: (unsigned.usdt ? 'e' : 'd').repeat(64),
      raw_data: { expiration: Date.now() + 60_000 }, signature: ['signed'] }));
    broadcast.mockImplementationOnce(async () => {
      await module.getDb().transaction(async (tx) => {
        await tx.execute(sql`SELECT order_id FROM sweep_jobs WHERE order_id = ${scope.orderId} FOR UPDATE NOWAIT`);
      });
      throw new Error('gas response lost');
    });
    const wallet = { getPrivateKeyForSigning: async () => Buffer.alloc(32, 1) };
    await expect(runDurableSweep(scope.orderId, wallet as never, manager)).rejects.toThrow('gas response lost');
    const [pending] = await module.getDb().select().from(schema.sweepJobs);
    expect(pending).toMatchObject({ status: 'pending', fundingId: scope.fundingId, txHash: null });
    await module.closeDb(); manager = newManager();
    inspect.mockImplementation(async (_hash, kind) => ({ status: kind === 'trx' ? 'success' : 'pending' }));
    await runDurableSweep(scope.orderId, wallet as never, manager);
    expect(build).toHaveBeenCalledTimes(1); expect(buildUsdt).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls.map(([tx]) => tx.txID)).toEqual(['d'.repeat(64), 'e'.repeat(64)]);
    expect((await module.getDb().select().from(schema.sweepJobs).where(eq(schema.sweepJobs.orderId, scope.orderId)))[0].status).toBe('confirmed');
  });

  it('requires explicit sweep recovery after proven native failure and retains the previous funding attempt', async () => {
    const { runDurableSweep } = await import('../../services/sweep-executor.js');
    const { ensureSweepIntent } = await import('../../services/sweep-intents.js');
    const { ChainExecutionError } = await import('../../services/chain-transactions.js');
    await module.getDb().insert(schema.sweepJobs).values({ ...scope, amount: '100' });
    account.mockResolvedValue({ address });
    vi.mocked(manager.waitForConfirmation).mockRejectedValueOnce(new ChainExecutionError('REVERT'));
    const wallet = { getPrivateKeyForSigning: async () => Buffer.alloc(32, 1) };
    await expect(runDurableSweep(scope.orderId, wallet as never, manager)).rejects.toThrow('REVERT');
    expect((await module.getDb().select().from(schema.sweepJobs))[0].status).toBe('failed');
    await runDurableSweep(scope.orderId, wallet as never, manager);
    expect(sign).toHaveBeenCalledTimes(1);
    await ensureSweepIntent(scope.orderId, true);
    const [retry] = await module.getDb().select().from(schema.sweepJobs);
    expect(retry.fundingId).not.toBe(scope.fundingId);
    sign.mockImplementation(async (unsigned) => ({ txID: (unsigned.usdt ? 'e' : 'f').repeat(64),
      raw_data: { expiration: Date.now() + 60_000 }, signature: ['retry'] }));
    await runDurableSweep(scope.orderId, wallet as never, manager);
    const operations = await module.getDb().select().from(schema.nativeFunding);
    expect(operations.filter((operation) => operation.purpose === 'gas').map((operation) => operation.status).sort()).toEqual(['confirmed', 'failed']);
    expect((await module.getDb().select().from(schema.sweepJobs))[0].status).toBe('confirmed');
  });

  it('quarantines old pending sweeps with no persisted gas history during upgrade', async () => {
    await module.getDb().insert(schema.sweepJobs).values({ ...scope, amount: '100' });
    const migration = readFileSync('src/db/migrations/0010_quarantine_legacy_native_funding.sql', 'utf8');
    for (let replay = 0; replay < 2; replay++) await module.getDb().transaction(async (tx) => {
      for (const statement of migration.split('--> statement-breakpoint')) await tx.execute(sql.raw(statement));
    });
    expect((await module.getDb().select().from(schema.sweepJobs))[0].status).toBe('legacy_review');
    const { runDurableSweep } = await import('../../services/sweep-executor.js');
    await runDurableSweep(scope.orderId, {} as never, manager);
    expect(sign).not.toHaveBeenCalled(); expect(broadcast).not.toHaveBeenCalled();
    expect((await module.getDb().select().from(schema.orderEvents)).filter((event) => event.eventType === 'sweep_funding_reconciliation_required')).toHaveLength(1);
  });
});
