import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { getDb } from '../db/index.js';
import { orders, addresses, orderEvents } from '../db/schema.js';
import type { Order } from '../db/schema.js';
import { env } from '../config/env.js';
import {
  ADDRESS_POOL_MIN,
  ADDRESS_POOL_REFILL,
  EVENT_TYPE,
  REDIS_KEYS,
} from '../config/constants.js';
import { logger } from '../utils/logger.js';
import {
  isCreateOrderReplayCompatible,
  normalizeOrderAmount,
  normalizeOrderCurrency,
} from '../utils/order-create.js';
import { allocateStaticAddress } from './address-allocator.js';
import type { WalletService } from './wallet.js';

export interface CreateOrderInput {
  externalId: string;
  amount: string;
  currency?: string;
  callbackUrl: string;
  ttl?: number;
  merchantId: string;
  webhookSecret: string;
}

export interface CreateOrderResult {
  order: Order;
  reused: boolean;
}

export async function createOrder(
  wallet: WalletService,
  redis: Redis | null,
  params: CreateOrderInput,
): Promise<CreateOrderResult> {
  const db = getDb();
  const ttl = params.ttl ?? env.ORDER_TTL;
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const amountExpected = normalizeOrderAmount(params.amount);
  const currency = normalizeOrderCurrency(params.currency);

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${params.merchantId}), hashtext(${params.externalId}))`,
    );

    const [existingOrder] = await tx
      .select()
      .from(orders)
      .where(
        and(eq(orders.merchantId, params.merchantId), eq(orders.externalId, params.externalId)),
      )
      .limit(1);

    if (existingOrder) {
      if (
        !isCreateOrderReplayCompatible(existingOrder, {
          amount: params.amount,
          currency,
          callbackUrl: params.callbackUrl,
        })
      ) {
        throw Object.assign(new Error('external_id already exists with different parameters'), {
          code: 'EXTERNAL_ID_CONFLICT',
        });
      }

      logger.info(
        { orderId: existingOrder.id, merchantId: params.merchantId, externalId: params.externalId },
        'Returning existing order for duplicate create request',
      );

      return { order: existingOrder, reused: true };
    }

    // Pick the receiving address. Static mode: one of the merchant's own
    // addresses plus an amount tail (no key material on the server). HD
    // mode: a fresh derived address from the pool.
    let allocation: {
      address: string;
      derivationIdx: number | null;
      tail: string | null;
      amountPayable: string | null;
    };
    let hdAddressId: string | null = null;

    if (env.ADDRESS_MODE === 'static') {
      const s = await allocateStaticAddress(tx, params.merchantId, amountExpected);
      allocation = {
        address: s.address,
        derivationIdx: null,
        tail: s.tail,
        amountPayable: s.amountPayable,
      };
    } else {
      // Ensure address pool is healthy
      const freeCount = await tx
        .select({ count: sql<number>`count(*)` })
        .from(addresses)
        .where(and(eq(addresses.isAllocated, false), isNull(addresses.allocatedTo)))
        .then((r) => Number(r[0].count));

      if (freeCount < ADDRESS_POOL_MIN) {
        const maxIdx = await tx
          .select({ max: sql<number>`coalesce(max(derivation_idx), -1)` })
          .from(addresses)
          .then((r) => Number(r[0].max));

        const newAddrs = await wallet.deriveAddresses(maxIdx + 1, ADDRESS_POOL_REFILL);
        await tx
          .insert(addresses)
          .values(newAddrs.map((a) => ({ address: a.address, derivationIdx: a.index })))
          .onConflictDoNothing();

        logger.info({ count: newAddrs.length }, 'Address pool refilled');
      }

      // Allocate address (FOR UPDATE prevents concurrent allocation)
      const [addr] = await tx
        .select()
        .from(addresses)
        .where(and(eq(addresses.isAllocated, false), isNull(addresses.allocatedTo)))
        .limit(1)
        .for('update', { skipLocked: true });

      if (!addr) {
        throw Object.assign(new Error('No available addresses'), { code: 'NO_ADDRESSES' });
      }

      allocation = {
        address: addr.address,
        derivationIdx: addr.derivationIdx,
        tail: null,
        amountPayable: null,
      };
      hdAddressId = addr.id;
    }

    // Insert order
    const [order] = await tx
      .insert(orders)
      .values({
        externalId: params.externalId,
        merchantId: params.merchantId,
        address: allocation.address,
        derivationIdx: allocation.derivationIdx,
        tail: allocation.tail,
        amountPayable: allocation.amountPayable,
        amountExpected,
        currency,
        callbackUrl: params.callbackUrl,
        webhookSecret: params.webhookSecret,
        expiresAt,
      })
      .returning();

    // Mark address allocated (HD pool only)
    if (hdAddressId) {
      await tx
        .update(addresses)
        .set({ isAllocated: true, allocatedTo: order.id })
        .where(eq(addresses.id, hdAddressId));
    }

    // Record event
    await tx.insert(orderEvents).values({
      orderId: order.id,
      eventType: EVENT_TYPE.ORDER_CREATED,
      payload: {
        amount: amountExpected,
        externalId: params.externalId,
        address: order.address,
        // Static mode only; null in HD mode. Lets the event stream project
        // the exact amount the payer was asked for (Iron Rule 4).
        tail: order.tail,
        amount_payable: order.amountPayable,
      },
    });

    logger.info({ orderId: order.id, address: order.address }, 'Order created');

    // Keep Redis pending_addresses Set in sync (used by block scan mode)
    await redis?.sadd(REDIS_KEYS.PENDING_ADDRESSES, order.address);

    return { order, reused: false };
  });
}
