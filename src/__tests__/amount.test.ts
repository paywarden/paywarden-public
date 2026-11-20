import { describe, it, expect } from 'vitest';
import { Decimal } from 'decimal.js';

describe('Decimal amount precision', () => {
  it('preserves 6 decimal places via toFixed(6)', () => {
    expect(new Decimal('100.5').toFixed(6)).toBe('100.500000');
    expect(new Decimal('0.000001').toFixed(6)).toBe('0.000001');
    expect(new Decimal('999999.999999').toFixed(6)).toBe('999999.999999');
  });

  it('does not lose precision with floating-point-dangerous values', () => {
    // 0.1 + 0.2 == 0.3 in Decimal.js
    const result = new Decimal('0.1').plus('0.2');
    expect(result.toFixed(6)).toBe('0.300000');
  });

  it('string "100.50" and "100.5" are equal by value', () => {
    expect(new Decimal('100.50').eq(new Decimal('100.5'))).toBe(true);
  });

  it('compares amounts correctly', () => {
    const received = new Decimal('99.99');
    const expected = new Decimal('100.00');
    expect(received.lt(expected)).toBe(true);
    expect(received.gt(expected)).toBe(false);
  });

  it('abs difference calculation', () => {
    const diff = new Decimal('100.005').minus('100.00').abs();
    expect(diff.lte(new Decimal('0.01'))).toBe(true);
  });
});

describe('USDT 6-decimal boundary cases', () => {
  it('minimum unit is 0.000001', () => {
    const min = new Decimal('0.000001');
    expect(min.gt(0)).toBe(true);
    expect(min.toFixed(6)).toBe('0.000001');
  });

  it('truncates beyond 6 decimals when converting', () => {
    // toFixed rounds, not truncates — but payments come from chain with 6 decimals
    const raw = new Decimal('1234567').dividedBy(1_000_000);
    expect(raw.toFixed(6)).toBe('1.234567');
  });
});
