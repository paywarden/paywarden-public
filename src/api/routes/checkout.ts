import { getPaymentStatus } from '../../utils/order-recovery.js';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { orders, transactions } from '../../db/schema.js';

const orderIdSchema = z.string().uuid();

export function registerCheckoutRoutes(app: FastifyInstance): void {
  // Public status endpoint — no API key required
  app.get<{ Params: { order_id: string } }>(
    '/api/v1/checkout/:order_id/status',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      // Public read-only endpoint: intentionally bypasses global CORS policy
      // (origin: false or whitelist) to allow embedding the checkout status
      // in third-party sites / iframes. No auth, no mutation, no PII.
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Cache-Control', 'no-store');

      // orders.id is a uuid column — a non-UUID param would make Postgres
      // throw (22P02) and surface as a 500. Treat it as plain not-found.
      if (!orderIdSchema.safeParse(req.params.order_id).success) {
        return reply.code(404).send({ error: 'Order not found', code: 'NOT_FOUND' });
      }

      const db = getDb();
      const [order] = await db
        .select()
        .from(orders)
        .where(eq(orders.id, req.params.order_id));

      if (!order) {
        return reply.code(404).send({ error: 'Order not found', code: 'NOT_FOUND' });
      }

      const [tx] = order.txHash
        ? await db
            .select({ confirmations: transactions.confirmations })
            .from(transactions)
            .where(eq(transactions.txHash, order.txHash))
        : [];

      return {
        id: order.id,
        status: order.status,
        payment_status: getPaymentStatus(order),
        amount_expected: order.amountExpected,
        // Exact amount to pay — carries the tail in static-address mode.
        amount_payable: order.amountPayable ?? order.amountExpected,
        amount_received: order.amountReceived,
        currency: order.currency,
        network: order.network,
        address: order.address,
        tx_hash: order.txHash,
        expires_at: order.expiresAt.toISOString(),
        confirmations: tx?.confirmations ?? null,
      };
    },
  );
}
