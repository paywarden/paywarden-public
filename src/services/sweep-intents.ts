import { and, eq, inArray, lte } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/index.js';
import { orders, orderEvents, sweepJobs } from '../db/schema.js';
import { EVENT_TYPE } from '../config/constants.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export async function ensureSweepIntent(orderId: string, retry = false): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    // The order key is unchanged; allow event/funding FK checks while waiting
    // for the sweep row so completion and admin recovery cannot deadlock.
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('no key update');
    if (!order || order.derivationIdx === null) return false;
    const [job] = await tx.select().from(sweepJobs).where(eq(sweepJobs.orderId, orderId)).for('update');
    if (!job) {
      // New confirmations create their intents atomically. Missing historical
      // intents cannot prove whether an old worker already broadcast a tx.
      await tx.insert(sweepJobs).values({ orderId, amount: order.amountReceived, status: 'legacy_review',
        lastError: 'No durable broadcast history; reconcile chain history before authorizing a new sweep' });
      return false;
    }
    if (retry && job.status === 'failed') {
      await tx.insert(orderEvents).values({ orderId, eventType: EVENT_TYPE.ADMIN_SWEEP_RETRY,
        payload: { previous_tx_hash: job.txHash, previous_error: job.lastError, previous_funding_id: job.fundingId } });
      await tx.update(sweepJobs).set({ status: 'pending', txHash: null, signedTransaction: null,
        fundingId: randomUUID(),
        expiresAt: null, toAddress: null, contractAddress: null, lastError: null,
        nextAttemptAt: new Date(), updatedAt: new Date() }).where(eq(sweepJobs.orderId, orderId));
      return true;
    }
    return ['pending', 'prepared', 'broadcast', 'unknown'].includes(job.status) && job.nextAttemptAt.getTime() <= Date.now();
  });
}

export async function recoverSweepIntents(enqueue: (orderId: string) => Promise<void>): Promise<void> {
  if (env.ADDRESS_MODE !== 'hd' || !env.HOT_WALLET_KEY || !env.COLD_WALLET_ADDRESS) return;
  const jobs = await getDb().select({ orderId: sweepJobs.orderId }).from(sweepJobs).where(and(
    inArray(sweepJobs.status, ['pending', 'prepared', 'broadcast', 'unknown']), lte(sweepJobs.nextAttemptAt, new Date()),
  )).limit(100);
  for (const job of jobs) {
    try { await enqueue(job.orderId); }
    catch (err) { logger.error({ err, orderId: job.orderId }, 'Durable sweep remains pending for recovery'); }
  }
}
