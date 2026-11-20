import { describe, it, expect } from 'vitest';
import { hmacSha256 } from '../utils/crypto.js';

// Mirrors signature logic in webhook-notifier.ts processWebhook()
function buildSignatureHeader(body: string, secret: string): string {
  return `sha256=${hmacSha256(body, secret)}`;
}

// Mirrors backoff logic in webhook-notifier.ts
const WEBHOOK_MAX_ATTEMPTS = 10;

function calcBackoffMs(nextAttempt: number): number {
  return Math.min(2 ** nextAttempt * 1000, 3_600_000);
}

describe('Webhook HMAC signature', () => {
  it('header is prefixed with sha256=', () => {
    const header = buildSignatureHeader('{}', 'secret');
    expect(header).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('same body + secret always produces same signature', () => {
    const body = JSON.stringify({ event: 'payment.confirmed', order_id: 'ord_123' });
    expect(buildSignatureHeader(body, 'my-secret')).toBe(
      buildSignatureHeader(body, 'my-secret'),
    );
  });

  it('different secrets produce different signatures', () => {
    const body = '{"order_id":"x"}';
    expect(buildSignatureHeader(body, 'secret-a')).not.toBe(
      buildSignatureHeader(body, 'secret-b'),
    );
  });

  it('signature changes when body changes', () => {
    const a = buildSignatureHeader('{"amount":"10.00"}', 'secret');
    const b = buildSignatureHeader('{"amount":"10.01"}', 'secret');
    expect(a).not.toBe(b);
  });
});

describe('Exponential backoff', () => {
  it('attempt 1 → 2s', () => {
    expect(calcBackoffMs(1)).toBe(2_000);
  });

  it('attempt 2 → 4s', () => {
    expect(calcBackoffMs(2)).toBe(4_000);
  });

  it('attempt 10 → 1024s (not yet capped)', () => {
    expect(calcBackoffMs(10)).toBe(1_024_000);
  });

  it('attempt 12+ → capped at 1 hour (3600000ms)', () => {
    // 2^12 * 1000 = 4096000 > 3600000, so cap applies
    expect(calcBackoffMs(12)).toBe(3_600_000);
  });

  it('large attempt numbers are capped at 1 hour', () => {
    expect(calcBackoffMs(30)).toBe(3_600_000);
  });

  it('max attempts constant is 10', () => {
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(10);
  });
});
