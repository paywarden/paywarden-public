/**
 * Debug routes — only registered when NODE_ENV=development
 * Never expose in production.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import type { OrderEngine } from '../../services/order-engine.js';

const simulateSchema = z.object({
  order_id: z.string().uuid(),
  tx_hash: z.string().min(10),
  amount: z.string().regex(/^\d+(\.\d{1,6})?$/),
  from_address: z.string().default('TNile_sim_sender_address'),
  block_number: z.number().int().positive().default(66000000),
});

const confirmSchema = z.object({
  tx_hash: z.string().min(10),
  confirmations: z.number().int().min(1).default(19),
  block_number: z.number().int().positive(),
});

export function registerDebugRoutes(app: FastifyInstance, engine: OrderEngine): void {
  /** Simulate chain watcher detecting a payment */
  app.post(
    '/api/v1/debug/simulate-detected',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const body = simulateSchema.safeParse(req.body);
      if (!body.success) {
        return reply.code(400).send({ error: body.error.issues[0]?.message, code: 'INVALID_BODY' });
      }

      const { order_id: _orderId, tx_hash, amount, from_address, block_number } = body.data;
      const db = (await import('../../db/index.js')).getDb();
      const { orders } = await import('../../db/schema.js');
      const { eq } = await import('drizzle-orm');

      const [order] = await db.select().from(orders).where(eq(orders.id, _orderId));
      if (!order) return reply.code(404).send({ error: 'Order not found', code: 'NOT_FOUND' });

      await engine.onPaymentDetected(tx_hash, order.address, amount, from_address, block_number);
      return reply.send({ ok: true, message: 'Payment detected event injected' });
    },
  );

  /** Simulate chain watcher reaching MIN_CONFIRMATIONS */
  app.post(
    '/api/v1/debug/simulate-confirmed',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const body = confirmSchema.safeParse(req.body);
      if (!body.success) {
        return reply.code(400).send({ error: body.error.issues[0]?.message, code: 'INVALID_BODY' });
      }

      await engine.onPaymentConfirmed(body.data.tx_hash, body.data.confirmations, body.data.block_number);
      return reply.send({ ok: true, message: 'Payment confirmed event injected' });
    },
  );
}
