import { Decimal } from 'decimal.js';

export interface ExistingOrderCreateSignature {
  amountExpected: string;
  currency: string;
  callbackUrl: string;
}

export interface RequestedOrderCreateSignature {
  amount: string;
  currency?: string;
  callbackUrl: string;
}

export function normalizeOrderAmount(amount: string): string {
  return new Decimal(amount).toFixed(6);
}

export function normalizeOrderCurrency(currency?: string): string {
  return (currency ?? 'USDT').toUpperCase();
}

export function isCreateOrderReplayCompatible(
  existing: ExistingOrderCreateSignature,
  requested: RequestedOrderCreateSignature,
): boolean {
  return (
    existing.amountExpected === normalizeOrderAmount(requested.amount) &&
    existing.currency === normalizeOrderCurrency(requested.currency) &&
    existing.callbackUrl === requested.callbackUrl
  );
}
