import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { fetch, Agent } from 'undici';
import type { Job } from 'bullmq';
import { getDb } from '../db/index.js';
import { orders, webhookDeliveries } from '../db/schema.js';
import { env } from '../config/env.js';
import { WEBHOOK_MAX_ATTEMPTS } from '../config/constants.js';
import { hmacSha256 } from '../utils/crypto.js';
import { isCallbackUrlSafe, safeWebhookLookup } from '../utils/url-safety.js';
import { logger } from '../utils/logger.js';
import type { WebhookDeliveryContext, WebhookFailureContext } from '../types/payment.js';

const dispatcher = env.ALLOW_PRIVATE_CALLBACKS ? undefined : new Agent({ connect: { lookup: safeWebhookLookup } });
export interface DurableWebhookData { deliveryId: string; ack?: WebhookDeliveryContext }
type Success = (id: string, context: WebhookDeliveryContext) => Promise<void>;
type Failure = (id: string, context: WebhookFailureContext) => Promise<void>;

export async function processDurableWebhook(job: Job<DurableWebhookData>, success: Success, failed: Failure): Promise<void> {
  const db = getDb();
  const token = randomUUID();
  const [delivery] = await db.update(webhookDeliveries).set({
    leaseToken: token, leaseUntil: new Date(Date.now() + 60_000), updatedAt: new Date(),
  }).where(and(
    eq(webhookDeliveries.id, job.data.deliveryId),
    inArray(webhookDeliveries.status, ['pending', 'acknowledged', 'failure_pending']),
    lte(webhookDeliveries.nextAttemptAt, new Date()),
    or(isNull(webhookDeliveries.leaseUntil), lte(webhookDeliveries.leaseUntil, new Date())),
  )).returning();
  if (!delivery) return;
  const owns = and(eq(webhookDeliveries.id, delivery.id), eq(webhookDeliveries.leaseToken, token));
  const candidate = delivery.receipt ?? job.data.ack;
  let receipt = candidate && candidate.callbackUrl === delivery.callbackUrl &&
    (candidate.deliveryGeneration ?? 0) === delivery.generation &&
    candidate.idempotencyKey === `evt_${delivery.id}` ? candidate : undefined;
  let failure = delivery.failure;
  try {
    if (delivery.status === 'pending' && !receipt) {
      const [order] = await db.select({ secret: orders.webhookSecret }).from(orders).where(eq(orders.id, delivery.orderId));
      if (!order) throw new Error('Webhook order is missing');
      const body = JSON.stringify(delivery.payload);
      const idempotencyKey = `evt_${delivery.id}`;
      const started = Date.now();
      const safety = isCallbackUrlSafe(delivery.callbackUrl, { allowPrivate: env.ALLOW_PRIVATE_CALLBACKS });
      let statusCode: number | null = null;
      let reason: string | null = safety.ok ? null : `unsafe_callback_url:${safety.reason}`;
      let permanent = !safety.ok;
      if (!reason) {
        try {
          const response = await fetch(delivery.callbackUrl, {
            method: 'POST', body, redirect: 'manual', dispatcher,
            signal: AbortSignal.timeout(10_000),
            headers: {
              'Content-Type': 'application/json', 'X-Signature': `sha256=${hmacSha256(body, order.secret)}`,
              'X-Idempotency-Key': idempotencyKey, 'X-Timestamp': String(Math.floor(Date.now() / 1000)),
            },
          });
          statusCode = response.status;
          if (!response.ok) reason = `HTTP ${response.status}`;
          await response.body?.cancel();
        } catch (err) {
          reason = err instanceof Error ? err.message : String(err);
          permanent = (err as { cause?: { code?: string } }).cause?.code === 'UNSAFE_CALLBACK_URL';
        }
      }
      const attempt = delivery.attempt + 1;
      if (!reason) {
        receipt = {
          deliveryGeneration: delivery.generation,
          callbackUrl: delivery.callbackUrl, statusCode: statusCode!, attempt,
          durationMs: Math.max(0, Date.now() - started), deliveredAt: new Date().toISOString(), idempotencyKey,
        };
        // Retain the observed HTTP acknowledgement even if PostgreSQL is down.
        // A lost acknowledgement still uses the SAME key on eventual redelivery.
        try { await job.updateData({ deliveryId: delivery.id, ack: receipt }); }
        catch (err) { logger.warn({ err, deliveryId: delivery.id }, 'Could not mirror webhook acknowledgement to Redis'); }
      } else if (permanent || attempt >= WEBHOOK_MAX_ATTEMPTS) {
        failure = {
          deliveryGeneration: delivery.generation,
          callbackUrl: delivery.callbackUrl, statusCode, attempt,
          durationMs: Math.max(0, Date.now() - started), failedAt: new Date().toISOString(),
          idempotencyKey, reason,
        };
      } else {
        await db.update(webhookDeliveries).set({
          attempt, nextAttemptAt: new Date(Date.now() + Math.min(2 ** attempt * 1000, 3_600_000)),
          leaseToken: null, leaseUntil: null, lastError: reason.slice(0, 2048), updatedAt: new Date(),
        }).where(owns);
        return;
      }
    }
    if (receipt) {
      const saved = await db.update(webhookDeliveries).set({
        status: 'acknowledged', receipt, attempt: receipt.attempt, updatedAt: new Date(),
      }).where(owns).returning({ id: webhookDeliveries.id });
      if (!saved.length) return;
      await success(delivery.orderId, receipt);
    } else if (failure) {
      const saved = await db.update(webhookDeliveries).set({
        status: 'failure_pending', failure, attempt: failure.attempt, updatedAt: new Date(),
      }).where(owns).returning({ id: webhookDeliveries.id });
      if (!saved.length) return;
      await failed(delivery.orderId, failure);
    }
  } finally {
    await db.update(webhookDeliveries).set({ leaseToken: null, leaseUntil: null, updatedAt: new Date() }).where(owns);
  }
}
