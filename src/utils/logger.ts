import pino from 'pino';
import { env } from '../config/env.js';
import { sanitizeLogValue } from './log-safety.js';

export const loggerOptions: pino.LoggerOptions = {
  level: env.LOG_LEVEL,
  transport:
    env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  base: { service: 'paywarden' },
  timestamp: pino.stdTimeFunctions.isoTime,
  serializers: { err: (value: unknown) => value },
  hooks: {
    logMethod(args, method) {
      const safe = args.map(value => sanitizeLogValue(value));
      if (args[0] instanceof Error) safe[0] = { err: safe[0] };
      method.apply(this, safe as Parameters<pino.LogFn>);
    },
  },
  redact: {
    paths: ['*.mnemonic', '*.privateKey', '*.vault_key'],
    censor: '[REDACTED]',
  },
};

export const logger = pino(loggerOptions);
