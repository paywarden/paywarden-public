import { describe, it, expect } from 'vitest';
import { Decimal } from 'decimal.js';

// Mirrors the status-determination logic in order-engine.ts onPaymentConfirmed()
const TOLERANCE = new Decimal('0.01');

function determineStatus(received: string, expected: string): string {
  const r = new Decimal(received);
  const e = new Decimal(expected);
  const diff = r.minus(e).abs();

  if (diff.lte(TOLERANCE)) return 'confirmed';
  if (r.lt(e)) return 'underpaid';
  return 'overpaid';
}

describe('Payment status determination', () => {
  it('exact match → confirmed', () => {
    expect(determineStatus('100.000000', '100.000000')).toBe('confirmed');
  });

  it('within tolerance (+0.01) → confirmed', () => {
    expect(determineStatus('100.010000', '100.000000')).toBe('confirmed');
  });

  it('within tolerance (-0.01) → confirmed', () => {
    expect(determineStatus('99.990000', '100.000000')).toBe('confirmed');
  });

  it('just over tolerance → overpaid', () => {
    expect(determineStatus('100.020000', '100.000000')).toBe('overpaid');
  });

  it('significantly underpaid → underpaid', () => {
    expect(determineStatus('50.000000', '100.000000')).toBe('underpaid');
  });

  it('significantly overpaid → overpaid', () => {
    expect(determineStatus('200.000000', '100.000000')).toBe('overpaid');
  });

  it('just under tolerance (0.009 under) → confirmed', () => {
    expect(determineStatus('99.991000', '100.000000')).toBe('confirmed');
  });

  it('just outside tolerance (0.011 under) → underpaid', () => {
    expect(determineStatus('99.989000', '100.000000')).toBe('underpaid');
  });
});

describe('Order status progression (forward-only)', () => {
  const VALID_TRANSITIONS: Record<string, string[]> = {
    pending: ['detected', 'expired'],
    detected: ['confirmed', 'underpaid', 'overpaid'],
    confirmed: ['callback_sent', 'completed'],
    underpaid: ['callback_sent'],
    overpaid: ['callback_sent'],
    callback_sent: ['completed'],
    completed: [],
    expired: [],
    callback_failed: [],
  };

  function canTransition(from: string, to: string): boolean {
    return VALID_TRANSITIONS[from]?.includes(to) ?? false;
  }

  it('pending → detected is valid', () => {
    expect(canTransition('pending', 'detected')).toBe(true);
  });

  it('completed → pending is invalid (no regression)', () => {
    expect(canTransition('completed', 'pending')).toBe(false);
  });

  it('confirmed → detected is invalid (no regression)', () => {
    expect(canTransition('confirmed', 'detected')).toBe(false);
  });

  it('expired → pending is invalid', () => {
    expect(canTransition('expired', 'pending')).toBe(false);
  });
});
