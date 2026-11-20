import { getPaymentStatus } from '../../utils/order-recovery.js';
import { getAdminRecovery } from '../../utils/admin-recovery.js';
import type { FastifyInstance } from 'fastify';
import { eq, and, gte, lte, count, sql, desc } from 'drizzle-orm';
import { z } from 'zod';
import { TronWeb } from 'tronweb';
import { env } from '../../config/env.js';
import { NETWORK } from '../../config/constants.js';
import { getDb } from '../../db/index.js';
import { orders, orderEvents, merchants, addresses, transactions, webhookDeliveries, sweepJobs } from '../../db/schema.js';
import type { NewMerchant } from '../../db/schema.js';
import { signAdminToken } from '../../utils/jwt.js';
import { generateApiKey } from '../../utils/api-key.js';
import { safeEqualString } from '../../utils/crypto.js';
import { adminAuthMiddleware } from '../middleware/admin-auth.js';
import type { GasManager } from '../../services/gas-manager.js';
import type { FundSweeper } from '../../services/fund-sweeper.js';
import type { OrderEngine } from '../../services/order-engine.js';

const COOKIE_MAX_AGE = 60 * 60 * 24; // 24h
const ADMIN_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: env.NODE_ENV === 'production',
  path: '/',
  maxAge: COOKIE_MAX_AGE,
};
// Cookies issued before the path was widened from /api/v1/admin to / still
// linger in browsers. They take precedence on /api/v1/admin/* requests, so we
// must explicitly nuke them on every login and logout — otherwise users can't
// truly sign out for 24h after the upgrade and may end up with two competing
// admin_token cookies on subsequent logins.
const LEGACY_ADMIN_COOKIE_PATH = '/api/v1/admin';
function clearLegacyAdminCookie(reply: import('fastify').FastifyReply): void {
  reply.clearCookie('admin_token', {
    path: LEGACY_ADMIN_COOKIE_PATH,
    sameSite: ADMIN_COOKIE_OPTIONS.sameSite,
    secure: ADMIN_COOKIE_OPTIONS.secure,
  });
}
const TRONSCAN_BASE_URL = {
  mainnet: 'https://tronscan.org/#',
  nile: 'https://nile.tronscan.org/#',
  shasta: 'https://shasta.tronscan.org/#',
} as const;

function getSystemMeta() {
  const tronscanBaseUrl = TRONSCAN_BASE_URL[env.TRON_NETWORK];

  return {
    tron_network: env.TRON_NETWORK,
    usdt_contract: env.USDT_CONTRACT,
    trongrid_url: NETWORK.trongridUrl,
    tronscan_base_url: tronscanBaseUrl,
    tx_explorer_base_url: `${tronscanBaseUrl}/transaction/`,
    address_explorer_base_url: `${tronscanBaseUrl}/address/`,
    sweep_enabled: env.ADDRESS_MODE === 'hd' && !!(env.HOT_WALLET_KEY && env.COLD_WALLET_ADDRESS),
    sweep_mode: env.SWEEP_MODE,
    hot_wallet_alert_trx: env.HOT_WALLET_ALERT_TRX,
  };
}

// ─── Dual-accept helpers ────────────────────────────────────────────────────
// Request bodies during the transition accept BOTH camelCase and snake_case
// field names. We normalize to snake_case before Zod validation so schemas
// stay single-sourced.

function pickField<T>(
  body: Record<string, unknown> | null | undefined,
  snake: string,
  camel: string,
): T | undefined {
  if (!body || typeof body !== 'object') return undefined;
  if (body[snake] !== undefined) return body[snake] as T;
  if (body[camel] !== undefined) return body[camel] as T;
  return undefined;
}

export function registerAdminRoutes(
  app: FastifyInstance,
  deps: { gasManager: GasManager; fundSweeper: FundSweeper; orderEngine: OrderEngine },
): void {
  const { gasManager, fundSweeper, orderEngine } = deps;

  // ─── Auth ───────────────────────────────────────────────────────────────────

  app.post('/api/v1/admin/auth/login', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: 15 * 60 * 1000,
      },
    },
  }, async (req, reply) => {
    const { password } = (req.body ?? {}) as { password?: string };
    if (!password || !safeEqualString(password, env.ADMIN_PASSWORD)) {
      return reply.code(401).send({ error: 'Invalid password', code: 'INVALID_PASSWORD' });
    }
    const token = signAdminToken();
    reply.header('Cache-Control', 'no-store');
    clearLegacyAdminCookie(reply);
    reply.setCookie('admin_token', token, ADMIN_COOKIE_OPTIONS);
    return { ok: true };
  });

  app.post('/api/v1/admin/auth/logout', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.clearCookie('admin_token', {
      path: ADMIN_COOKIE_OPTIONS.path,
      sameSite: ADMIN_COOKIE_OPTIONS.sameSite,
      secure: ADMIN_COOKIE_OPTIONS.secure,
    });
    clearLegacyAdminCookie(reply);
    return { ok: true };
  });

  // ─── Stats ──────────────────────────────────────────────────────────────────

  app.get('/api/v1/admin/stats', { preHandler: adminAuthMiddleware }, async () => {
    const db = getDb();
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const statsQuery = (from?: Date) =>
      db
        .select({
          orderCount: count(),
          completedCount:
            sql<number>`COUNT(*) FILTER (WHERE ${orders.status} = 'completed')`,
          totalReceived:
            sql<string>`COALESCE(SUM(CASE WHEN ${orders.status} = 'completed' THEN ${orders.amountReceived}::numeric ELSE 0 END)::text, '0')`,
        })
        .from(orders)
        .where(from ? gte(orders.createdAt, from) : undefined);

    const [todayRows, weekRows, totalRows, poolRows, [merchantRow]] = await Promise.all([
      statsQuery(startOfToday),
      statsQuery(startOfWeek),
      statsQuery(),
      db
        .select({
          total: count(),
          free: sql<number>`COUNT(*) FILTER (WHERE ${addresses.isAllocated} = false)`,
          allocated: sql<number>`COUNT(*) FILTER (WHERE ${addresses.isAllocated} = true)`,
        })
        .from(addresses),
      db.select({ c: count() }).from(merchants),
    ]);

    const toStats = (row: { orderCount: number; completedCount: number; totalReceived: string }) => ({
      order_count: row.orderCount,
      completed_count: row.completedCount,
      total_received: row.totalReceived,
      success_rate:
        row.orderCount > 0
          ? ((row.completedCount / row.orderCount) * 100).toFixed(2)
          : '0.00',
    });

    return {
      today: toStats(todayRows[0]),
      week: toStats(weekRows[0]),
      total: { ...toStats(totalRows[0]), merchant_count: merchantRow.c },
      address_pool: {
        total: poolRows[0].total,
        free: poolRows[0].free,
        allocated: poolRows[0].allocated,
      },
    };
  });

  // ─── Stats Daily ────────────────────────────────────────────────────────────

  app.get('/api/v1/admin/stats/daily', { preHandler: adminAuthMiddleware }, async () => {
    const db = getDb();
    const rows = await db.execute(sql`
      SELECT
        DATE_TRUNC('day', created_at AT TIME ZONE 'UTC')::date::text AS date,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN amount_received::numeric ELSE 0 END)::text, '0') AS total_received
      FROM orders
      WHERE created_at >= NOW() - INTERVAL '7 days'
      GROUP BY 1
      ORDER BY 1 ASC
    `);
    return rows;
  });

  app.get('/api/v1/admin/incidents', { preHandler: adminAuthMiddleware }, async () => {
    const db = getDb();
    const rows = await db
      .select({
        id: orderEvents.id,
        createdAt: orderEvents.createdAt,
        eventType: orderEvents.eventType,
        payload: orderEvents.payload,
        orderId: orderEvents.orderId,
        orderStatus: orders.status,
        externalId: orders.externalId,
        merchantName: merchants.name,
      })
      .from(orderEvents)
      .leftJoin(orders, eq(orderEvents.orderId, orders.id))
      .leftJoin(merchants, eq(orders.merchantId, merchants.id))
      .where(sql`${orderEvents.eventType} in ('webhook_failed', 'sweep_failed')`)
      .orderBy(desc(orderEvents.createdAt))
      .limit(10);

    return {
      data: rows.map((r) => ({
        id: r.id,
        created_at: r.createdAt,
        event_type: r.eventType,
        payload: r.payload,
        order_id: r.orderId,
        order_status: r.orderStatus,
        external_id: r.externalId,
        merchant_name: r.merchantName,
      })),
    };
  });

  // ─── Orders ─────────────────────────────────────────────────────────────────

  const ordersQuerySchema = z.object({
    page: z.string().optional().default('1').transform(Number),
    limit: z.string().optional().default('20').transform((v) => Math.min(Number(v), 100)),
    status: z.string().optional(),
    merchant_id: z.string().uuid().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
  });

  app.get('/api/v1/admin/orders', { preHandler: adminAuthMiddleware }, async (req, reply) => {
    // Dual-accept: support both `merchant_id` and `merchantId` query keys.
    const rawQuery = (req.query ?? {}) as Record<string, string | undefined>;
    const normalizedQuery = {
      ...rawQuery,
      merchant_id: rawQuery.merchant_id ?? rawQuery.merchantId,
    };
    const parsed = ordersQuerySchema.safeParse(normalizedQuery);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query params', code: 'INVALID_QUERY' });
    }
    const { page, limit, status, merchant_id, from, to } = parsed.data;

    const conditions = [];
    if (status) conditions.push(eq(orders.status, status));
    if (merchant_id) conditions.push(eq(orders.merchantId, merchant_id));
    if (from) conditions.push(gte(orders.createdAt, new Date(from)));
    if (to) conditions.push(lte(orders.createdAt, new Date(to)));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const db = getDb();
    const [rows, [countRow]] = await Promise.all([
      db
        .select({
          id: orders.id,
          externalId: orders.externalId,
          merchantId: orders.merchantId,
          merchantName: merchants.name,
          address: orders.address,
          amountExpected: orders.amountExpected,
          amountPayable: orders.amountPayable,
          tail: orders.tail,
          amountReceived: orders.amountReceived,
          status: orders.status,
          paymentStatus: orders.paymentStatus,
          txHash: orders.txHash,
          createdAt: orders.createdAt,
          expiresAt: orders.expiresAt,
        })
        .from(orders)
        .leftJoin(merchants, eq(orders.merchantId, merchants.id))
        .where(where)
        .orderBy(desc(orders.createdAt))
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ total: count() }).from(orders).where(where),
    ]);

    return {
      data: rows.map((r) => ({
        id: r.id,
        external_id: r.externalId,
        merchant_id: r.merchantId,
        merchant_name: r.merchantName,
        address: r.address,
        amount_expected: r.amountExpected,
        amount_payable: r.amountPayable ?? r.amountExpected,
        tail: r.tail,
        amount_received: r.amountReceived,
        status: r.status,
        payment_status: getPaymentStatus(r),
        tx_hash: r.txHash,
        created_at: r.createdAt,
        expires_at: r.expiresAt,
      })),
      pagination: {
        page,
        limit,
        total: countRow.total,
        total_pages: Math.ceil(countRow.total / limit),
      },
    };
  });

  app.get<{ Params: { id: string } }>(
    '/api/v1/admin/orders/:id',
    { preHandler: adminAuthMiddleware },
    async (req, reply) => {
      const db = getDb();
      const [order] = await db.select().from(orders).where(eq(orders.id, req.params.id));
      if (!order) return reply.code(404).send({ error: 'Order not found', code: 'NOT_FOUND' });

      const [events, txRows, addressRows, deliveries, sweeps] = await Promise.all([
        db
          .select()
          .from(orderEvents)
          .where(eq(orderEvents.orderId, order.id))
          .orderBy(orderEvents.createdAt),
        order.txHash
          ? db.select().from(transactions).where(eq(transactions.txHash, order.txHash))
          : Promise.resolve([]),
        db
          .select({
            sweepTxHash: addresses.sweepTxHash,
            lastSweptAt: addresses.lastSweptAt,
          })
          .from(addresses)
          .where(eq(addresses.address, order.address)),
        db.select({ status: webhookDeliveries.status, leaseUntil: webhookDeliveries.leaseUntil })
          .from(webhookDeliveries).where(eq(webhookDeliveries.orderId, order.id)),
        db.select({ status: sweepJobs.status, nextAttemptAt: sweepJobs.nextAttemptAt })
          .from(sweepJobs).where(eq(sweepJobs.orderId, order.id)),
      ]);

      const tx = txRows[0] ?? null;
      const settlement = addressRows[0] ?? null;

      return {
        order: {
          id: order.id,
          merchant_id: order.merchantId,
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
          expires_at: order.expiresAt,
          created_at: order.createdAt,
          updated_at: order.updatedAt,
        },
        events: events.map((e) => ({
          id: e.id,
          order_id: e.orderId,
          event_type: e.eventType,
          payload: e.payload,
          created_at: e.createdAt,
        })),
        transaction: tx
          ? {
              id: tx.id,
              tx_hash: tx.txHash,
              from_address: tx.fromAddress,
              to_address: tx.toAddress,
              amount: tx.amount,
              contract_addr: tx.contractAddr,
              block_number: tx.blockNumber,
              confirmations: tx.confirmations,
              order_id: tx.orderId,
              detected_at: tx.detectedAt,
              confirmed_at: tx.confirmedAt,
            }
          : null,
        settlement: settlement
          ? {
              sweep_tx_hash: settlement.sweepTxHash,
              last_swept_at: settlement.lastSweptAt,
            }
          : null,
        meta: getSystemMeta(),
        recovery: getAdminRecovery(order.status, getSystemMeta().sweep_enabled, deliveries[0], sweeps[0]),
      };
    },
  );

  app.post<{ Params: { id: string }; Body: { callback_url?: string; callbackUrl?: string } }>(
    '/api/v1/admin/orders/:id/retry-webhook',
    { preHandler: adminAuthMiddleware },
    async (req, reply) => {
      try {
        // Optional callback_url override lets admin redirect a stuck retry
        // to a sandbox/forwarder when the merchant's original endpoint is
        // dead. The override is one-shot — never persisted on the order.
        const overrideUrl = req.body?.callback_url ?? req.body?.callbackUrl;
        if (overrideUrl !== undefined && (typeof overrideUrl !== 'string' || !/^https?:\/\//i.test(overrideUrl))) {
          return reply.code(400).send({ error: 'callback_url must be an http(s) URL', code: 'VALIDATION_ERROR' });
        }
        await orderEngine.retryWebhook(req.params.id, { callbackUrl: overrideUrl });
        return { ok: true };
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'NOT_FOUND') {
          return reply.code(404).send({ error: 'Order not found', code });
        }
        if (code === 'INVALID_STATE') {
          return reply.code(409).send({ error: 'Order is not eligible for webhook retry', code });
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/admin/orders/:id/retry-sweep',
    { preHandler: adminAuthMiddleware },
    async (req, reply) => {
      try {
        await orderEngine.retrySweep(req.params.id);
        return { ok: true };
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'NOT_FOUND') {
          return reply.code(404).send({ error: 'Order not found', code });
        }
        if (code === 'INVALID_STATE' || code === 'SWEEP_DISABLED') {
          return reply.code(409).send({
            error: code === 'SWEEP_DISABLED' ? 'Sweep is not enabled' : 'Order is not eligible for sweep retry',
            code,
          });
        }
        throw err;
      }
    },
  );

  // ─── Merchants ──────────────────────────────────────────────────────────────

  app.get('/api/v1/admin/merchants', { preHandler: adminAuthMiddleware }, async () => {
    const db = getDb();
    const [rows, orderCounts] = await Promise.all([
      db
        .select({
          id: merchants.id,
          name: merchants.name,
          apiKeyPrefix: merchants.apiKeyPrefix,
          isActive: merchants.isActive,
          createdAt: merchants.createdAt,
        })
        .from(merchants)
        .orderBy(desc(merchants.createdAt)),
      db.select({ merchantId: orders.merchantId, c: count() }).from(orders).groupBy(orders.merchantId),
    ]);

    const countMap = new Map(orderCounts.map((r) => [r.merchantId, r.c]));
    return {
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        api_key_prefix: r.apiKeyPrefix,
        is_active: r.isActive,
        created_at: r.createdAt,
        order_count: countMap.get(r.id) ?? 0,
      })),
    };
  });

  app.post('/api/v1/admin/merchants', { preHandler: adminAuthMiddleware }, async (req, reply) => {
    const bodySchema = z.object({
      name: z.string().min(1).max(255),
      webhook_secret: z.string().min(8).max(255),
    });
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const normalized = {
      name: pickField<string>(raw, 'name', 'name'),
      webhook_secret: pickField<string>(raw, 'webhook_secret', 'webhookSecret'),
    };
    const parsed = bodySchema.safeParse(normalized);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', code: 'INVALID_BODY' });
    }

    const { rawKey, prefix, hash } = generateApiKey();
    const db = getDb();
    const [merchant] = await db
      .insert(merchants)
      .values({
        name: parsed.data.name,
        apiKeyHash: hash,
        apiKeyPrefix: prefix,
        webhookSecret: parsed.data.webhook_secret,
      })
      .returning();

    return reply.code(201).send({
      id: merchant.id,
      name: merchant.name,
      api_key: rawKey,
      api_key_prefix: merchant.apiKeyPrefix,
      webhook_secret: merchant.webhookSecret,
      is_active: merchant.isActive,
      created_at: merchant.createdAt,
    });
  });

  app.get<{ Params: { id: string } }>(
    '/api/v1/admin/merchants/:id',
    { preHandler: adminAuthMiddleware },
    async (req, reply) => {
      const db = getDb();
      const merchantId = req.params.id;

      const [merchant] = await db
        .select({
          id: merchants.id,
          name: merchants.name,
          apiKeyPrefix: merchants.apiKeyPrefix,
          isActive: merchants.isActive,
          createdAt: merchants.createdAt,
        })
        .from(merchants)
        .where(eq(merchants.id, merchantId));

      if (!merchant) {
        return reply.code(404).send({ error: 'Merchant not found', code: 'NOT_FOUND' });
      }

      const [statsRows, recentOrders, incidents] = await Promise.all([
        db
          .select({
            orderCount: count(),
            completedCount:
              sql<number>`COUNT(*) FILTER (WHERE ${orders.status} = 'completed')`,
            callbackFailedCount:
              sql<number>`COUNT(*) FILTER (WHERE ${orders.status} = 'callback_failed')`,
            activeOrderCount:
              sql<number>`COUNT(*) FILTER (WHERE ${orders.status} IN ('pending', 'detected', 'confirmed', 'underpaid', 'overpaid', 'callback_sent'))`,
            totalReceived:
              sql<string>`COALESCE(SUM(CASE WHEN ${orders.status} = 'completed' THEN ${orders.amountReceived}::numeric ELSE 0 END)::text, '0')`,
            lastOrderAt: sql<string | null>`MAX(${orders.createdAt})::text`,
          })
          .from(orders)
          .where(eq(orders.merchantId, merchantId)),
        db
          .select({
            id: orders.id,
            externalId: orders.externalId,
            amountExpected: orders.amountExpected,
            amountPayable: orders.amountPayable,
            tail: orders.tail,
            amountReceived: orders.amountReceived,
            status: orders.status,
            txHash: orders.txHash,
            createdAt: orders.createdAt,
          })
          .from(orders)
          .where(eq(orders.merchantId, merchantId))
          .orderBy(desc(orders.createdAt))
          .limit(10),
        db
          .select({
            id: orderEvents.id,
            createdAt: orderEvents.createdAt,
            eventType: orderEvents.eventType,
            payload: orderEvents.payload,
            orderId: orderEvents.orderId,
            orderStatus: orders.status,
            externalId: orders.externalId,
          })
          .from(orderEvents)
          .leftJoin(orders, eq(orderEvents.orderId, orders.id))
          .where(and(eq(orders.merchantId, merchantId), sql`${orderEvents.eventType} in ('webhook_failed', 'sweep_failed')`))
          .orderBy(desc(orderEvents.createdAt))
          .limit(10),
      ]);

      const stats = statsRows[0] ?? {
        orderCount: 0,
        completedCount: 0,
        callbackFailedCount: 0,
        activeOrderCount: 0,
        totalReceived: '0',
        lastOrderAt: null,
      };

      const successRate =
        stats.orderCount > 0 ? ((stats.completedCount / stats.orderCount) * 100).toFixed(2) : '0.00';

      return {
        merchant: {
          id: merchant.id,
          name: merchant.name,
          api_key_prefix: merchant.apiKeyPrefix,
          is_active: merchant.isActive,
          created_at: merchant.createdAt,
        },
        stats: {
          order_count: stats.orderCount,
          completed_count: stats.completedCount,
          callback_failed_count: stats.callbackFailedCount,
          active_order_count: stats.activeOrderCount,
          total_received: stats.totalReceived,
          last_order_at: stats.lastOrderAt,
          success_rate: successRate,
          incident_count: incidents.length,
        },
        recent_orders: recentOrders.map((r) => ({
          id: r.id,
          external_id: r.externalId,
          amount_expected: r.amountExpected,
          amount_payable: r.amountPayable ?? r.amountExpected,
          tail: r.tail,
          amount_received: r.amountReceived,
          status: r.status,
          payment_status: getPaymentStatus(r),
          tx_hash: r.txHash,
          created_at: r.createdAt,
        })),
        incidents: incidents.map((i) => ({
          id: i.id,
          created_at: i.createdAt,
          event_type: i.eventType,
          payload: i.payload,
          order_id: i.orderId,
          order_status: i.orderStatus,
          external_id: i.externalId,
        })),
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/admin/merchants/:id/rotate-api-key',
    { preHandler: adminAuthMiddleware },
    async (req, reply) => {
      const { rawKey, prefix, hash } = generateApiKey();
      const db = getDb();
      const [merchant] = await db
        .update(merchants)
        .set({ apiKeyHash: hash, apiKeyPrefix: prefix })
        .where(eq(merchants.id, req.params.id))
        .returning({
          id: merchants.id,
          name: merchants.name,
          apiKeyPrefix: merchants.apiKeyPrefix,
        });

      if (!merchant) {
        return reply.code(404).send({ error: 'Merchant not found', code: 'NOT_FOUND' });
      }

      return reply.send({
        id: merchant.id,
        name: merchant.name,
        api_key: rawKey,
        api_key_prefix: merchant.apiKeyPrefix,
      });
    },
  );

  app.put<{ Params: { id: string } }>(
    '/api/v1/admin/merchants/:id',
    { preHandler: adminAuthMiddleware },
    async (req, reply) => {
      const bodySchema = z.object({
        name: z.string().min(1).max(255).optional(),
        is_active: z.boolean().optional(),
        webhook_secret: z.string().min(8).max(255).optional(),
      });
      const raw = (req.body ?? {}) as Record<string, unknown>;
      const normalized = {
        name: pickField<string>(raw, 'name', 'name'),
        is_active: pickField<boolean>(raw, 'is_active', 'isActive'),
        webhook_secret: pickField<string>(raw, 'webhook_secret', 'webhookSecret'),
      };
      const parsed = bodySchema.safeParse(normalized);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request body', code: 'INVALID_BODY' });
      }

      const updates: Partial<Pick<NewMerchant, 'name' | 'isActive' | 'webhookSecret'>> = {};
      if (parsed.data.name !== undefined) updates.name = parsed.data.name;
      if (parsed.data.is_active !== undefined) updates.isActive = parsed.data.is_active;
      if (parsed.data.webhook_secret !== undefined) updates.webhookSecret = parsed.data.webhook_secret;

      if (Object.keys(updates).length === 0) {
        return reply.code(400).send({ error: 'Nothing to update', code: 'EMPTY_UPDATE' });
      }

      const db = getDb();
      const [updated] = await db
        .update(merchants)
        .set(updates)
        .where(eq(merchants.id, req.params.id))
        .returning({
          id: merchants.id,
          name: merchants.name,
          apiKeyPrefix: merchants.apiKeyPrefix,
          isActive: merchants.isActive,
          createdAt: merchants.createdAt,
        });

      if (!updated) return reply.code(404).send({ error: 'Merchant not found', code: 'NOT_FOUND' });
      return {
        id: updated.id,
        name: updated.name,
        api_key_prefix: updated.apiKeyPrefix,
        is_active: updated.isActive,
        created_at: updated.createdAt,
      };
    },
  );

  // ─── Wallet ─────────────────────────────────────────────────────────────────

  app.get('/api/v1/admin/wallet', { preHandler: adminAuthMiddleware }, async () => {
    const db = getDb();
    const [poolRows, sweepCounts] = await Promise.all([
      db
        .select({
          total: count(),
          free: sql<number>`COUNT(*) FILTER (WHERE ${addresses.isAllocated} = false)`,
          allocated: sql<number>`COUNT(*) FILTER (WHERE ${addresses.isAllocated} = true)`,
        })
        .from(addresses),
      fundSweeper.getQueueCounts(),
    ]);

    let hotWallet: {
      address: string;
      trx_balance: string;
      is_low_balance: boolean;
    } | null = null;
    if (env.HOT_WALLET_KEY) {
      const hotAddress = TronWeb.address.fromPrivateKey(env.HOT_WALLET_KEY) as string;
      const trxSun = await gasManager.tronWeb.trx.getBalance(hotAddress);
      hotWallet = {
        address: hotAddress,
        trx_balance: (trxSun / 1_000_000).toFixed(6),
        is_low_balance: trxSun / 1_000_000 < env.HOT_WALLET_ALERT_TRX,
      };
    }

    return {
      hot_wallet: hotWallet,
      cold_wallet: env.COLD_WALLET_ADDRESS ? { address: env.COLD_WALLET_ADDRESS } : null,
      address_pool: {
        total: poolRows[0].total,
        free: poolRows[0].free,
        allocated: poolRows[0].allocated,
      },
      sweep_queue: sweepCounts,
      system: getSystemMeta(),
    };
  });
}
