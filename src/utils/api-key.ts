import { randomBytes, createHmac } from 'crypto';
import { env } from '../config/env.js';
import { safeEqualString } from './crypto.js';

export interface GeneratedApiKey {
  rawKey: string;   // returned to merchant once — never stored
  prefix: string;   // stored in DB for fast lookup
  hash: string;     // stored in DB for verification
}

/** Generate a new merchant API key. Returns raw key (show once) + prefix/hash for DB storage. */
export function generateApiKey(): GeneratedApiKey {
  const random = randomBytes(32).toString('base64url');
  const rawKey = `pw_${random}`;
  const prefix = random.slice(0, 8);
  const hash = createHmac('sha256', env.HMAC_SECRET).update(rawKey).digest('hex');
  return { rawKey, prefix, hash };
}

/** Verify an API key against the stored hash. Constant-time comparison. */
export function verifyApiKey(rawKey: string, storedHash: string): boolean {
  const expectedHash = createHmac('sha256', env.HMAC_SECRET).update(rawKey).digest('hex');
  return safeEqualString(expectedHash, storedHash);
}

/** Extract the 8-char prefix used for DB lookup from a raw API key. */
export function extractPrefix(rawKey: string): string {
  const body = rawKey.startsWith('pw_') ? rawKey.slice(3) : rawKey;
  return body.slice(0, 8);
}
