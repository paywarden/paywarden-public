import type { FastifyRequest, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { merchants } from '../../db/schema.js';
import { verifyApiKey, extractPrefix } from '../../utils/api-key.js';

export async function authMiddleware(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const rawKey = req.headers['x-api-key'];
  if (!rawKey || typeof rawKey !== 'string') {
    reply.code(401).send({ error: 'Missing API key', code: 'UNAUTHORIZED' });
    return;
  }

  const prefix = extractPrefix(rawKey);

  const db = getDb();
  const candidates = await db
    .select()
    .from(merchants)
    .where(eq(merchants.apiKeyPrefix, prefix));
  const merchant = candidates.find((candidate) => verifyApiKey(rawKey, candidate.apiKeyHash));

  if (!merchant) {
    reply.code(401).send({ error: 'Invalid API key', code: 'UNAUTHORIZED' });
    return;
  }

  if (!merchant.isActive) {
    reply.code(403).send({ error: 'Merchant account is inactive', code: 'MERCHANT_INACTIVE' });
    return;
  }

  req.merchant = merchant;
}
