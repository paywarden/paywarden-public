import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import type { Tx } from '../db/index.js';
import { orders, transactions, merchantAddresses, unmatchedTransfers } from '../db/schema.js';
import type { Order } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import { ORDER_STATUS, ADDRESS_STATUS } from '../config/constants.js';
import { extractTail } from '../utils/tail.js';
import { type CreditResult } from './credit-result.js';
import type { NotifyEvent } from './notifier.js';
import { activateAddress } from './merchant-address-activation.js';

/**
 * Static-address mode (ADDRESS_MODE=static) payment matching.
 *
 * Many pending orders share one merchant address, so the address alone is
 * ambiguous: the order is found by address + amount tail. Anything that
 * cannot be credited lands in unmatched_transfers for manual claiming —
 * never silently dropped, never auto-credited to the wrong order.
 *
 * Lives outside OrderEngine to keep the HD-mode engine readable; the engine
 * hands over the state-changing primitives it owns via `hooks`.
 */

export interface StaticEngineHooks {
  /** Credit in its own transaction. */
  creditDetectedPayment(
    order: Order,
    txHash: string,
    toAddress: string,
    amount: string,
    fromAddress: string,
    blockNumber: number,
  ): Promise<CreditResult>;
  /** Credit inside the caller's transaction; throws CreditAbort to roll back. */
  creditWithin(
    tx: Tx,
    order: Order,
    txHash: string,
    toAddress: string,
    amount: string,
    fromAddress: string,
    blockNumber: number,
  ): Promise<void>;
  /** Drop the address from the block-scan pending set once nothing is waiting on it. */
  releasePendingAddress(address: string): Promise<void>;
  /** Fire-and-forget ops alert. */
  notify(event: NotifyEvent): void;
}

/** Why a transfer could not be credited automatically (stored on unmatched_transfers.reason). */
export type UnmatchedReason =
  | 'no_pending_order_for_tail'
  | 'predates_order'
  | 'order_left_pending'
  | 'ambiguous_tail'
  | 'unverified_test_transfer'
  | 'predates_address_confirmation';

export async function detectStaticPayment(
  hooks: StaticEngineHooks,
  txHash: string,
  toAddress: string,
  amount: string,
  fromAddress: string,
  blockNumber: number,
  txTimestampMs?: number,
): Promise<void> {
  const db = getDb();

  // The address scanner re-reads the same window every cycle, so every
  // transfer is seen many times. Two idempotency anchors: transactions.tx_hash
  // (credited / test transfer) and unmatched_transfers.tx_hash (recorded for
  // manual claim). Both are checked before any matching so an old unmatched
  // transfer can never be re-evaluated against an order created later.
  const [known] = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.txHash, txHash))
    .limit(1);
  if (known) return;

  const [knownUnmatched] = await db
    .select({ id: unmatchedTransfers.id })
    .from(unmatchedTransfers)
    .where(eq(unmatchedTransfers.txHash, txHash))
    .limit(1);
  if (knownUnmatched) return;

  const [merchantAddress] = await db
    .select()
    .from(merchantAddresses)
    .where(eq(merchantAddresses.address, toAddress))
    .limit(1);

  const unmatched = (reason: UnmatchedReason) =>
    recordUnmatched(hooks, {
      merchantId: merchantAddress?.merchantId ?? null,
      txHash,
      address: toAddress,
      amount,
      fromAddress,
      blockNumber,
      txTimestampMs,
      reason,
    });

  if (merchantAddress?.status === ADDRESS_STATUS.PENDING_TEST) {
    if (txTimestampMs === undefined || !merchantAddress.confirmedAt) {
      await unmatched('unverified_test_transfer');
      return;
    }
    if (txTimestampMs < merchantAddress.confirmedAt.getTime()) {
      await unmatched('predates_address_confirmation');
      return;
    }
    const activated = await activateAddress(
      merchantAddress,
      txHash,
      amount,
      fromAddress,
      blockNumber,
    );
    // Only an activated address stops being watched; a dust transfer must
    // not evict a pending_test address from the block-scan set.
    if (activated) await hooks.releasePendingAddress(merchantAddress.address);
    return;
  }

  const tail = extractTail(amount);
  const [order, priorOrder] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.address, toAddress), eq(orders.tail, tail)))
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(2);

  if (!order || order.status !== ORDER_STATUS.PENDING) {
    await unmatched('no_pending_order_for_tail');
    return;
  }

  if (txTimestampMs !== undefined && txTimestampMs < order.createdAt.getTime()) {
    await unmatched('predates_order');
    return;
  }

  // A transfer sent today for an old invoice is indistinguishable from a
  // payment for a new invoice with the same address and tail. Timestamps
  // and a 24h hold cannot resolve the payer's intent; require manual claim.
  if (priorOrder) {
    await unmatched('ambiguous_tail');
    return;
  }

  const result = await hooks.creditDetectedPayment(
    order,
    txHash,
    toAddress,
    amount,
    fromAddress,
    blockNumber,
  );
  if (result === 'tx_conflict') {
    logger.debug({ txHash, orderId: order.id }, 'Transfer already recorded — skipping');
    return;
  }
  if (result === 'not_pending') {
    await unmatched('order_left_pending');
    return;
  }

  await hooks.releasePendingAddress(toAddress);
  logger.info({ orderId: order.id, txHash, amount, tail }, 'Payment detected (static address)');
}

interface UnmatchedInput {
  merchantId: string | null;
  txHash: string;
  address: string;
  amount: string;
  fromAddress: string;
  blockNumber: number;
  txTimestampMs: number | undefined;
  reason: UnmatchedReason;
}

/**
 * Record an inbound transfer that no pending order can be credited with.
 * Idempotent on tx_hash; alerts once per transfer. Recovery is a manual
 * claim through the admin API (see unmatched-transfer-claims.ts).
 */
async function recordUnmatched(hooks: StaticEngineHooks, input: UnmatchedInput): Promise<void> {
  const db = getDb();

  const inserted = await db
    .insert(unmatchedTransfers)
    .values({
      txHash: input.txHash,
      merchantId: input.merchantId,
      address: input.address,
      amount: input.amount,
      fromAddress: input.fromAddress,
      blockNumber: input.blockNumber,
      blockTimestamp: input.txTimestampMs !== undefined ? new Date(input.txTimestampMs) : null,
      reason: input.reason,
    })
    .onConflictDoNothing()
    .returning({ id: unmatchedTransfers.id });

  if (inserted.length === 0) return; // already recorded (re-scan)

  logger.warn(
    {
      txHash: input.txHash,
      address: input.address,
      amount: input.amount,
      fromAddress: input.fromAddress,
      reason: input.reason,
    },
    'Unmatched payment recorded — manual claim required',
  );

  hooks.notify({
    type: 'unmatched_payment',
    address: input.address,
    txHash: input.txHash,
    amount: input.amount,
  });
}
