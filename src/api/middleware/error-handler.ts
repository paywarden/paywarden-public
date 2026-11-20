import type { FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import { logger } from '../../utils/logger.js';

/**
 * Business error code → HTTP status. Services throw `Object.assign(new
 * Error(msg), { code })`; routes can let it propagate instead of translating
 * per handler. Unknown codes fall through to 500.
 */
const CODE_STATUS: Record<string, number> = {
  VALIDATION_ERROR: 400,
  INVALID_AMOUNT: 400,
  NOT_FOUND: 404,
  INVALID_STATE: 409,
  EXTERNAL_ID_CONFLICT: 409,
  ADDRESS_EXISTS: 409,
  ADDRESS_MISMATCH: 409,
  AMOUNT_MISMATCH: 409,
  ALREADY_CLAIMED: 409,
  SWEEP_DISABLED: 409,
  NO_ADDRESSES: 503,
};

export function errorHandler(
  err: FastifyError,
  req: FastifyRequest,
  reply: FastifyReply,
): void {
  // Zod / Fastify validation error
  if (err.validation) {
    reply.code(400).send({
      error: 'Validation error',
      code: 'VALIDATION_ERROR',
      details: err.validation,
    });
    return;
  }

  // Known business errors
  if (err.statusCode && err.statusCode < 500) {
    reply.code(err.statusCode).send({
      error: err.message,
      code: (err as FastifyError & { code?: string }).code ?? 'ERROR',
    });
    return;
  }

  // Custom coded errors (e.g. NO_ADDRESSES)
  const coded = err as Error & { code?: string };
  const status =
    coded.code && Object.hasOwn(CODE_STATUS, coded.code) ? CODE_STATUS[coded.code] : undefined;
  if (status !== undefined) {
    reply.code(status).send({ error: err.message, code: coded.code });
    return;
  }

  logger.error({ err, reqId: req.id }, 'Unhandled error');
  reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
}
