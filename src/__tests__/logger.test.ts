import { createRequire } from 'node:module';
import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({ env: {
  LOG_LEVEL: 'info', NODE_ENV: 'test', TRONGRID_API_KEY: 'configured-trongrid-secret',
  API_KEY: 'configured-api-secret', WEBHOOK_SECRET: 'configured-webhook-secret',
} }));
const { loggerOptions } = await import('../utils/logger.js');
const require = createRequire(import.meta.url);
const { AxiosError } = require(require.resolve('axios', { paths: [require.resolve('tronweb')] })) as {
  AxiosError: new (message: string, code: string, config: object, request: object, response: object) => Error;
};

function capture() {
  const lines: string[] = [];
  const sink = new Writable({ write(chunk, _encoding, done) { lines.push(String(chunk)); done(); } });
  return { logger: pino({ ...loggerOptions, transport: undefined }, sink), lines };
}

describe('application log confidentiality', () => {
  it('keeps Axios diagnostics without serializing request credentials or bodies', () => {
    const { logger, lines } = capture();
    const err = new AxiosError('RPC failed: configured-trongrid-secret', 'ERR_BAD_RESPONSE', {
      headers: { 'TRON-PRO-API-KEY': 'configured-trongrid-secret' }, data: 'private-request-body',
    }, { raw: 'private-request-object' }, { status: 503, data: 'private-response-body' });
    logger.error({ err, orderId: 'order-1', txHash: 'tx-1' }, 'Sweep failed');
    const raw = lines.join('');
    expect(raw).not.toMatch(/configured-trongrid-secret|private-request|private-response/);
    const entry = JSON.parse(raw);
    expect(entry).toMatchObject({ orderId: 'order-1', txHash: 'tx-1', err: { type: 'AxiosError', code: 'ERR_BAD_RESPONSE', status: 503 } });
    expect(entry.err.config).toBeUndefined();
    expect(entry.err.stack).toContain('AxiosError');
  });

  it('handles nested errors and causes regardless of the log field name', () => {
    const { logger, lines } = capture();
    const cause = Object.assign(new Error('configured-api-secret'), { config: { headers: { Authorization: 'unknown-bearer' } } });
    logger.error({ notifyErr: new Error('configured-webhook-secret', { cause }) }, 'Notification failed');
    expect(lines.join('')).not.toMatch(/configured-api-secret|configured-webhook-secret|unknown-bearer/);
    expect(JSON.parse(lines[0]).notifyErr.cause.message).toBe('[REDACTED]');
  });

  it('redacts nested headers and credential fields as well as formatted messages', () => {
    const { logger, lines } = capture();
    logger.warn({ context: { headers: { 'x-api-key': 'arbitrary-key' }, authorization: 'arbitrary-auth',
      cookie: 'arbitrary-cookie', privateKey: 'arbitrary-private-key', mnemonic: 'arbitrary-seed' } },
    'RPC %s', 'configured-trongrid-secret');
    logger.error('configured-api-secret');
    expect(lines.join('')).not.toMatch(/arbitrary-|configured-trongrid-secret|configured-api-secret/);
    expect(JSON.parse(lines[0]).msg).toBe('RPC [REDACTED]');
  });
});
