import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyAdminToken } from '../../utils/jwt.js';

export async function adminAuthMiddleware(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = (req.cookies as Record<string, string | undefined>).admin_token;
  if (!token) {
    reply.code(401).send({ error: 'Not authenticated', code: 'ADMIN_UNAUTHORIZED' });
    return;
  }
  if (!verifyAdminToken(token)) {
    reply.code(401).send({ error: 'Invalid or expired token', code: 'ADMIN_TOKEN_INVALID' });
  }
}
