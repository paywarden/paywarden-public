import { Queue, Worker, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import { getDb } from '../db/index.js';
import { webhookDeliveries, type Order } from '../db/schema.js';
import { processDurableWebhook, type DurableWebhookData } from './durable-webhook.js';
import type { WebhookDeliveryContext, WebhookFailureContext } from '../types/payment.js';
export type { WebhookPayload, WebhookDeliveryContext, WebhookFailureContext } from '../types/payment.js';

const QUEUE_NAME = 'webhooks';

let queue: Queue | null = null;
let worker: Worker | null = null;
let onWebhookSuccess: ((orderId: string, context: WebhookDeliveryContext) => Promise<void>) | null = null;
let onWebhookFailed: ((orderId: string, context: WebhookFailureContext) => Promise<void>) | null = null;

export function initWebhookWorker(
  redisUrl: string,
  successCb: (orderId: string, context: WebhookDeliveryContext) => Promise<void>,
  failedCb: (orderId: string, context: WebhookFailureContext) => Promise<void>,
): void {
  onWebhookSuccess = successCb;
  onWebhookFailed = failedCb;

  queue = new Queue(QUEUE_NAME, {
    connection: { url: redisUrl },
    defaultJobOptions: { removeOnComplete: 100, removeOnFail: 200 },
  });

  worker = new Worker(QUEUE_NAME, (job: Job) => {
    if (!job.data.deliveryId) {
      // Pre-outbox jobs have no durable delivery identity or reliable HTTP ack.
      // Migration 0008 reconciles them; a Redis payload cannot authorize delivery.
      logger.warn({ jobId: job.id, orderId: job.data.orderId }, 'Legacy webhook job quarantined; reconcile durable delivery state');
      return Promise.resolve();
    }
    return processDurableWebhook(job as Job<DurableWebhookData>, onWebhookSuccess!, onWebhookFailed!);
  }, {
    connection: { url: redisUrl },
    concurrency: 5,
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Webhook job failed permanently');
  });

  logger.info('Webhook worker started');
}

export class WebhookNotifier {
  async enqueueDelivery(id: string): Promise<void> {
    if (!queue) throw new Error('Webhook worker not initialized');
    const [delivery] = await getDb().select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id));
    if (!delivery) throw new Error('Missing durable webhook intent');
    const jobId = 'delivery-' + id;
    const existing = await queue.getJob(jobId);
    let ack: WebhookDeliveryContext | undefined;
    if (existing) {
      const state = await existing.getState();
      if (!['completed', 'failed', 'unknown'].includes(state)) return;
      ack = (existing.data as Partial<DurableWebhookData>).ack;
      if (ack && (ack.callbackUrl !== delivery.callbackUrl ||
          (ack.deliveryGeneration ?? 0) !== delivery.generation || ack.idempotencyKey !== `evt_${id}`)) ack = undefined;
      await existing.remove();
    }
    await queue.add(QUEUE_NAME, { deliveryId: id, ...(ack ? { ack } : {}) }, {
      jobId, removeOnComplete: true, removeOnFail: false,
    });
  }

  async notify(order: Order, _eventType: string): Promise<void> {
    const [delivery] = await getDb().select().from(webhookDeliveries)
      .where(eq(webhookDeliveries.orderId, order.id));
    if (!delivery) throw new Error('Missing durable webhook intent');
    if (['pending', 'acknowledged', 'failure_pending'].includes(delivery.status)) {
      await this.enqueueDelivery(delivery.id);
    }
  }
}

export async function closeWebhookWorker(): Promise<void> {
  await worker?.close();
  await queue?.close();
  worker = null; queue = null;
}
