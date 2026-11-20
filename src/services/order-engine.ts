import { eq, and, desc, isNotNull, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { getDb } from '../db/index.js';
import { orders } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import { ORDER_STATUS, REDIS_KEYS } from '../config/constants.js';
import { env } from '../config/env.js';
import { detectStaticPayment, type StaticEngineHooks } from './static-payment-matcher.js';
import { claimUnmatchedTransfer, type ClaimUnmatchedOptions } from './unmatched-transfer-claims.js';
import { createOrder, type CreateOrderInput, type CreateOrderResult } from './order-creator.js';
import {
  creditDetectedPayment,
  creditWithin,
  recordLatePayment,
  confirmPayment,
} from './payment-credit.js';
import { expirePendingOrders } from './order-expiry.js';
import { OrderRecovery, type RetryWebhookOptions } from './order-recovery.js';
import type { WalletService } from './wallet.js';
import type {
  WebhookDeliveryContext,
  WebhookFailureContext,
  WebhookNotifier,
} from './webhook-notifier.js';
import type { FundSweeper } from './fund-sweeper.js';
import type { Notifier } from './notifier.js';

export type { CreateOrderInput, CreateOrderResult, ClaimUnmatchedOptions, RetryWebhookOptions };

export class OrderEngine {
  private redis: Redis | null = null;
  private notifier: Notifier | null = null;
  private readonly recovery: OrderRecovery;

  constructor(
    private readonly wallet: WalletService,
    private readonly webhook: WebhookNotifier,
    sweeper: FundSweeper,
  ) {
    this.recovery = new OrderRecovery(webhook, sweeper);
  }

  setRedis(redis: Redis): void {
    this.redis = redis;
  }

  setNotifier(notifier: Notifier): void {
    this.notifier = notifier;
    this.recovery.setNotifier(notifier);
  }

  async createOrder(params: CreateOrderInput): Promise<CreateOrderResult> {
    return createOrder(this.wallet, this.redis, params);
  }

  async onPaymentDetected(
    txHash: string,
    toAddress: string,
    amount: string,
    fromAddress: string,
    blockNumber: number,
    txTimestampMs?: number,
  ): Promise<void> {
    if (env.ADDRESS_MODE === 'static') {
      await detectStaticPayment(
        this.staticHooks(),
        txHash,
        toAddress,
        amount,
        fromAddress,
        blockNumber,
        txTimestampMs,
      );
      return;
    }

    const db = getDb();

    const [order, priorOrder] = await db
      .select()
      .from(orders)
      .where(and(eq(orders.address, toAddress), isNotNull(orders.derivationIdx)))
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(2);

    if (!order) {
      logger.debug({ toAddress, txHash }, 'No HD order for address, skipping');
      return;
    }

    if (order.txHash === txHash || priorOrder?.txHash === txHash) return;

    // A historically reused address can have multiple possible orders.
    // Keep the transaction unassigned and attach an audit event for review.
    if (priorOrder) {
      await recordLatePayment(
        this.notifier,
        order.id,
        txHash,
        toAddress,
        amount,
        fromAddress,
        blockNumber,
        { reason: 'reused_address', prior_order_id: priorOrder.id },
        null,
      );
      return;
    }

    if (txTimestampMs !== undefined && txTimestampMs < order.createdAt.getTime()) {
      await recordLatePayment(
        this.notifier,
        order.id,
        txHash,
        toAddress,
        amount,
        fromAddress,
        blockNumber,
        {
          reason: 'predates_order',
          tx_timestamp_ms: txTimestampMs,
        },
      );
      return;
    }

    if (order.status !== ORDER_STATUS.PENDING) {
      await recordLatePayment(
        this.notifier,
        order.id,
        txHash,
        toAddress,
        amount,
        fromAddress,
        blockNumber,
        {
          reason: 'order_not_pending',
        },
      );
      return;
    }

    const result = await creditDetectedPayment(
      order,
      txHash,
      toAddress,
      amount,
      fromAddress,
      blockNumber,
    );

    if (result === 'tx_conflict') {
      // Already recorded (credited elsewhere, late payment, or re-scan).
      // Refusing here keeps one transfer from ever flipping two orders.
      logger.debug({ txHash, orderId: order.id }, 'Transfer already recorded — skipping');
      return;
    }

    if (result === 'not_pending') {
      // The expiry sweep won the race: the payment is real but the order is
      // no longer pending. Don't drop the tx on the floor — record it so the
      // funds are traceable and manually recoverable.
      await recordLatePayment(
        this.notifier,
        order.id,
        txHash,
        toAddress,
        amount,
        fromAddress,
        blockNumber,
        {
          reason: 'order_left_pending',
        },
      );
      return;
    }

    // Remove from pending set — address no longer waiting for payment
    await this.releasePendingAddress(toAddress);

    logger.info({ orderId: order.id, txHash, amount }, 'Payment detected');
  }

  /** Primitives the static-address matcher borrows from the engine. */
  private staticHooks(): StaticEngineHooks {
    return {
      creditDetectedPayment,
      creditWithin,
      releasePendingAddress: (address) => this.releasePendingAddress(address),
      notify: (event) => {
        this.notifier
          ?.notify(event)
          .catch((err) => logger.error({ err, type: event.type }, 'Failed to send notification'));
      },
    };
  }

  /** Static-address mode: operator links an unmatched transfer to a pending order. */
  async claimUnmatched(
    unmatchedId: string,
    orderId: string,
    options: ClaimUnmatchedOptions,
  ): Promise<void> {
    await claimUnmatchedTransfer(this.staticHooks(), unmatchedId, orderId, options);
  }

  /**
   * Drop an address from the block-scan pending set once no pending order
   * is waiting on it. In HD mode that is immediately after detection; in
   * static mode other orders may still share the address.
   */
  private async releasePendingAddress(address: string): Promise<void> {
    if (!this.redis) return;
    const db = getDb();
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(orders)
      .where(and(eq(orders.address, address), eq(orders.status, ORDER_STATUS.PENDING)));
    if (Number(count) === 0) {
      await this.redis.srem(REDIS_KEYS.PENDING_ADDRESSES, address);
    }
  }

  /** Add an address to the block-scan pending set (e.g. a pending_test address awaiting its test transfer). */
  async registerWatchedAddress(address: string): Promise<void> {
    await this.redis?.sadd(REDIS_KEYS.PENDING_ADDRESSES, address);
  }

  async onPaymentConfirmed(txHash: string, confirmations: number, blockNumber: number): Promise<void> {
    const order = await confirmPayment(txHash, confirmations, blockNumber);
    if (order) {
      try { await this.webhook.notify(order, `payment.${order.paymentStatus}`); }
      catch (err) { logger.error({ err, orderId: order.id }, 'Webhook enqueue failed; PostgreSQL intent will recover'); }
    }
  }

  async markWebhookCompleted(orderId: string, details: WebhookDeliveryContext): Promise<void> {
    return this.recovery.markWebhookCompleted(orderId, details);
  }

  async markWebhookFailed(orderId: string, details?: WebhookFailureContext): Promise<void> {
    return this.recovery.markWebhookFailed(orderId, details);
  }

  /**
   * Ops alert for an order stuck in `detected` (its tx never reaches
   * MIN_CONFIRMATIONS — e.g. reorged out, or seen unconfirmed and dropped).
   * Alert-only: state stays `detected` (forward-only, recovery is a manual
   * call). Deduped via Redis so the 15s confirmation sweep doesn't spam.
   */
  async alertStuckDetected(
    orderId: string,
    txHash: string | null,
    stuckHours: number,
  ): Promise<void> {
    if (this.redis) {
      const key = `${REDIS_KEYS.STUCK_DETECTED_ALERTED}:${orderId}`;
      const first = await this.redis.set(key, '1', 'EX', 6 * 3600, 'NX');
      if (first === null) return; // already alerted within the window
    }

    logger.error(
      { orderId, txHash, stuckHours },
      'Order stuck in detected state — tx not confirming, manual review required',
    );

    this.notifier
      ?.notify({ type: 'stuck_detected', orderId, hours: stuckHours })
      .catch((err) => logger.error({ err }, 'Failed to send stuck-order notification'));
  }

  async retryWebhook(orderId: string, options: RetryWebhookOptions = {}): Promise<void> {
    return this.recovery.retryWebhook(orderId, options);
  }

  async retrySweep(orderId: string): Promise<void> {
    return this.recovery.retrySweep(orderId);
  }

  async processExpiredOrders(): Promise<number> {
    return expirePendingOrders(this.redis);
  }
}
