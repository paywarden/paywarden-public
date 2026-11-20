import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import type { Tx } from '../db/index.js';
import { orders, orderEvents, transactions, sweepJobs } from '../db/schema.js';
import type { Order } from '../db/schema.js';
import { env } from '../config/env.js';
import { EVENT_TYPE, ORDER_STATUS } from '../config/constants.js';
import { logger } from '../utils/logger.js';
import { derivePaymentStatus } from '../utils/order-recovery.js';
import { CreditAbort, type CreditResult } from './credit-result.js';
import type { Notifier } from './notifier.js';
import { createWebhookIntent } from './webhook-outbox.js';

/**
 * Flip a pending order to detected and record the transaction + event in
 * one transaction. Returns false when the order was no longer pending
 * (expiry sweep won the race) — in that case nothing is written.
 */
export async function creditDetectedPayment(
  order: Order,
  txHash: string,
  toAddress: string,
  amount: string,
  fromAddress: string,
  blockNumber: number,
): Promise<CreditResult> {
  const db = getDb();
  try {
    await db.transaction((tx) =>
      creditWithin(tx, order, txHash, toAddress, amount, fromAddress, blockNumber),
    );
    return 'detected';
  } catch (err) {
    if (err instanceof CreditAbort) return err.result;
    throw err;
  }
}

/**
 * Credit inside the caller's transaction. Order of writes matters:
 *   1. transactions row — tx_hash is the idempotency anchor; a conflict
 *      means this transfer already belongs to something (another order, a
 *      late-payment record, a test transfer) and nothing else may change.
 *   2. order flip, guarded on pending — the expiry sweep may have moved
 *      the order since it was read (Iron Rule 5).
 *   3. payment_detected event (Iron Rule 4).
 * Any failure throws CreditAbort so the whole transaction rolls back.
 */
export async function creditWithin(
  tx: Tx,
  order: Order,
  txHash: string,
  toAddress: string,
  amount: string,
  fromAddress: string,
  blockNumber: number,
): Promise<void> {
  const inserted = await tx
    .insert(transactions)
    .values({
      txHash,
      fromAddress,
      toAddress,
      amount,
      contractAddr: env.USDT_CONTRACT,
      blockNumber,
      orderId: order.id,
    })
    .onConflictDoNothing()
    .returning({ id: transactions.id });
  if (inserted.length === 0) throw new CreditAbort('tx_conflict');

  const [updated] = await tx
    .update(orders)
    .set({
      status: ORDER_STATUS.DETECTED,
      amountReceived: amount,
      txHash,
      updatedAt: new Date(),
    })
    .where(and(eq(orders.id, order.id), eq(orders.status, ORDER_STATUS.PENDING)))
    .returning({ id: orders.id });
  if (!updated) throw new CreditAbort('not_pending');

  await tx.insert(orderEvents).values({
    orderId: order.id,
    eventType: EVENT_TYPE.PAYMENT_DETECTED,
    payload: { tx_hash: txHash, amount, from_address: fromAddress },
  });
}

/**
 * Record an on-chain payment that cannot be credited to a pending order
 * (late payment after expiry, or a transfer predating the order on a
 * reused address). Writes the transactions row (idempotent), a
 * late_payment_detected audit event, and fires an ops alert — but never
 * changes order state (Iron Rule 5). Recovery is a manual admin decision.
 */
export async function recordLatePayment(
  notifier: Notifier | null,
  orderId: string,
  txHash: string,
  toAddress: string,
  amount: string,
  fromAddress: string,
  blockNumber: number,
  detail: Record<string, unknown>,
  matchedOrderId: string | null = orderId,
): Promise<void> {
  const db = getDb();

  const recorded = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(transactions)
      .values({
        txHash,
        fromAddress,
        toAddress,
        amount,
        contractAddr: env.USDT_CONTRACT,
        blockNumber,
        orderId: matchedOrderId,
      })
      .onConflictDoNothing()
      .returning({ id: transactions.id });
    if (inserted.length === 0) return false;

    await tx.insert(orderEvents).values({
      orderId,
      eventType: EVENT_TYPE.LATE_PAYMENT_DETECTED,
      payload: { tx_hash: txHash, amount, from_address: fromAddress, ...detail },
    });
    return true;
  });
  if (!recorded) return;

  logger.error(
    { orderId, txHash, toAddress, amount, ...detail },
    'Late payment recorded — funds on address without a creditable order, manual review required',
  );

  notifier
    ?.notify({ type: 'late_payment', orderId, txHash, amount })
    .catch((err) => logger.error({ err }, 'Failed to send late payment notification'));
}

export async function confirmPayment(txHash: string, confirmations: number, blockNumber: number): Promise<Order | null> {
  if (!Number.isSafeInteger(blockNumber) || blockNumber <= 0) throw new Error('Invalid payment block number');
  const db = getDb();

  const [order] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.txHash, txHash), eq(orders.status, ORDER_STATUS.DETECTED)));

  if (!order) {
    logger.debug({ txHash }, 'No detected order for tx, skipping');
    return null;
  }

  const newStatus = derivePaymentStatus(order);

  const confirmed = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(orders)
      .set({ status: newStatus, paymentStatus: newStatus, updatedAt: new Date() })
      .where(and(eq(orders.id, order.id), eq(orders.status, ORDER_STATUS.DETECTED)))
      .returning({ id: orders.id });
    if (!updated) return false;

    const [payment] = await tx
      .update(transactions)
      .set({ confirmations, confirmedAt: new Date(),
        blockNumber: sql`CASE WHEN ${transactions.blockNumber} = 0 THEN ${blockNumber} ELSE ${transactions.blockNumber} END`,
      })
      .where(eq(transactions.txHash, txHash))
      .returning({ fromAddress: transactions.fromAddress });

    await tx.insert(orderEvents).values({
      orderId: order.id,
      eventType: EVENT_TYPE.PAYMENT_CONFIRMED,
      payload: {
        tx_hash: txHash,
        amount_received: order.amountReceived,
        amount_expected: order.amountExpected,
        status: newStatus,
        confirmations,
      },
    });
    await createWebhookIntent(tx, { ...order, status: newStatus, paymentStatus: newStatus }, payment?.fromAddress ?? null);
    if (env.ADDRESS_MODE === 'hd' && env.HOT_WALLET_KEY && env.COLD_WALLET_ADDRESS && order.derivationIdx !== null) {
      await tx.insert(sweepJobs).values({
        orderId: order.id, amount: order.amountReceived,
        nextAttemptAt: new Date(Date.now() + env.SWEEP_DELAY_MS),
      }).onConflictDoNothing();
    }
    return true;
  });
  if (!confirmed) return null;

  logger.info({ orderId: order.id, txHash, newStatus }, 'Payment confirmed');

  return { ...order, status: newStatus, paymentStatus: newStatus };
}
