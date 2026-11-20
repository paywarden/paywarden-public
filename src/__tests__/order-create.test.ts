import { describe, it, expect } from 'vitest';
import {
  isCreateOrderReplayCompatible,
  normalizeOrderAmount,
  normalizeOrderCurrency,
} from '../utils/order-create.js';

describe('Order create normalization', () => {
  it('normalizes amount to 6 decimals', () => {
    expect(normalizeOrderAmount('10')).toBe('10.000000');
  });

  it('normalizes currency to uppercase USDT', () => {
    expect(normalizeOrderCurrency('usdt')).toBe('USDT');
  });

  it('defaults missing currency to USDT', () => {
    expect(normalizeOrderCurrency()).toBe('USDT');
  });
});

describe('Order create idempotency compatibility', () => {
  const existing = {
    amountExpected: '10.000000',
    currency: 'USDT',
    callbackUrl: 'https://merchant.example/webhook',
  };

  it('accepts a replay with the same logical payload', () => {
    expect(
      isCreateOrderReplayCompatible(existing, {
        amount: '10',
        currency: 'usdt',
        callbackUrl: 'https://merchant.example/webhook',
      }),
    ).toBe(true);
  });

  it('rejects a replay when amount changes', () => {
    expect(
      isCreateOrderReplayCompatible(existing, {
        amount: '10.010001',
        currency: 'USDT',
        callbackUrl: 'https://merchant.example/webhook',
      }),
    ).toBe(false);
  });

  it('rejects a replay when callback URL changes', () => {
    expect(
      isCreateOrderReplayCompatible(existing, {
        amount: '10',
        currency: 'USDT',
        callbackUrl: 'https://merchant.example/webhook-v2',
      }),
    ).toBe(false);
  });
});
