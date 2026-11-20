import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { getDb, type Tx } from '../db/index.js';
import { orders, webhookDeliveries } from '../db/schema.js';
import type { Order } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import { derivePaymentStatus } from '../utils/order-recovery.js';

export async function createWebhookIntent(tx: Tx, order: Order, fromAddress: string | null): Promise<void> {
  const paymentStatus = order.paymentStatus ?? derivePaymentStatus(order);
  await tx.insert(webhookDeliveries).values({
    orderId: order.id,
    eventType: `payment.${paymentStatus}`,
    callbackUrl: order.callbackUrl,
    payload: {
      event: `payment.${paymentStatus}`, order_id: order.id, external_id: order.externalId,
      amount_expected: order.amountExpected, amount_payable: order.amountPayable ?? order.amountExpected,
      amount_received: order.amountReceived, currency: order.currency, network: order.network,
      tx_hash: order.txHash, from_address: fromAddress, to_address: order.address,
      status: paymentStatus, payment_status: paymentStatus, timestamp: new Date().toISOString(),
    },
  }).onConflictDoNothing();
}

export async function dispatchWebhookOutbox(enqueue: (id: string) => Promise<void>): Promise<void> {
  const rows = await getDb().select({ id: webhookDeliveries.id }).from(webhookDeliveries).where(and(
    inArray(webhookDeliveries.status, ['pending', 'acknowledged', 'failure_pending']),
    lte(webhookDeliveries.nextAttemptAt, new Date()),
    or(isNull(webhookDeliveries.leaseUntil), lte(webhookDeliveries.leaseUntil, new Date())),
  )).limit(100);
  for (const row of rows) {
    try { await enqueue(row.id); }
    catch (err) { logger.error({ err, deliveryId: row.id }, 'Durable webhook remains pending for recovery'); }
  }
}

export async function retryWebhookIntent(order: Order, callbackUrl?: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    // Also serializes with successful bookkeeping and migration backfills.
    await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, order.id)).for('update');
    const [row] = await tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.orderId, order.id)).for('update');
    if (!row) throw Object.assign(new Error('No durable webhook intent for order'), { code: 'INVALID_STATE' });
    if (row.status === 'delivered' || row.status === 'acknowledged' ||
        (row.leaseUntil && row.leaseUntil.getTime() > Date.now())) {
      throw Object.assign(new Error('Webhook is already delivered or in flight'), { code: 'INVALID_STATE' });
    }
    await tx.update(webhookDeliveries).set({
      status: 'pending', attempt: 0, callbackUrl: callbackUrl ?? row.callbackUrl,
      generation: callbackUrl && callbackUrl !== row.callbackUrl ? row.generation + 1 : row.generation,
      receipt: null, failure: null,
      nextAttemptAt: new Date(), leaseToken: null, leaseUntil: null, lastError: null, updatedAt: new Date(),
    }).where(eq(webhookDeliveries.id, row.id));
  });
}
