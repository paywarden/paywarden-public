import { isSweepEligibleStatus, isWebhookRetryEligibleStatus } from './order-recovery.js';

interface DeliveryState { status: string; leaseUntil: Date | null }
interface SweepState { status: string; nextAttemptAt: Date }

export function getAdminRecovery(status: string, sweepEnabled: boolean, delivery?: DeliveryState, sweep?: SweepState) {
  return {
    webhook: {
      status: delivery?.status ?? null,
      can_retry: isWebhookRetryEligibleStatus(status) && !!delivery &&
        ['failed', 'legacy_review'].includes(delivery.status) &&
        (!delivery.leaseUntil || delivery.leaseUntil.getTime() <= Date.now()),
    },
    sweep: {
      status: sweep?.status ?? null,
      can_retry: sweepEnabled && isSweepEligibleStatus(status) && !!sweep &&
        (sweep.status === 'failed' || (['pending', 'prepared', 'broadcast', 'unknown'].includes(sweep.status) &&
          sweep.nextAttemptAt.getTime() <= Date.now())),
    },
  };
}
