import { and, eq, inArray, lt } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { getDb } from '../db/index.js';
import { orders, orderEvents } from '../db/schema.js';
import { EVENT_TYPE, ORDER_STATUS, REDIS_KEYS } from '../config/constants.js';
import { logger } from '../utils/logger.js';

export async function expirePendingOrders(redis: Redis | null): Promise<number> {
  const db = getDb();
  const now = new Date();

  const expired = await db
    .select({ id: orders.id, address: orders.address })
    .from(orders)
    .where(and(eq(orders.status, ORDER_STATUS.PENDING), lt(orders.expiresAt, now)));

  if (expired.length === 0) return 0;

  const expiredAddresses: string[] = [];
  let expiredCount = 0;

  await db.transaction(async (tx) => {
    for (const { id, address } of expired) {
      // Re-check status inside the update: the chain watcher may have
      // flipped the order to detected since the select above.
      const [updated] = await tx
        .update(orders)
        .set({ status: ORDER_STATUS.EXPIRED, updatedAt: new Date() })
        .where(and(eq(orders.id, id), eq(orders.status, ORDER_STATUS.PENDING)))
        .returning({ id: orders.id });

      if (!updated) {
        logger.info({ orderId: id }, 'Order left pending before expiry, keeping it');
        continue;
      }

      await tx.insert(orderEvents).values({
        orderId: id,
        eventType: EVENT_TYPE.ORDER_EXPIRED,
        payload: {},
      });

      expiredCount += 1;
      expiredAddresses.push(address);
    }
  });

  // Remove expired addresses from the pending set — unless another pending
  // order still shares the address (static mode). One query for the whole
  // batch, then a single srem.
  if (redis && expiredAddresses.length > 0) {
    const candidates = [...new Set(expiredAddresses)];
    const stillPending = await db
      .selectDistinct({ address: orders.address })
      .from(orders)
      .where(and(inArray(orders.address, candidates), eq(orders.status, ORDER_STATUS.PENDING)));
    const keep = new Set(stillPending.map((r) => r.address));
    const release = candidates.filter((a) => !keep.has(a));
    if (release.length > 0) {
      await redis.srem(REDIS_KEYS.PENDING_ADDRESSES, ...release);
    }
  }

  if (expiredCount > 0) {
    logger.info({ count: expiredCount }, 'Expired orders processed');
  }
  return expiredCount;
}
