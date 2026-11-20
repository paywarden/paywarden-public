import { dispatchWebhookOutbox } from './webhook-outbox.js';
import type { WebhookNotifier } from './webhook-notifier.js';
import type { FundSweeper } from './fund-sweeper.js';
import { logger } from '../utils/logger.js';

export function startRecoveryMonitor(webhook: WebhookNotifier, sweeper: FundSweeper): () => Promise<void> {
  let active: Promise<void> | undefined;
  let stopped = false;
  const tick = () => {
    if (stopped || active) return;
    active = (async () => {
      const outcomes = await Promise.allSettled([
        dispatchWebhookOutbox((id) => webhook.enqueueDelivery(id)), sweeper.recoverPending(),
      ]);
      for (const outcome of outcomes) if (outcome.status === 'rejected') {
        logger.error({ err: outcome.reason }, 'Durable recovery cycle will retry');
      }
    })().finally(() => { active = undefined; });
  };
  const timer = setInterval(() => { void tick(); }, 5_000);
  timer.unref();
  void tick();
  return async () => { stopped = true; clearInterval(timer); await active; };
}
