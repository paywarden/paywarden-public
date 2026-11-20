import { describe, expect, it } from 'vitest';
import { getCheckoutState, getPaymentMessage } from '../payment-state';
import type { CheckoutStatus } from '../types';

describe('checkout payment facts', () => {
  const order: CheckoutStatus = {
    id: 'payment', status: 'completed', payment_status: 'underpaid',
    amount_expected: '100.000000', amount_received: '1.000000', currency: 'USDT',
    network: 'tron', address: 'address', tx_hash: 'hash', expires_at: '', confirmations: 19,
  };
  it.each(['completed', 'callback_failed', 'callback_sent'] as const)('shows underpayment despite %s callback workflow', (status) => {
    expect(getCheckoutState({ ...order, status })).toBe('underpaid');
    expect(getPaymentMessage({ ...order, status })?.type).toBe('checkout.underpaid');
  });
  it('keeps overpayment distinct in both display and parent notification', () => {
    const overpaid = { ...order, payment_status: 'overpaid' as const };
    expect(getCheckoutState(overpaid)).toBe('overpaid');
    expect(getPaymentMessage(overpaid)?.type).toBe('checkout.overpaid');
  });
  it('emits payment completion independently of a failed callback for a fully paid order', () => {
    expect(getPaymentMessage({ ...order, status: 'callback_failed', payment_status: 'confirmed' })?.type).toBe('checkout.completed');
  });
  it('falls back to legacy workflow status before payment confirmation', () => {
    expect(getCheckoutState({ ...order, status: 'detected', payment_status: null })).toBe('detected');
    expect(getPaymentMessage({ ...order, status: 'pending', payment_status: undefined })).toBeNull();
  });
});
