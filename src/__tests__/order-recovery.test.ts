import { describe, it, expect } from 'vitest';
import {
  buildRetryWebhookContext,
  derivePaymentStatus,
  isSweepEligibleStatus,
  isWebhookRetryEligibleStatus,
} from '../utils/order-recovery.js';
import { ORDER_STATUS } from '../config/constants.js';

/**
 * B001 regression coverage. The bug was that retrySweep hard-coded
 * `status === COMPLETED`, so any order that got stuck at confirmed or
 * callback_failed (e.g. dead webhook endpoint) had its on-chain funds
 * locked in the derived address with no recovery path. These tests pin
 * the eligibility set so a future refactor can't silently re-introduce
 * the same trap.
 */

describe('derivePaymentStatus (static-address mode: compares against amount_payable)', () => {
  it('exact payable match → confirmed even though it differs from amount_expected', () => {
    expect(
      derivePaymentStatus({
        amountReceived: '100.001370',
        amountExpected: '100.000000',
        amountPayable: '100.001370',
      }),
    ).toBe(ORDER_STATUS.CONFIRMED);
  });

  it('exchange fee deducted from payable → underpaid', () => {
    expect(
      derivePaymentStatus({
        amountReceived: '99.001370',
        amountExpected: '100.000000',
        amountPayable: '100.001370',
      }),
    ).toBe(ORDER_STATUS.UNDERPAID);
  });

  it('null amount_payable falls back to amount_expected (HD mode rows)', () => {
    expect(
      derivePaymentStatus({
        amountReceived: '100.000000',
        amountExpected: '100.000000',
        amountPayable: null,
      }),
    ).toBe(ORDER_STATUS.CONFIRMED);
  });
});

describe('derivePaymentStatus', () => {
  it('exact match → confirmed', () => {
    expect(derivePaymentStatus({ amountReceived: '100.000000', amountExpected: '100.000000' })).toBe(
      ORDER_STATUS.CONFIRMED,
    );
  });

  it('within +0.01 tolerance → confirmed', () => {
    expect(derivePaymentStatus({ amountReceived: '100.010000', amountExpected: '100.000000' })).toBe(
      ORDER_STATUS.CONFIRMED,
    );
  });

  it('within -0.01 tolerance → confirmed', () => {
    expect(derivePaymentStatus({ amountReceived: '99.990000', amountExpected: '100.000000' })).toBe(
      ORDER_STATUS.CONFIRMED,
    );
  });

  it('outside tolerance, under → underpaid', () => {
    expect(derivePaymentStatus({ amountReceived: '99.980000', amountExpected: '100.000000' })).toBe(
      ORDER_STATUS.UNDERPAID,
    );
  });

  it('outside tolerance, over → overpaid', () => {
    expect(derivePaymentStatus({ amountReceived: '100.020000', amountExpected: '100.000000' })).toBe(
      ORDER_STATUS.OVERPAID,
    );
  });
});

describe('isSweepEligibleStatus (B001 regression guard)', () => {
  it('completed is eligible', () => {
    expect(isSweepEligibleStatus(ORDER_STATUS.COMPLETED)).toBe(true);
  });

  it('confirmed is eligible — webhook delivery is orthogonal to chain receipt', () => {
    expect(isSweepEligibleStatus(ORDER_STATUS.CONFIRMED)).toBe(true);
  });

  it('callback_failed is eligible — B001: stuck webhook must not lock funds', () => {
    expect(isSweepEligibleStatus(ORDER_STATUS.CALLBACK_FAILED)).toBe(true);
  });

  it('underpaid is eligible — partial payment still has on-chain balance to sweep', () => {
    expect(isSweepEligibleStatus(ORDER_STATUS.UNDERPAID)).toBe(true);
  });

  it('overpaid is eligible', () => {
    expect(isSweepEligibleStatus(ORDER_STATUS.OVERPAID)).toBe(true);
  });

  it('pending is NOT eligible — no funds received yet', () => {
    expect(isSweepEligibleStatus(ORDER_STATUS.PENDING)).toBe(false);
  });

  it('detected is NOT eligible — chain receipt unconfirmed', () => {
    expect(isSweepEligibleStatus(ORDER_STATUS.DETECTED)).toBe(false);
  });

  it('expired is NOT eligible — terminal, no payment occurred', () => {
    expect(isSweepEligibleStatus(ORDER_STATUS.EXPIRED)).toBe(false);
  });

  it('unknown status string is NOT eligible', () => {
    expect(isSweepEligibleStatus('garbage')).toBe(false);
  });
});

describe('isWebhookRetryEligibleStatus', () => {
  it('confirmed → retryable', () => {
    expect(isWebhookRetryEligibleStatus(ORDER_STATUS.CONFIRMED)).toBe(true);
  });

  it('callback_failed → retryable (admin recovery path)', () => {
    expect(isWebhookRetryEligibleStatus(ORDER_STATUS.CALLBACK_FAILED)).toBe(true);
  });

  it('underpaid / overpaid → retryable', () => {
    expect(isWebhookRetryEligibleStatus(ORDER_STATUS.UNDERPAID)).toBe(true);
    expect(isWebhookRetryEligibleStatus(ORDER_STATUS.OVERPAID)).toBe(true);
  });

  it('pending → not retryable (no payment.* event yet)', () => {
    expect(isWebhookRetryEligibleStatus(ORDER_STATUS.PENDING)).toBe(false);
  });

  it('detected → not retryable (no payment.* event yet)', () => {
    expect(isWebhookRetryEligibleStatus(ORDER_STATUS.DETECTED)).toBe(false);
  });

  it('completed → not retryable (would duplicate a successful delivery)', () => {
    expect(isWebhookRetryEligibleStatus(ORDER_STATUS.COMPLETED)).toBe(false);
  });

  it('expired → not retryable', () => {
    expect(isWebhookRetryEligibleStatus(ORDER_STATUS.EXPIRED)).toBe(false);
  });
});

describe('buildRetryWebhookContext (event/payload consistency)', () => {
  // Regression guard for the second B001 follow-up: previously retryWebhook
  // recomputed the event name from amounts but still passed the original
  // order.status into the webhook body, so a retry on a callback_failed
  // order shipped `event=payment.confirmed` alongside `status=callback_failed`.
  // The notifier body's `status` field MUST always match the event name.
  const baseOrder = {
    amountReceived: '100.000000',
    amountExpected: '100.000000',
    status: ORDER_STATUS.CALLBACK_FAILED,
    callbackUrl: 'https://merchant.example/hook',
  };

  it('callback_failed (exact amount) → event and body status are both confirmed', () => {
    const ctx = buildRetryWebhookContext(baseOrder);
    expect(ctx.eventName).toBe('payment.confirmed');
    expect(ctx.orderForNotify.status).toBe(ORDER_STATUS.CONFIRMED);
  });

  it('callback_failed (underpaid) → event and body both report underpaid', () => {
    const ctx = buildRetryWebhookContext({
      ...baseOrder,
      amountReceived: '50.000000',
    });
    expect(ctx.eventName).toBe('payment.underpaid');
    expect(ctx.orderForNotify.status).toBe(ORDER_STATUS.UNDERPAID);
  });

  it('callback_failed (overpaid) → event and body both report overpaid', () => {
    const ctx = buildRetryWebhookContext({
      ...baseOrder,
      amountReceived: '200.000000',
    });
    expect(ctx.eventName).toBe('payment.overpaid');
    expect(ctx.orderForNotify.status).toBe(ORDER_STATUS.OVERPAID);
  });

  it('non-callback_failed (confirmed) → status passes through unchanged', () => {
    const ctx = buildRetryWebhookContext({ ...baseOrder, status: ORDER_STATUS.CONFIRMED });
    expect(ctx.eventName).toBe('payment.confirmed');
    expect(ctx.orderForNotify.status).toBe(ORDER_STATUS.CONFIRMED);
  });

  it('callback_url override is applied to the transient copy only', () => {
    const ctx = buildRetryWebhookContext(baseOrder, 'https://sandbox.example/hook');
    expect(ctx.orderForNotify.callbackUrl).toBe('https://sandbox.example/hook');
    // original input is untouched
    expect(baseOrder.callbackUrl).toBe('https://merchant.example/hook');
  });

  it('no override → original callback_url is preserved', () => {
    const ctx = buildRetryWebhookContext(baseOrder);
    expect(ctx.orderForNotify.callbackUrl).toBe('https://merchant.example/hook');
  });

  it('event name is always payment.<status> (no payment.callback_failed leak)', () => {
    // The whole point: even though input.status = callback_failed, the
    // event name must never be payment.callback_failed.
    const ctx = buildRetryWebhookContext(baseOrder);
    expect(ctx.eventName).not.toBe('payment.callback_failed');
  });
});

describe('buildRetryWebhookContext with amount_payable (static-address mode)', () => {
  it('recomputes the payment status from amount_payable for a callback_failed order', () => {
    const { eventName, orderForNotify } = buildRetryWebhookContext({
      amountReceived: '100.001370',
      amountExpected: '100.000000',
      amountPayable: '100.001370',
      status: ORDER_STATUS.CALLBACK_FAILED,
      callbackUrl: 'https://merchant.example/webhook',
    });
    expect(eventName).toBe('payment.confirmed');
    expect(orderForNotify.status).toBe(ORDER_STATUS.CONFIRMED);
  });
});
