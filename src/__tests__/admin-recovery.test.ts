import { expect, it } from 'vitest';
import { getAdminRecovery } from '../utils/admin-recovery.js';

it.each(['underpaid', 'overpaid', 'confirmed', 'callback_failed'])('offers failed-step recovery independently of %s payment facts', (status) => {
  expect(getAdminRecovery(status, true, { status: 'failed', leaseUntil: null }, { status: 'failed', nextAttemptAt: new Date() }))
    .toEqual({ webhook: { status: 'failed', can_retry: true }, sweep: { status: 'failed', can_retry: true } });
});
it('does not offer callback retry after acknowledgement or settlement retry after success', () => {
  expect(getAdminRecovery('underpaid', true, { status: 'acknowledged', leaseUntil: null },
    { status: 'confirmed', nextAttemptAt: new Date(0) })).toMatchObject({ webhook: { can_retry: false }, sweep: { can_retry: false } });
});
it('respects disabled sweeping, due dates, active webhook leases and manual reconciliation', () => {
  expect(getAdminRecovery('overpaid', false, { status: 'failed', leaseUntil: new Date(Date.now() + 60_000) },
    { status: 'failed', nextAttemptAt: new Date(0) })).toMatchObject({ webhook: { can_retry: false }, sweep: { can_retry: false } });
  expect(getAdminRecovery('overpaid', true, undefined, { status: 'unknown', nextAttemptAt: new Date(Date.now() + 60_000) }).sweep.can_retry).toBe(false);
  expect(getAdminRecovery('overpaid', true, undefined, { status: 'unknown', nextAttemptAt: new Date(0) }).sweep.can_retry).toBe(true);
  expect(getAdminRecovery('overpaid', true, undefined, { status: 'legacy_review', nextAttemptAt: new Date(0) }).sweep.can_retry).toBe(false);
});
