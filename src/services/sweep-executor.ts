import { and, eq, inArray } from 'drizzle-orm';
import { Decimal } from 'decimal.js';
import type { Types } from 'tronweb';
import { getDb } from '../db/index.js';
import { addresses, nativeFunding, orderEvents, orders, sweepJobs } from '../db/schema.js';
import type { SweepJob } from '../db/schema.js';
import { env } from '../config/env.js';
import { EVENT_TYPE, USDT_MULTIPLIER } from '../config/constants.js';
import { isSweepEligibleStatus } from '../utils/order-recovery.js';
import type { WalletService } from './wallet.js';
import type { GasManager } from './gas-manager.js';
import { ChainExecutionError } from './chain-transactions.js';
type SignedTransaction = Types.SignedTransaction;

async function fund(orderId: string, gas: GasManager): Promise<void> {
  const db = getDb();
  const [job] = await db.select().from(sweepJobs).where(eq(sweepJobs.orderId, orderId));
  if (!job || job.status !== 'pending' || job.txHash) return;
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order || !isSweepEligibleStatus(order.status) || order.derivationIdx === null || new Decimal(job.amount).lt(env.SWEEP_MIN_USDT)) return;
  if (!env.COLD_WALLET_ADDRESS) throw new Error('Cold wallet is not configured');
  const funding = { orderId, fundingId: job.fundingId };
  // Network waits must not hold the sweep row lock. Concurrent callers share
  // the same durable native transactions, then serialize USDT preparation.
  await gas.checkAndActivate(order.address, funding);
  await gas.checkHotWalletBalance();
  await gas.checkAndTopup(order.address, funding);
}

async function prepare(orderId: string, wallet: WalletService, gas: GasManager): Promise<SweepJob | undefined> {
  return getDb().transaction(async (tx) => {
    const [job] = await tx.select().from(sweepJobs).where(eq(sweepJobs.orderId, orderId)).for('update');
    if (!job || job.status !== 'pending' || job.txHash) return job;
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
    if (!order || !isSweepEligibleStatus(order.status) || order.derivationIdx === null ||
        new Decimal(job.amount).lt(env.SWEEP_MIN_USDT)) {
      const [skipped] = await tx.update(sweepJobs).set({ status: 'skipped', updatedAt: new Date() })
        .where(eq(sweepJobs.orderId, orderId)).returning();
      return skipped;
    }
    if (!env.COLD_WALLET_ADDRESS) throw new Error('Cold wallet is not configured');
    const amountSun = new Decimal(job.amount).mul(USDT_MULTIPLIER).toFixed(0);
    const built = await gas.tronWeb.transactionBuilder.triggerSmartContract(
      env.USDT_CONTRACT, 'transfer(address,uint256)', { feeLimit: 50_000_000 },
      [{ type: 'address', value: env.COLD_WALLET_ADDRESS }, { type: 'uint256', value: amountSun }], order.address,
    );
    if (!built.result?.result || !built.transaction) throw new Error('Could not build sweep transaction');
    const key = await wallet.getPrivateKeyForSigning(order.derivationIdx);
    let signed: SignedTransaction;
    try { signed = await gas.tronWeb.trx.sign(built.transaction, key.toString('hex')); }
    finally { key.fill(0); }
    const expiration = signed.raw_data.expiration;
    if (!/^[0-9a-f]{64}$/i.test(signed.txID) || !Number.isSafeInteger(expiration) || expiration <= Date.now()) {
      throw new Error('Invalid or expired prepared sweep transaction');
    }
    const [prepared] = await tx.update(sweepJobs).set({
      status: 'prepared', txHash: signed.txID, signedTransaction: signed as unknown as Record<string, unknown>,
      expiresAt: new Date(expiration), toAddress: env.COLD_WALLET_ADDRESS,
      contractAddress: env.USDT_CONTRACT, updatedAt: new Date(),
    }).where(eq(sweepJobs.orderId, orderId)).returning();
    return prepared;
  });
}

async function markConfirmed(job: SweepJob): Promise<void> {
  await getDb().transaction(async (tx) => {
    const [current] = await tx.select().from(sweepJobs).where(eq(sweepJobs.orderId, job.orderId)).for('update');
    if (!current || current.status === 'confirmed' || current.txHash !== job.txHash) return;
    const [order] = await tx.select({ address: orders.address }).from(orders).where(eq(orders.id, job.orderId));
    if (!order) throw new Error('Sweep order is missing');
    await tx.update(addresses).set({ sweepTxHash: job.txHash, lastSweptAt: new Date() })
      .where(eq(addresses.address, order.address));
    await tx.update(sweepJobs).set({ status: 'confirmed', lastError: null, updatedAt: new Date() })
      .where(eq(sweepJobs.orderId, job.orderId));
    await tx.insert(orderEvents).values({
      orderId: job.orderId, eventType: EVENT_TYPE.SWEEP_COMPLETED,
      payload: { sweep_tx_hash: job.txHash, amount: job.amount, to: job.toAddress, mode: env.SWEEP_MODE },
    });
  });
}

export async function runDurableSweep(orderId: string, wallet: WalletService, gas: GasManager): Promise<void> {
  let job: SweepJob | undefined;
  try { await fund(orderId, gas); job = await prepare(orderId, wallet, gas); }
  catch (error) {
    // Native funding commits independently; the failed outer preparation has
    // rolled back before we move the sweep to explicit operator recovery.
    if (error instanceof ChainExecutionError) await getDb().transaction(async (tx) => {
      const [current] = await tx.select().from(sweepJobs).where(eq(sweepJobs.orderId, orderId)).for('update');
      if (!current || current.status !== 'pending') return;
      const [failed] = await tx.select({ id: nativeFunding.id }).from(nativeFunding).where(and(
        eq(nativeFunding.fundingId, current.fundingId), eq(nativeFunding.status, 'failed'),
      ));
      if (!failed) return;
      const [changed] = await tx.update(sweepJobs).set({ status: 'failed', lastError: error.message, updatedAt: new Date() })
        .where(and(eq(sweepJobs.orderId, orderId), eq(sweepJobs.status, 'pending'))).returning();
      if (changed) await tx.insert(orderEvents).values({ orderId, eventType: EVENT_TYPE.SWEEP_FAILED,
        payload: { reason: error.message, funding_id: changed.fundingId, execution_failed: true } });
    });
    throw error;
  }
  if (!job || ['confirmed', 'failed', 'skipped', 'legacy_review'].includes(job.status)) return;
  if (!job.txHash || !job.toAddress || !job.contractAddress) throw new Error('Incomplete durable sweep state');
  const [order] = await getDb().select({ address: orders.address }).from(orders).where(eq(orders.id, orderId));
  if (!order) return;
  const expected = {
    from: order.address, to: job.toAddress, contract: job.contractAddress,
    amountSun: new Decimal(job.amount).mul(USDT_MULTIPLIER).toFixed(0),
  };
  try {
    const outcome = await gas.getTransactionOutcome(job.txHash, expected);
    if (outcome.status === 'failed') throw new ChainExecutionError(outcome.reason);
    if (outcome.status === 'success') { await markConfirmed(job); return; }
    if (job.signedTransaction && job.expiresAt && job.expiresAt.getTime() > Date.now()) {
      // Identical signed bytes have the SAME txID. A retry never rebuilds an
      // unknown transaction, even after expiration or a lost RPC response.
      const result = await gas.tronWeb.trx.sendRawTransaction(job.signedTransaction as unknown as SignedTransaction);
      if (!result.result && !['DUP_TRANSACTION_ERROR', '5'].includes(String(result.code))) throw new Error('Sweep broadcast response: ' + result.code);
      await getDb().update(sweepJobs).set({ status: 'broadcast', updatedAt: new Date() })
        .where(and(eq(sweepJobs.orderId, orderId), eq(sweepJobs.txHash, job.txHash),
          inArray(sweepJobs.status, ['prepared', 'broadcast', 'unknown'])));
    }
    await gas.waitForConfirmation(job.txHash, 15_000, 'trc20', expected);
    await markConfirmed(job);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const failed = err instanceof ChainExecutionError;
    await getDb().transaction(async (tx) => {
      const [current] = await tx.select().from(sweepJobs).where(eq(sweepJobs.orderId, orderId)).for('update');
      if (!current || current.status === 'confirmed' || current.txHash !== job.txHash) return;
      await tx.update(sweepJobs).set({
        status: failed ? 'failed' : 'unknown', lastError: reason.slice(0, 2048),
        nextAttemptAt: new Date(Date.now() + 30_000), updatedAt: new Date(),
      }).where(eq(sweepJobs.orderId, orderId));
      if (failed && current.status !== 'failed') await tx.insert(orderEvents).values({
        orderId, eventType: EVENT_TYPE.SWEEP_FAILED, payload: { reason, sweep_tx_hash: job.txHash, execution_failed: true },
      });
    });
    throw err;
  }
}
