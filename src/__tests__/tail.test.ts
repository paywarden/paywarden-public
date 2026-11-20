import { describe, expect, it } from 'vitest';
import {
  TAIL_MAX,
  applyTail,
  extractTail,
  formatTail,
  isStaticAmountValid,
  pickFreeTail,
} from '../utils/tail.js';

describe('formatTail', () => {
  it('zero-pads to four digits', () => {
    expect(formatTail(1)).toBe('0001');
    expect(formatTail(1370)).toBe('1370');
    expect(formatTail(9999)).toBe('9999');
  });

  it('rejects out-of-range values', () => {
    expect(() => formatTail(0)).toThrow(RangeError);
    expect(() => formatTail(10000)).toThrow(RangeError);
    expect(() => formatTail(1.5)).toThrow(RangeError);
  });
});

describe('isStaticAmountValid', () => {
  it('accepts up to two decimals', () => {
    expect(isStaticAmountValid('100')).toBe(true);
    expect(isStaticAmountValid('100.5')).toBe(true);
    expect(isStaticAmountValid('100.50')).toBe(true);
    expect(isStaticAmountValid('100.500000')).toBe(true);
  });

  it('rejects amounts that would collide with the tail digits', () => {
    expect(isStaticAmountValid('100.501')).toBe(false);
    expect(isStaticAmountValid('0.000001')).toBe(false);
  });
});

describe('applyTail / extractTail', () => {
  it('adds the tail into the last four decimals', () => {
    expect(applyTail('100.000000', '1370')).toBe('100.001370');
    expect(applyTail('0.50', '0001')).toBe('0.500001');
    expect(applyTail('19.99', '9999')).toBe('19.999999');
  });

  it('round-trips through extractTail', () => {
    expect(extractTail(applyTail('100', '1370'))).toBe('1370');
    expect(extractTail(applyTail('7.25', '0042'))).toBe('0042');
  });

  it('extracts the tail even when the integer part changed (exchange fee deducted)', () => {
    expect(extractTail('99.001370')).toBe('1370');
    expect(extractTail('99.00137')).toBe('1370');
  });

  it('reads 0000 for a rounded amount with no tail', () => {
    expect(extractTail('100')).toBe('0000');
    expect(extractTail('100.12')).toBe('0000');
  });

  it('rejects malformed tails', () => {
    expect(() => applyTail('100', '137')).toThrow(RangeError);
    expect(() => applyTail('100', 'abcd')).toThrow(RangeError);
  });
});

describe('pickFreeTail', () => {
  it('never returns a used tail', () => {
    const used = new Set(['0001', '0002', '0003']);
    // Deterministic RNG that would pick 0001, 0002, 0003, then 0004.
    let i = 0;
    const rng = () => [0, 1 / TAIL_MAX, 2 / TAIL_MAX, 3 / TAIL_MAX][i++] ?? 0.5;
    expect(pickFreeTail(used, rng)).toBe('0004');
  });

  it('returns null when the address is saturated', () => {
    const used = new Set<string>();
    for (let n = 1; n <= TAIL_MAX; n++) used.add(formatTail(n));
    expect(pickFreeTail(used)).toBeNull();
  });

  it('falls back to a scan when random probing keeps colliding', () => {
    const used = new Set<string>();
    for (let n = 1; n <= TAIL_MAX - 1; n++) used.add(formatTail(n));
    // RNG always lands on a used tail.
    expect(pickFreeTail(used, () => 0)).toBe('9999');
  });
});

describe('extractTail rounding', () => {
  it('truncates beyond 6 decimals instead of rounding (a stray digit must not shift the tail)', () => {
    expect(extractTail('99.0013705')).toBe('1370');
    expect(extractTail('99.0013709')).toBe('1370');
  });
});

describe('applyTail input guards', () => {
  it('rejects the 0000 tail', () => {
    expect(() => applyTail('100', '0000')).toThrow(RangeError);
  });

  it('rejects an expected amount that would collide with the tail digits', () => {
    expect(() => applyTail('100.001', '9999')).toThrow(RangeError);
  });
});

describe('pickFreeTail bounds', () => {
  it('clamps a random() of 1 into range instead of throwing', () => {
    expect(pickFreeTail(new Set(), () => 1)).toBe(formatTail(TAIL_MAX));
  });

  it('clamps a random() of 0 to the first tail', () => {
    expect(pickFreeTail(new Set(), () => 0)).toBe('0001');
  });
});
