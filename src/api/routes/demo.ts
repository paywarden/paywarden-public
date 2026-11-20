/**
 * Demo checkout route — only registered when DEMO_MODE=true
 *
 * Creates a test order using the first available merchant and redirects
 * to the checkout page. Allows anyone to experience the payment flow
 * without configuring a merchant or API key.
 */
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { merchants } from '../../db/schema.js';
import { logger } from '../../utils/logger.js';
import type { OrderEngine } from '../../services/order-engine.js';

const DEMO_AMOUNTS = ['1.00', '5.00', '10.00', '25.00', '0.50'];

export function registerDemoRoutes(app: FastifyInstance, engine: OrderEngine): void {
  app.get(
    '/demo',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: 60 * 1000,
        },
      },
    },
    async (_req, reply) => {
      const db = getDb();

      // Find the first active merchant
      const [merchant] = await db
        .select({
          id: merchants.id,
          webhookSecret: merchants.webhookSecret,
        })
        .from(merchants)
        .where(eq(merchants.isActive, true))
        .limit(1);

      if (!merchant) {
        return reply.code(503).send({
          error: 'No merchant configured. Create one via the admin dashboard first.',
          code: 'NO_MERCHANT',
        });
      }

      // Pick a random small amount
      const amount = DEMO_AMOUNTS[Math.floor(Math.random() * DEMO_AMOUNTS.length)];
      const externalId = `demo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      try {
        const { order } = await engine.createOrder({
          externalId,
          amount,
          callbackUrl: 'https://httpbin.org/post', // safe sink for demo webhooks
          merchantId: merchant.id,
          webhookSecret: merchant.webhookSecret,
        });

        logger.info({ orderId: order.id, amount }, 'Demo checkout order created');
        return reply.redirect(`/checkout/${order.id}`);
      } catch (err) {
        logger.error({ err }, 'Failed to create demo order');
        return reply.code(500).send({
          error: 'Failed to create demo order',
          code: 'DEMO_ERROR',
        });
      }
    },
  );
}
