import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { adminAuthMiddleware } from '../middleware/admin-auth.js';
import { getDb } from '../../db/index.js';
import { merchants } from '../../db/schema.js';
import { generateApiKey } from '../../utils/api-key.js';
import { logger } from '../../utils/logger.js';

const createMerchantSchema = z.object({
  name: z.string().min(1).max(255),
  webhook_secret: z.string().min(10),
});

const updateMerchantSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  is_active: z.boolean().optional(),
});

/**
 * Merchant management routes.
 * All routes require a valid merchant API key (any active merchant can manage merchants).
 * Phase 2B: admin-level auth via JWT will replace this in the Dashboard phase.
 */
export function registerMerchantRoutes(app: FastifyInstance): void {
  // POST /api/v1/merchants — create new merchant
  app.post(
    '/api/v1/merchants',
    { preHandler: adminAuthMiddleware },
    async (req, reply) => {
      // Dual-accept: support both snake_case and camelCase field names
      // during the contract transition.
      const rawBody = (req.body ?? {}) as Record<string, unknown>;
      const normalizedBody = {
        name: rawBody.name,
        webhook_secret: rawBody.webhook_secret ?? rawBody.webhookSecret,
      };
      const body = createMerchantSchema.safeParse(normalizedBody);
      if (!body.success) {
        return reply.code(400).send({
          error: body.error.issues[0]?.message ?? 'Invalid request body',
          code: 'VALIDATION_ERROR',
        });
      }

      const { name, webhook_secret } = body.data;
      const { rawKey, prefix, hash } = generateApiKey();

      const db = getDb();
      const [merchant] = await db
        .insert(merchants)
        .values({
          name,
          apiKeyHash: hash,
          apiKeyPrefix: prefix,
          webhookSecret: webhook_secret,
        })
        .returning();

      logger.info({ merchantId: merchant.id, name }, 'New merchant created');

      // Return raw API key ONCE — it is never stored in plaintext
      return reply.code(201).send({
        id: merchant.id,
        name: merchant.name,
        api_key: rawKey,   // shown once only
        is_active: merchant.isActive,
        created_at: merchant.createdAt.toISOString(),
      });
    },
  );

  // GET /api/v1/merchants — list all merchants
  app.get(
    '/api/v1/merchants',
    { preHandler: adminAuthMiddleware },
    async (_req, reply) => {
      const db = getDb();
      const rows = await db.select({
        id: merchants.id,
        name: merchants.name,
        apiKeyPrefix: merchants.apiKeyPrefix,
        isActive: merchants.isActive,
        createdAt: merchants.createdAt,
      }).from(merchants);

      return reply.send({
        data: rows.map((m) => ({
          id: m.id,
          name: m.name,
          api_key_prefix: `pw_${m.apiKeyPrefix}...`,
          is_active: m.isActive,
          created_at: m.createdAt.toISOString(),
        })),
        total: rows.length,
      });
    },
  );

  // PUT /api/v1/merchants/:id — update name or active status
  app.put<{ Params: { id: string } }>(
    '/api/v1/merchants/:id',
    { preHandler: adminAuthMiddleware },
    async (req, reply) => {
      const rawBody = (req.body ?? {}) as Record<string, unknown>;
      const normalizedBody = {
        name: rawBody.name,
        is_active: rawBody.is_active ?? rawBody.isActive,
      };
      const body = updateMerchantSchema.safeParse(normalizedBody);
      if (!body.success) {
        return reply.code(400).send({
          error: body.error.issues[0]?.message ?? 'Invalid request body',
          code: 'VALIDATION_ERROR',
        });
      }

      const updates: Record<string, unknown> = {};
      if (body.data.name !== undefined) updates.name = body.data.name;
      if (body.data.is_active !== undefined) updates.isActive = body.data.is_active;

      if (Object.keys(updates).length === 0) {
        return reply.code(400).send({ error: 'No fields to update', code: 'VALIDATION_ERROR' });
      }

      const db = getDb();
      const [updated] = await db
        .update(merchants)
        .set(updates)
        .where(eq(merchants.id, req.params.id))
        .returning();

      if (!updated) {
        return reply.code(404).send({ error: 'Merchant not found', code: 'NOT_FOUND' });
      }

      logger.info({ merchantId: updated.id, updates }, 'Merchant updated');
      return reply.send({
        id: updated.id,
        name: updated.name,
        is_active: updated.isActive,
        updated_at: new Date().toISOString(),
      });
    },
  );
}

