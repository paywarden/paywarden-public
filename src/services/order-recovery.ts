import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { orders, orderEvents, webhookDeliveries } from '../db/schema.js';
import { EVENT_TYPE, ORDER_STATUS } from '../config/constants.js';
import { logger } from '../utils/logger.js';
import { retryWebhookIntent } from './webhook-outbox.js';
import {
  buildRetryWebhookContext,
  getPaymentStatus,
  isSweepEligibleStatus,
  isWebhookRetryEligibleStatus,
} from '../utils/order-recovery.js';
import type {
  WebhookNotifier,
  WebhookDeliveryContext,
  WebhookFailureContext,
} from './webhook-notifier.js';
import type { FundSweeper } from './fund-sweeper.js';
import type { Notifier } from './notifier.js';

export interface RetryWebhookOptions {
  /**
   * One-shot override for the order's stored callback_url. Used when the
   * merchant's original endpoint is dead but admin needs to redirect the
   * webhook to a sandbox/forwarder without mutating the order row.
   * The override is recorded in the order_events payload for audit (Iron
   * Rule #4) but never persisted on the order itself.
   */
  callbackUrl?: string;
}

export class OrderRecovery {
  private notifier: Notifier | null = null;

  constructor(
    private readonly webhook: WebhookNotifier,
    private readonly sweeper: FundSweeper,
  ) {}

  setNotifier(notifier: Notifier): void {
    this.notifier = notifier;
  }

  async markWebhookCompleted(orderId: string, details: WebhookDeliveryContext): Promise<void> {
    await getDb().transaction(async (tx) => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
      if (!order || !isSweepEligibleStatus(order.status)) return;
      const [delivery] = await tx.select().from(webhookDeliveries)
        .where(eq(webhookDeliveries.orderId, orderId)).for('update');
      if (delivery?.status === 'delivered') return;
      if (delivery && (details.callbackUrl !== delivery.callbackUrl ||
          (details.deliveryGeneration ?? 0) !== delivery.generation)) return;
      const paymentStatus = getPaymentStatus(order)!;
      await tx.update(orders).set({
        status: paymentStatus === ORDER_STATUS.CONFIRMED ? ORDER_STATUS.COMPLETED : paymentStatus,
        paymentStatus, updatedAt: new Date(),
      }).where(eq(orders.id, orderId));
      await tx.insert(orderEvents).values({ orderId, eventType: EVENT_TYPE.WEBHOOK_SENT, payload: details });
      if (delivery) await tx.update(webhookDeliveries).set({
        status: 'delivered', receipt: details, leaseToken: null, leaseUntil: null,
        lastError: null, updatedAt: new Date(),
      }).where(eq(webhookDeliveries.id, delivery.id));
    });
    try { await this.sweeper.queueSweep(orderId); }
    catch (err) { logger.error({ err, orderId }, 'Sweep enqueue deferred to durable recovery'); }
  }

  async markWebhookFailed(orderId: string, details?: WebhookFailureContext): Promise<void> {
    const changed = await getDb().transaction(async (tx) => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
      if (!order || !isWebhookRetryEligibleStatus(order.status)) return false;
      const [delivery] = await tx.select().from(webhookDeliveries)
        .where(eq(webhookDeliveries.orderId, orderId)).for('update');
      if (delivery && ['delivered', 'acknowledged', 'failed'].includes(delivery.status)) return false;
      if (delivery && details && (details.callbackUrl !== delivery.callbackUrl ||
          (details.deliveryGeneration ?? 0) !== delivery.generation)) return false;
      const paymentStatus = getPaymentStatus(order)!;
      await tx.update(orders).set({
        status: paymentStatus === ORDER_STATUS.CONFIRMED ? ORDER_STATUS.CALLBACK_FAILED : paymentStatus,
        paymentStatus, updatedAt: new Date(),
      }).where(eq(orders.id, orderId));
      await tx.insert(orderEvents).values({
        orderId, eventType: EVENT_TYPE.WEBHOOK_FAILED,
        payload: {
          reason: details?.reason ?? 'max_attempts_reached', attempt: details?.attempt ?? null,
          previous_status: order.status, callbackUrl: details?.callbackUrl ?? null,
          statusCode: details?.statusCode ?? null, durationMs: details?.durationMs ?? null,
          failedAt: details?.failedAt ?? null, idempotencyKey: details?.idempotencyKey ?? null,
        },
      });
      if (delivery) await tx.update(webhookDeliveries).set({
        status: 'failed', failure: details, leaseToken: null, leaseUntil: null, updatedAt: new Date(),
      }).where(eq(webhookDeliveries.id, delivery.id));
      return true;
    });
    if (!changed) return;
    try { await this.sweeper.queueSweep(orderId); }
    catch (err) { logger.error({ err, orderId }, 'Sweep enqueue deferred to durable recovery'); }
    this.notifier?.notify({ type: 'webhook_failed', orderId })
      .catch((err) => logger.error({ err }, 'Failed to send webhook failure notification'));
  }

  async retryWebhook(orderId: string, options: RetryWebhookOptions = {}): Promise<void> {
    const db = getDb();
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId));

    if (!order) {
      throw Object.assign(new Error('Order not found'), { code: 'NOT_FOUND' });
    }

    if (!isWebhookRetryEligibleStatus(order.status)) {
      throw Object.assign(new Error('Order is not eligible for webhook retry'), {
        code: 'INVALID_STATE',
      });
    }

    // The override is one-shot — buildRetryWebhookContext returns a transient
    // order copy with status & callbackUrl already patched, never persisted.
    const { eventName, orderForNotify } = buildRetryWebhookContext(order, options.callbackUrl);

    // Record admin action in event log (Iron Rule #4). The override URL goes
    // into the payload so audit can tell the difference between "merchant
    // recovered their endpoint" and "admin redirected the webhook".
    await db.insert(orderEvents).values({
      orderId,
      eventType: EVENT_TYPE.ADMIN_WEBHOOK_RETRY,
      payload: {
        previous_status: order.status,
        webhook_event: eventName,
        callback_url_override: options.callbackUrl ?? null,
      },
    });

    await retryWebhookIntent(order, options.callbackUrl);
    await this.webhook.notify(orderForNotify, eventName);
    logger.info(
      {
        orderId,
        paymentStatus: orderForNotify.status,
        callbackUrlOverridden: orderForNotify.callbackUrl !== order.callbackUrl,
      },
      'Webhook retry queued by admin',
    );
  }

  async retrySweep(orderId: string): Promise<void> {
    const db = getDb();
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId));

    if (!order) {
      throw Object.assign(new Error('Order not found'), { code: 'NOT_FOUND' });
    }

    if (!isSweepEligibleStatus(order.status)) {
      throw Object.assign(new Error('Order is not eligible for sweep retry'), {
        code: 'INVALID_STATE',
      });
    }

    if (!this.sweeper.isSweepEnabled()) {
      throw Object.assign(new Error('Sweep is not enabled'), { code: 'SWEEP_DISABLED' });
    }

    // Record admin action in event log (Iron Rule #4). previous_status lets
    // audit distinguish "force-sweep on a callback_failed order" from a
    // routine completed-state retry.
    await db.insert(orderEvents).values({
      orderId,
      eventType: EVENT_TYPE.ADMIN_SWEEP_RETRY,
      payload: { address: order.address, previous_status: order.status },
    });

    await this.sweeper.queueSweep(orderId, { retry: true });
    logger.info({ orderId }, 'Sweep retry queued by admin');
  }
}
