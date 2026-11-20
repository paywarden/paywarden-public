import { getPaymentStatus } from '../../utils/order-recovery.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, sql } from 'drizzle-orm';
import { Decimal } from 'decimal.js';
import { authMiddleware } from '../middleware/auth.js';
import { getDb } from '../../db/index.js';
import { orders, orderEvents } from '../../db/schema.js';
import type { OrderEngine } from '../../services/order-engine.js';
import { env } from '../../config/env.js';
import { isCallbackUrlSafe } from '../../utils/url-safety.js';

const createPaymentSchema = z.object({
  external_id: z.string().min(1).max(255),
  amount: z
    .string()
    .regex(/^\d+(\.\d{1,6})?$/, 'Amount must be a positive decimal string')
    .refine((value) => new Decimal(value).gt(0), 'Amount must be greater than 0'),
  currency: z
    .string()
    .optional()
    .transform((value) => value?.toUpperCase() ?? 'USDT')
    .refine((value) => value === 'USDT', 'Only USDT is supported'),
  callback_url: z
    .string()
    .url()
    .refine(
      // SSRF guard at request validation time. The webhook notifier also
      // re-checks before fetch (defense in depth), but rejecting at create
      // time gives merchants an immediate, actionable error instead of a
      // silent webhook failure later.
      (value) => isCallbackUrlSafe(value, { allowPrivate: env.ALLOW_PRIVATE_CALLBACKS }).ok,
      'callback_url must not target private, loopback, or reserved network addresses',
    ),
  ttl: z.number().int().positive().optional(),
});

const listQuerySchema = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export function registerPaymentRoutes(app: FastifyInstance, engine: OrderEngine): void {
  // POST /api/v1/payments — create order
  app.post(
    '/api/v1/payments',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const body = createPaymentSchema.safeParse(req.body);
      if (!body.success) {
        const firstIssue = body.error.issues[0];
        const field = firstIssue?.path[0];
        const code = field === 'amount' ? 'INVALID_AMOUNT' : 'INVALID_BODY';
        return reply.code(400).send({
          error: firstIssue?.message ?? 'Invalid request body',
          code,
        });
      }

      const { external_id, amount, currency, callback_url, ttl } = body.data;

      try {
        const { order, reused } = await engine.createOrder({
          externalId: external_id,
          amount,
          currency,
          callbackUrl: callback_url,
          ttl,
          merchantId: req.merchant.id,
          webhookSecret: req.merchant.webhookSecret,
        });

        return reply.code(reused ? 200 : 201).send({
          id: order.id,
          external_id: order.externalId,
          address: order.address,
          amount: order.amountExpected,
          // Exact amount the payer must send. Differs from `amount` in
          // static-address mode (carries the 4-digit tail).
          amount_payable: order.amountPayable ?? order.amountExpected,
          tail: order.tail,
          currency: order.currency,
          network: order.network,
          status: order.status,
          payment_status: getPaymentStatus(order),
          expires_at: order.expiresAt.toISOString(),
          created_at: order.createdAt.toISOString(),
          reused,
        });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'EXTERNAL_ID_CONFLICT') {
          return reply.code(409).send({
            error: 'external_id already exists with different parameters',
            code,
          });
        }

        if (code === 'NO_ADDRESSES') {
          return reply.code(503).send({
            error: 'No receiving addresses are currently available',
            code,
          });
        }

        if (code === 'INVALID_AMOUNT') {
          return reply.code(400).send({ error: (err as Error).message, code });
        }

        throw err;
      }
    },
  );

  // GET /api/v1/payments/:id — get order with events (merchant-scoped)
  app.get<{ Params: { id: string } }>(
    '/api/v1/payments/:id',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const db = getDb();
      const { id } = req.params;

      // Non-UUID ids would make Postgres throw on the uuid column (22P02)
      // and surface as a 500 — treat them as plain not-found.
      if (!z.string().uuid().safeParse(id).success) {
        return reply.code(404).send({ error: 'Order not found', code: 'NOT_FOUND' });
      }

      const [order] = await db
        .select()
        .from(orders)
        .where(and(eq(orders.id, id), eq(orders.merchantId, req.merchant.id)));

      if (!order) {
        return reply.code(404).send({ error: 'Order not found', code: 'NOT_FOUND' });
      }

      const events = await db
        .select()
        .from(orderEvents)
        .where(eq(orderEvents.orderId, id))
        .orderBy(orderEvents.createdAt);

      return reply.send({
        id: order.id,
        external_id: order.externalId,
        address: order.address,
        derivation_idx: order.derivationIdx,
        amount_expected: order.amountExpected,
        amount_payable: order.amountPayable ?? order.amountExpected,
        tail: order.tail,
        amount_received: order.amountReceived,
        currency: order.currency,
        network: order.network,
        status: order.status,
        payment_status: getPaymentStatus(order),
        callback_url: order.callbackUrl,
        tx_hash: order.txHash,
        // expires_at only meaningful while pending — once detected, the deadline no longer applies
        expires_at: order.status === 'pending' ? order.expiresAt.toISOString() : null,
        created_at: order.createdAt.toISOString(),
        updated_at: order.updatedAt.toISOString(),
        events: events.map((e) => ({
          event_type: e.eventType,
          payload: e.payload,
          created_at: e.createdAt.toISOString(),
        })),
      });
    },
  );

  // GET /api/v1/payments — list orders (merchant-scoped)
  app.get(
    '/api/v1/payments',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const db = getDb();
      const query = listQuerySchema.safeParse(req.query);
      if (!query.success) {
        return reply.code(400).send({ error: 'Invalid query parameters', code: 'INVALID_QUERY' });
      }

      const { status, limit, offset } = query.data;
      const merchantFilter = eq(orders.merchantId, req.merchant.id);
      const statusFilter = status ? eq(orders.status, status) : undefined;
      const whereClause = statusFilter ? and(merchantFilter, statusFilter) : merchantFilter;

      const [rows, [{ count }]] = await Promise.all([
        db
          .select()
          .from(orders)
          .where(whereClause)
          .orderBy(desc(orders.createdAt))
          .limit(limit)
          .offset(offset),
        db.select({ count: sql<number>`count(*)` }).from(orders).where(whereClause),
      ]);

      return reply.send({
        // Manual field mapping (same shape as GET /payments/:id, minus events):
        // raw Drizzle rows would leak webhook_secret / merchant_id and break
        // the snake_case contract.
        data: rows.map((order) => ({
          id: order.id,
          external_id: order.externalId,
          address: order.address,
          derivation_idx: order.derivationIdx,
          amount_expected: order.amountExpected,
          amount_payable: order.amountPayable ?? order.amountExpected,
          tail: order.tail,
          amount_received: order.amountReceived,
          currency: order.currency,
          network: order.network,
          status: order.status,
          payment_status: getPaymentStatus(order),
          callback_url: order.callbackUrl,
          tx_hash: order.txHash,
          expires_at: order.status === 'pending' ? order.expiresAt.toISOString() : null,
          created_at: order.createdAt.toISOString(),
          updated_at: order.updatedAt.toISOString(),
        })),
        total: Number(count),
        limit,
        offset,
      });
    },
  );
}
