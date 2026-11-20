import { and, eq, isNull } from 'drizzle-orm';
import { Decimal } from 'decimal.js';
import { getDb } from '../db/index.js';
import { orders, orderEvents, unmatchedTransfers } from '../db/schema.js';
import { ORDER_STATUS, EVENT_TYPE } from '../config/constants.js';
import { logger } from '../utils/logger.js';
import { CreditAbort } from './credit-result.js';
import type { StaticEngineHooks } from './static-payment-matcher.js';

export interface ClaimUnmatchedOptions {
  /** Operator identity recorded on the claim (audit). */
  claimedBy: string;
  /** Skip the 10% amount-difference guard. */
  force?: boolean;
}

const CLAIM_AMOUNT_TOLERANCE = new Decimal('0.10');

/**
 * Operator links an unmatched transfer to a pending order. One transaction:
 * the guarded claim UPDATE (claimed_order_id IS NULL) is the lock — a
 * concurrent or repeated claim gets ALREADY_CLAIMED and nothing else is
 * written. The credit then goes through the same detected → confirmed path
 * as an automatic match, plus a payment_claimed audit event.
 */
export async function claimUnmatchedTransfer(
  hooks: StaticEngineHooks,
  unmatchedId: string,
  orderId: string,
  options: ClaimUnmatchedOptions,
): Promise<void> {
  const db = getDb();

  // Pre-checks give precise error codes; the transaction below is what
  // actually protects against double claims and races.
  const [row] = await db
    .select()
    .from(unmatchedTransfers)
    .where(eq(unmatchedTransfers.id, unmatchedId));
  if (!row) {
    throw Object.assign(new Error('Unmatched transfer not found'), { code: 'NOT_FOUND' });
  }
  if (row.claimedOrderId) {
    throw Object.assign(new Error('Transfer already claimed'), { code: 'ALREADY_CLAIMED' });
  }

  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) {
    throw Object.assign(new Error('Order not found'), { code: 'NOT_FOUND' });
  }
  if (order.status !== ORDER_STATUS.PENDING) {
    throw Object.assign(new Error('Order is not pending'), { code: 'INVALID_STATE' });
  }
  if (order.address !== row.address || (row.merchantId && order.merchantId !== row.merchantId)) {
    throw Object.assign(new Error('Transfer address does not belong to this order'), {
      code: 'ADDRESS_MISMATCH',
    });
  }

  const payable = new Decimal(order.amountPayable ?? order.amountExpected);
  const diffRatio = new Decimal(row.amount).minus(payable).abs().div(payable);
  if (diffRatio.gt(CLAIM_AMOUNT_TOLERANCE) && !options.force) {
    throw Object.assign(
      new Error('Transfer amount differs from the order by more than 10% — pass force to override'),
      { code: 'AMOUNT_MISMATCH' },
    );
  }

  await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(unmatchedTransfers)
      .set({ claimedOrderId: order.id, claimedBy: options.claimedBy, claimedAt: new Date() })
      .where(and(eq(unmatchedTransfers.id, unmatchedId), isNull(unmatchedTransfers.claimedOrderId)))
      .returning({ id: unmatchedTransfers.id });
    if (!claimed) {
      throw Object.assign(new Error('Transfer already claimed'), { code: 'ALREADY_CLAIMED' });
    }

    try {
      await hooks.creditWithin(
        tx,
        order,
        row.txHash,
        row.address,
        row.amount,
        row.fromAddress,
        row.blockNumber,
      );
    } catch (err) {
      if (err instanceof CreditAbort) {
        const message =
          err.result === 'tx_conflict'
            ? 'Transfer is already credited to an order'
            : 'Order left pending before the claim was applied';
        throw Object.assign(new Error(message), { code: 'INVALID_STATE' });
      }
      throw err;
    }

    await tx.insert(orderEvents).values({
      orderId: order.id,
      eventType: EVENT_TYPE.PAYMENT_CLAIMED,
      payload: {
        unmatched_id: unmatchedId,
        tx_hash: row.txHash,
        amount: row.amount,
        from_address: row.fromAddress,
        claimed_by: options.claimedBy,
        forced: options.force === true,
      },
    });
  });

  await hooks.releasePendingAddress(order.address);
  logger.info(
    { orderId: order.id, txHash: row.txHash, claimedBy: options.claimedBy },
    'Unmatched payment claimed',
  );
}
