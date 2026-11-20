import { Decimal } from 'decimal.js';
import { ORDER_STATUS } from '../config/constants.js';

interface PaymentAmounts {
  amountReceived: string;
  amountExpected: string;
  amountPayable?: string | null;
  paymentStatus?: string | null;
}

/** Payment fact, independent of webhook workflow; also protects legacy rows. */
export function getPaymentStatus(order: PaymentAmounts & { status: string }): string | null {
  if (!['confirmed', 'underpaid', 'overpaid', 'completed', 'callback_sent', 'callback_failed'].includes(order.status)) return null;
  if (['confirmed', 'underpaid', 'overpaid'].includes(order.paymentStatus ?? '')) return order.paymentStatus!;
  return derivePaymentStatus(order);
}

interface RetryablePayment extends PaymentAmounts {
  status: string;
  callbackUrl: string;
}

/**
 * Centralized eligibility + payment-status helpers used by OrderEngine,
 * webhook-notifier, and admin recovery routes.
 *
 * Why a separate module: these decisions used to be inlined in OrderEngine
 * (and the `retrySweep` check was hard-coded to `=== COMPLETED`). That made
 * the resolution of B001 — "confirmed/callback_failed funds get stuck" —
 * impossible to apply consistently across the call sites. Putting the rules
 * here means there is exactly one definition of "this order can be swept"
 * and one of "this order is in a terminal payment state", and adding new
 * statuses doesn't require chasing scattered comparisons.
 */

const TOLERANCE = new Decimal('0.01');

/**
 * Project a payment-confirmed order to one of confirmed/underpaid/overpaid
 * based on amount_received vs the amount the payer was asked to send. That
 * is amount_payable in static-address mode (expected + tail) and
 * amount_expected otherwise. USDT precision is 6 decimal places; we accept
 * a 0.01 tolerance for "essentially equal".
 */
export function derivePaymentStatus(
  order: PaymentAmounts,
): typeof ORDER_STATUS.CONFIRMED | typeof ORDER_STATUS.UNDERPAID | typeof ORDER_STATUS.OVERPAID {
  const received = new Decimal(order.amountReceived);
  const expected = new Decimal(order.amountPayable ?? order.amountExpected);
  const diff = received.minus(expected).abs();

  if (diff.lte(TOLERANCE)) return ORDER_STATUS.CONFIRMED;
  if (received.lt(expected)) return ORDER_STATUS.UNDERPAID;
  return ORDER_STATUS.OVERPAID;
}

/**
 * Statuses for which sweeping the derived address is safe and meaningful.
 *
 * Historically this was `=== COMPLETED` only, which created B001: a webhook
 * delivery failure (or merchant outage) tombstoned the order at
 * `callback_failed` and admin had no way to recover the funds without
 * direct SQL. Sweeping is purely an on-chain operation against the
 * derived address, so any state where the chain has confirmed receipt is
 * legitimately sweepable; webhook delivery is an orthogonal concern.
 */
const SWEEP_ELIGIBLE_STATUSES: ReadonlySet<string> = new Set([
  ORDER_STATUS.CONFIRMED,
  ORDER_STATUS.UNDERPAID,
  ORDER_STATUS.OVERPAID,
  ORDER_STATUS.CALLBACK_FAILED,
  ORDER_STATUS.COMPLETED,
]);

export function isSweepEligibleStatus(status: string): boolean {
  return SWEEP_ELIGIBLE_STATUSES.has(status);
}

/**
 * Statuses for which a manual webhook retry is meaningful. `pending` and
 * `detected` are excluded because no `payment.*` event has been generated
 * yet; `expired` and `completed` are excluded because retrying would
 * either re-deliver a stale event or duplicate a successful one.
 */
const WEBHOOK_RETRY_ELIGIBLE_STATUSES: ReadonlySet<string> = new Set([
  ORDER_STATUS.CONFIRMED,
  ORDER_STATUS.UNDERPAID,
  ORDER_STATUS.OVERPAID,
  ORDER_STATUS.CALLBACK_FAILED,
]);

export function isWebhookRetryEligibleStatus(status: string): boolean {
  return WEBHOOK_RETRY_ELIGIBLE_STATUSES.has(status);
}

/**
 * Build the transient order copy that retryWebhook hands to the notifier.
 *
 * For callback_failed orders the recorded status is no longer one of the
 * payment.* values, so the event name has to be recomputed from amounts.
 * The webhook body's `status` field MUST match the event name — otherwise
 * a retry on a callback_failed order would ship `event=payment.confirmed`
 * alongside `status=callback_failed`, which is internally inconsistent and
 * very likely to confuse signature-verified branching on the merchant side.
 *
 * Extracted into a pure helper so the consistency invariant is unit-testable
 * without spinning up the DB or mocking the BullMQ queue.
 */
export interface RetryWebhookContext<
  T extends RetryablePayment,
> {
  /** Event name to publish, e.g. `payment.confirmed`. */
  eventName: string;
  /** Order copy to hand to the notifier — status & callbackUrl already patched. */
  orderForNotify: T;
}

export function buildRetryWebhookContext<
  T extends RetryablePayment,
>(order: T, callbackUrlOverride?: string): RetryWebhookContext<T> {
  const paymentStatus =
    order.status === ORDER_STATUS.CALLBACK_FAILED ? getPaymentStatus(order)! : order.status;
  return {
    eventName: `payment.${paymentStatus}`,
    orderForNotify: {
      ...order,
      status: paymentStatus,
      callbackUrl: callbackUrlOverride ?? order.callbackUrl,
    },
  };
}
