import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, hmacSha256, safeEqualString } from '../utils/crypto.js';

const KEY = 'a'.repeat(64); // 64 hex chars = 32 bytes

describe('AES-256-GCM', () => {
  it('encrypts and decrypts to the same value', () => {
    const plain = 'abandon abandon abandon';
    expect(decrypt(encrypt(plain, KEY), KEY)).toBe(plain);
  });

  it('uses a different IV each time (non-deterministic)', () => {
    const a = encrypt('test', KEY);
    const b = encrypt('test', KEY);
    expect(a).not.toBe(b);
  });

  it('decryption fails with wrong key', () => {
    const wrongKey = 'b'.repeat(64);
    const ciphertext = encrypt('secret', KEY);
    expect(() => decrypt(ciphertext, wrongKey)).toThrow();
  });

  it('output format is iv(32) + authTag(32) + ciphertext hex', () => {
    const plain = 'hello';
    const out = encrypt(plain, KEY);
    // iv = 16 bytes = 32 hex, authTag = 16 bytes = 32 hex, then ciphertext
    expect(out.length).toBeGreaterThan(64);
    expect(out).toMatch(/^[0-9a-f]+$/);
  });
});

describe('HMAC-SHA256', () => {
  it('produces a 64-char hex string', () => {
    const sig = hmacSha256('{"amount":"10.00"}', 'secret');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for same input', () => {
    const sig1 = hmacSha256('{"amount":"10.00"}', 'secret');
    const sig2 = hmacSha256('{"amount":"10.00"}', 'secret');
    expect(sig1).toBe(sig2);
  });

  it('changes with different payload', () => {
    const a = hmacSha256('payload-a', 'secret');
    const b = hmacSha256('payload-b', 'secret');
    expect(a).not.toBe(b);
  });

  it('changes with different secret', () => {
    const a = hmacSha256('same-payload', 'secret-a');
    const b = hmacSha256('same-payload', 'secret-b');
    expect(a).not.toBe(b);
  });
});

describe('Safe string comparison', () => {
  it('returns true for identical strings', () => {
    expect(safeEqualString('paywarden', 'paywarden')).toBe(true);
  });

  it('returns false for different strings', () => {
    expect(safeEqualString('paywarden', 'paygarden')).toBe(false);
  });

  it('returns false for different lengths', () => {
    expect(safeEqualString('short', 'much-longer')).toBe(false);
  });
});
