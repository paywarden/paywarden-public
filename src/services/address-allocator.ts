import { and, asc, eq, gt, or, sql } from 'drizzle-orm';
import type { Tx } from '../db/index.js';
import { merchantAddresses, orders } from '../db/schema.js';
import { ADDRESS_ROLE, ADDRESS_STATUS, ORDER_STATUS } from '../config/constants.js';
import { applyTail, isStaticAmountValid, pickFreeTail } from '../utils/tail.js';

/**
 * Static-address allocation (ADDRESS_MODE=static).
 *
 * Picks one of the merchant's active addresses and a tail that no other
 * order on that address is using. Runs inside the createOrder transaction;
 * the per-address advisory lock serialises concurrent creates on the same
 * address so two orders cannot pick the same tail. The partial unique index
 * orders_pending_address_tail_uq is the structural backstop.
 */

export interface StaticAllocation {
  address: string;
  tail: string;
  amountPayable: string;
}

/**
 * A tail stays reserved for this long after its order leaves `pending`.
 * Payers double-pay and exchanges re-send; if the tail were reused at once,
 * a second transfer for order A would be credited to order B. 9999 tails
 * per address make the hold essentially free.
 */
export const TAIL_HOLD_MS = 24 * 60 * 60 * 1000;

export async function allocateStaticAddress(
  tx: Tx,
  merchantId: string,
  amountExpected: string,
): Promise<StaticAllocation> {
  if (!isStaticAmountValid(amountExpected)) {
    throw Object.assign(
      new Error('amount may have at most 2 decimal places in static-address mode'),
      { code: 'INVALID_AMOUNT' },
    );
  }

  const active = await tx
    .select({ address: merchantAddresses.address, role: merchantAddresses.role })
    .from(merchantAddresses)
    .where(
      and(
        eq(merchantAddresses.merchantId, merchantId),
        eq(merchantAddresses.status, ADDRESS_STATUS.ACTIVE),
      ),
    )
    .orderBy(
      sql`CASE ${merchantAddresses.role} WHEN ${ADDRESS_ROLE.DEFAULT} THEN 0 ELSE 1 END`,
      asc(merchantAddresses.createdAt),
    );

  // Backup addresses only take orders when no default/sub address is active
  // (e.g. the merchant disabled a frozen default). Switching is otherwise a
  // manual decision — see cloud-watch-only.html §11.
  const primary = active.filter((a) => a.role !== ADDRESS_ROLE.BACKUP);
  const candidates = primary.length > 0 ? primary : active;

  if (candidates.length === 0) {
    throw Object.assign(new Error('Merchant has no active receiving address'), {
      code: 'NO_ADDRESSES',
    });
  }

  const holdSince = new Date(Date.now() - TAIL_HOLD_MS);

  for (const { address } of candidates) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${address}))`);

    const usedRows = await tx
      .select({ tail: orders.tail })
      .from(orders)
      .where(
        and(
          eq(orders.address, address),
          or(eq(orders.status, ORDER_STATUS.PENDING), gt(orders.updatedAt, holdSince)),
        ),
      );

    const used = new Set<string>();
    for (const row of usedRows) if (row.tail) used.add(row.tail);

    const tail = pickFreeTail(used);
    if (tail === null) continue; // saturated — try the next address

    return { address, tail, amountPayable: applyTail(amountExpected, tail) };
  }

  throw Object.assign(new Error('All receiving addresses are saturated with pending orders'), {
    code: 'NO_ADDRESSES',
  });
}
