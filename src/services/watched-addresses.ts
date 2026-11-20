import { and, eq, inArray, isNotNull, or } from 'drizzle-orm';
import { ADDRESS_STATUS, ORDER_STATUS } from '../config/constants.js';
import { env } from '../config/env.js';
import { getDb } from '../db/index.js';
import { merchantAddresses, orders } from '../db/schema.js';

// Disabling an activated address stops allocation, not observation of its funds.
function watchedMerchantAddress() {
  return or(
    eq(merchantAddresses.status, ADDRESS_STATUS.PENDING_TEST),
    eq(merchantAddresses.status, ADDRESS_STATUS.ACTIVE),
    isNotNull(merchantAddresses.activatedAt),
  );
}

export async function collectWatchedAddresses(): Promise<Map<string, number>> {
  const db = getDb();
  const watched = new Map<string, number>();
  const add = (address: string, timestamp: number) => {
    watched.set(address, Math.min(watched.get(address) ?? timestamp, timestamp));
  };

  const pending = await db
    .select({ address: orders.address, createdAt: orders.createdAt })
    .from(orders)
    .where(eq(orders.status, ORDER_STATUS.PENDING));
  for (const order of pending) add(order.address, order.createdAt.getTime());

  if (env.ADDRESS_MODE === 'static') {
    const registered = await db
      .select({
        address: merchantAddresses.address,
        confirmedAt: merchantAddresses.confirmedAt,
        createdAt: merchantAddresses.createdAt,
      })
      .from(merchantAddresses)
      .where(watchedMerchantAddress());
    for (const address of registered) {
      add(address.address, (address.confirmedAt ?? address.createdAt).getTime());
    }
  }
  return watched;
}

export async function findWatchedRecipients(recipients: string[]): Promise<Set<string>> {
  if (recipients.length === 0) return new Set();
  const db = getDb();
  const matchingOrders = await db
    .selectDistinct({ address: orders.address })
    .from(orders)
    .where(
      and(
        inArray(orders.address, recipients),
        env.ADDRESS_MODE === 'hd'
          ? isNotNull(orders.derivationIdx)
          : and(isNotNull(orders.tail), eq(orders.status, ORDER_STATUS.PENDING)),
      ),
    );
  const watched = new Set(matchingOrders.map(({ address }) => address));

  if (env.ADDRESS_MODE === 'static') {
    const registered = await db
      .select({ address: merchantAddresses.address })
      .from(merchantAddresses)
      .where(and(inArray(merchantAddresses.address, recipients), watchedMerchantAddress()));
    for (const { address } of registered) watched.add(address);
  }
  return watched;
}
