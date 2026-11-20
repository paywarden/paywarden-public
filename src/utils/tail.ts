import { Decimal } from 'decimal.js';

/**
 * Amount-tail helpers for static-address mode (ADDRESS_MODE=static).
 *
 * Several pending orders share one merchant address, so the on-chain amount
 * is the only thing that tells them apart. Each order gets a 4-digit tail
 * occupying the last four of USDT's six decimals:
 *
 *   amount_expected 100.00      tail 1370
 *   amount_payable  100.001370  (= expected + 0.001370)
 *
 * Matching reads the tail back from the received amount and ignores the
 * integer part, so an exchange that deducts its withdrawal fee from the
 * amount (99.001370 arrives for a 100.001370 order) still matches and then
 * classifies as underpaid.
 */

export const TAIL_DIGITS = 4;
export const TAIL_MIN = 1;
export const TAIL_MAX = 9999;
/** Merchant-facing amounts must leave the tail digits free. */
export const STATIC_AMOUNT_MAX_DECIMALS = 2;

const TAIL_UNIT = new Decimal(10).pow(-6); // one tail step = 0.000001 USDT
const TAIL_PATTERN = /^\d{4}$/;

export function formatTail(n: number): string {
  if (!Number.isInteger(n) || n < TAIL_MIN || n > TAIL_MAX) {
    throw new RangeError(`tail out of range: ${n}`);
  }
  return String(n).padStart(TAIL_DIGITS, '0');
}

/** True when the amount has at most STATIC_AMOUNT_MAX_DECIMALS significant decimals. */
export function isStaticAmountValid(amount: string): boolean {
  const d = new Decimal(amount);
  return d.isFinite() && d.decimalPlaces() <= STATIC_AMOUNT_MAX_DECIMALS;
}

/** amount_expected + tail, as a 6-decimal string. */
export function applyTail(amountExpected: string, tail: string): string {
  if (!TAIL_PATTERN.test(tail) || tail === '0000') throw new RangeError(`malformed tail: ${tail}`);
  if (!isStaticAmountValid(amountExpected)) {
    throw new RangeError(
      `amount has more than ${STATIC_AMOUNT_MAX_DECIMALS} decimals: ${amountExpected}`,
    );
  }
  return new Decimal(amountExpected).plus(TAIL_UNIT.mul(Number(tail))).toFixed(6);
}

/**
 * Last four decimals of a received amount, e.g. "99.001370" → "1370".
 * USDT has exactly 6 decimals on-chain; anything beyond is truncated, never
 * rounded, so a stray extra digit cannot shift the tail.
 */
export function extractTail(amount: string): string {
  const fixed = new Decimal(amount).toFixed(6, Decimal.ROUND_DOWN);
  return fixed.slice(-TAIL_DIGITS);
}

/**
 * Pick a random tail not present in `used`. Returns null when the address
 * is saturated (9999 concurrent pending orders) so the caller can move on
 * to the merchant's next address.
 */
export function pickFreeTail(
  used: ReadonlySet<string>,
  random: () => number = Math.random,
): string | null {
  const capacity = TAIL_MAX - TAIL_MIN + 1;
  if (used.size >= capacity) return null;

  // Random probing keeps tails unpredictable to payers; with the set far
  // from full this terminates in a couple of tries.
  for (let attempt = 0; attempt < 32; attempt++) {
    const offset = Math.min(capacity - 1, Math.max(0, Math.floor(random() * capacity)));
    const candidate = formatTail(TAIL_MIN + offset);
    if (!used.has(candidate)) return candidate;
  }

  // Dense set — fall back to a deterministic scan.
  for (let n = TAIL_MIN; n <= TAIL_MAX; n++) {
    const candidate = formatTail(n);
    if (!used.has(candidate)) return candidate;
  }
  return null;
}
