import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import type { WalletService } from '../../services/wallet.js';
import { logger } from '../../utils/logger.js';

const initBodySchema = z.object({
  mnemonic: z.string().optional(),
});

export function registerWalletRoutes(app: FastifyInstance, wallet: WalletService): void {
  app.post(
    '/api/v1/wallet/init',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const body = initBodySchema.safeParse(req.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid request body', code: 'INVALID_BODY' });
      }

      if (wallet.isInitialized()) {
        return reply.code(409).send({ error: 'Wallet already initialized', code: 'ALREADY_INITIALIZED' });
      }

      const mnemonic = await wallet.initVault(body.data.mnemonic);
      const { address } = await wallet.deriveAddress(0);

      logger.warn('Wallet initialized — mnemonic returned to client. Ensure HTTPS and secure storage!');

      return reply.code(201).send({
        message: 'Wallet initialized. BACKUP YOUR MNEMONIC!',
        mnemonic,
        first_address: address,
      });
    },
  );
}
