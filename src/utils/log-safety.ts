import { env } from '../config/env.js';

const credentials = Object.entries(env)
  .filter(([name, value]) => /(?:KEY|SECRET|PASSWORD|TOKEN|PASS|DATABASE_URL|REDIS_URL)$/.test(name) && typeof value === 'string' && value.length > 0)
  .map(([, value]) => value as string)
  .sort((a, b) => b.length - a.length);
const sensitiveFields = new Set([
  'headers', 'authorization', 'cookie', 'setcookie', 'apikey', 'xapikey', 'tronproapikey',
  'trongridapikey', 'password', 'pass', 'privatekey', 'mnemonic', 'vaultkey', 'hotwalletkey',
  'hmacsecret', 'jwtsecret', 'webhooksecret', 'secret', 'token', 'accesstoken', 'refreshtoken',
]);

function redactText(text: string): string {
  for (const value of credentials) text = text.replaceAll(value, '[REDACTED]');
  return text;
}

/** Never let HTTP client error serializers copy request/response objects into logs. */
export function sanitizeLogValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'function') return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    const detail = value as Error & { code?: string | number; status?: number };
    return {
      type: redactText(value.name), message: redactText(value.message),
      stack: value.stack && redactText(value.stack), code: sanitizeLogValue(detail.code, seen),
      status: detail.status, cause: sanitizeLogValue(value.cause, seen),
    };
  }
  if (Array.isArray(value)) return value.map(item => sanitizeLogValue(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    sensitiveFields.has(key.toLowerCase().replace(/[^a-z]/g, '')) ? '[REDACTED]' : sanitizeLogValue(entry, seen),
  ]));
}
