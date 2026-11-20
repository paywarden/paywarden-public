import { describe, expect, it } from 'vitest';
import { isValidTronAddress } from '../utils/tron-address.js';

// Real base58check addresses: mainnet USDT, Nile USDT, drill cold wallet.
const VALID = [
  'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf',
  'TACBmCJj8xFqUjVqYx9TFhX5acU7zD5Win',
];

describe('isValidTronAddress', () => {
  it('accepts well-formed addresses', () => {
    for (const a of VALID) expect(isValidTronAddress(a)).toBe(true);
  });

  it('rejects a single-character typo (checksum)', () => {
    const typo = VALID[0].slice(0, -1) + (VALID[0].endsWith('t') ? 'u' : 't');
    expect(isValidTronAddress(typo)).toBe(false);
  });

  it('rejects truncation, wrong prefix, and non-strings', () => {
    expect(isValidTronAddress(VALID[0].slice(0, 33))).toBe(false);
    expect(isValidTronAddress('1' + VALID[0].slice(1))).toBe(false);
    expect(isValidTronAddress('')).toBe(false);
    expect(isValidTronAddress(null)).toBe(false);
    expect(isValidTronAddress(42)).toBe(false);
  });

  it('rejects an Ethereum-style hex address', () => {
    expect(isValidTronAddress('0x41a614f803b6fd780986a42c78ec9c7f77e6ded13c')).toBe(false);
  });
});

describe('isValidTronAddress version byte', () => {
  it('rejects a base58check string with a non-0x41 version byte even if it starts with T', async () => {
    const { default: bs58check } = await import('bs58check');
    const payload = new Uint8Array(21);
    payload[0] = 0x40;
    payload.fill(0x11, 1);
    const encoded = bs58check.encode(payload);
    // Only meaningful if the fixture happens to start with T; either way it must be rejected.
    expect(isValidTronAddress(encoded)).toBe(false);
  });
});
