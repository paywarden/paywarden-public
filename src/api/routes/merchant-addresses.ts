import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { adminAuthMiddleware } from '../middleware/admin-auth.js';
import { getDb } from '../../db/index.js';
import { merchantAddresses, merchants, unmatchedTransfers } from '../../db/schema.js';
import { ADDRESS_ROLE, ADDRESS_STATUS } from '../../config/constants.js';
import { isValidTronAddress } from '../../utils/tron-address.js';
import { logger } from '../../utils/logger.js';
import type { OrderEngine } from '../../services/order-engine.js';
import { serializeMerchantAddress } from '../serializers/merchant-address.js';
import { serializeUnmatchedTransfer } from '../serializers/unmatched-transfer.js';

/**
 * Static-address mode (ADDRESS_MODE=static) admin routes:
 *   - merchant receiving-address lifecycle
 *       pending_confirm → (confirm) → pending_test → (inbound test transfer, engine) → active ⇄ disabled
 *       any non-disabled → disabled; disabled → active only if it was activated before;
 *       DELETE only while never activated (pending_confirm / pending_test)
 *   - allowlist export for the merchant's own server (addresses.json)
 *   - unmatched transfers listing + manual claim
 *
 * Coded errors are thrown and translated by the global error handler.
 * Default-role exclusivity is guaranteed by the partial unique index
 * merchant_addresses_default_uq; routes also serialise on a per-merchant
 * advisory lock so the demote + set happens without interleaving.
 */

const tronAddress = z
  .string()
  .refine(isValidTronAddress, 'address must be a valid TRON base58 address (T..., 34 chars)');

const roleSchema = z.enum([ADDRESS_ROLE.DEFAULT, ADDRESS_ROLE.SUB, ADDRESS_ROLE.BACKUP]);

const createAddressSchema = z.object({
  address: tronAddress,
  label: z.string().min(1).max(64).optional(),
  role: roleSchema.default(ADDRESS_ROLE.SUB),
});

const updateAddressSchema = z
  .object({
    label: z.string().min(1).max(64).nullable().optional(),
    role: roleSchema.optional(),
    status: z.enum([ADDRESS_STATUS.ACTIVE, ADDRESS_STATUS.DISABLED]).optional(),
  })
  .refine((v) => v.label !== undefined || v.role !== undefined || v.status !== undefined, {
    message: 'No fields to update',
  });

const claimSchema = z.object({
  order_id: z.string().uuid(),
  force: z.boolean().optional(),
});

const unmatchedQuerySchema = z.object({
  merchant_id: z.string().uuid().optional(),
  // false → awaiting claim (default); true → claimed only; all → both
  claimed: z.enum(['false', 'true', 'all']).default('false'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const uuid = z.string().uuid();

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw coded(result.error.issues[0]?.message ?? 'Invalid request', 'VALIDATION_ERROR');
  }
  return result.data;
}

async function requireMerchant(merchantId: string): Promise<void> {
  if (!uuid.safeParse(merchantId).success) throw coded('Merchant not found', 'NOT_FOUND');
  const [m] = await getDb()
    .select({ id: merchants.id })
    .from(merchants)
    .where(eq(merchants.id, merchantId));
  if (!m) throw coded('Merchant not found', 'NOT_FOUND');
}

async function requireAddress(merchantId: string, addressId: string) {
  if (!uuid.safeParse(addressId).success) throw coded('Address not found', 'NOT_FOUND');
  const [row] = await getDb()
    .select()
    .from(merchantAddresses)
    .where(and(eq(merchantAddresses.id, addressId), eq(merchantAddresses.merchantId, merchantId)));
  if (!row) throw coded('Address not found', 'NOT_FOUND');
  return row;
}

export function registerMerchantAddressRoutes(
  app: FastifyInstance,
  deps: { orderEngine: OrderEngine },
): void {
  const { orderEngine } = deps;

  // ─── Address lifecycle ───────────────────────────────────────────────────

  app.get<{ Params: { id: string } }>(
    '/api/v1/admin/merchants/:id/addresses',
    { preHandler: adminAuthMiddleware },
    async (req) => {
      await requireMerchant(req.params.id);
      const rows = await getDb()
        .select()
        .from(merchantAddresses)
        .where(eq(merchantAddresses.merchantId, req.params.id))
        .orderBy(merchantAddresses.createdAt);
      return { data: rows.map(serializeMerchantAddress), total: rows.length };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/admin/merchants/:id/addresses',
    { preHandler: adminAuthMiddleware },
    async (req, reply) => {
      await requireMerchant(req.params.id);
      const body = parseOrThrow(createAddressSchema, req.body ?? {});
      const merchantId = req.params.id;

      const row = await getDb().transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${merchantId}))`);

        if (body.role === ADDRESS_ROLE.DEFAULT) {
          await tx
            .update(merchantAddresses)
            .set({ role: ADDRESS_ROLE.SUB, updatedAt: new Date() })
            .where(
              and(
                eq(merchantAddresses.merchantId, merchantId),
                eq(merchantAddresses.role, ADDRESS_ROLE.DEFAULT),
              ),
            );
        }

        // address is globally unique — a concurrent or repeated registration
        // conflicts here and is reported as 409 rather than a 500.
        const [inserted] = await tx
          .insert(merchantAddresses)
          .values({
            merchantId,
            address: body.address,
            label: body.label ?? null,
            role: body.role,
            status: ADDRESS_STATUS.PENDING_CONFIRM,
          })
          .onConflictDoNothing()
          .returning();
        if (!inserted) throw coded('Address is already registered', 'ADDRESS_EXISTS');
        return inserted;
      });

      logger.info(
        { merchantId, address: row.address, role: row.role },
        'Merchant address registered',
      );
      return reply.code(201).send(serializeMerchantAddress(row));
    },
  );

  // Merchant scanned the QR shown by the dashboard and confirmed it matches
  // their wallet → start watching for the activation test transfer.
  app.post<{ Params: { id: string; addressId: string } }>(
    '/api/v1/admin/merchants/:id/addresses/:addressId/confirm',
    { preHandler: adminAuthMiddleware },
    async (req) => {
      const row = await requireAddress(req.params.id, req.params.addressId);
      if (row.status !== ADDRESS_STATUS.PENDING_CONFIRM) {
        throw coded(`Address is ${row.status}, expected pending_confirm`, 'INVALID_STATE');
      }

      const [updated] = await getDb()
        .update(merchantAddresses)
        .set({
          status: ADDRESS_STATUS.PENDING_TEST,
          confirmedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(merchantAddresses.id, row.id),
            eq(merchantAddresses.status, ADDRESS_STATUS.PENDING_CONFIRM),
          ),
        )
        .returning();
      if (!updated) throw coded('Address state changed concurrently', 'INVALID_STATE');

      // Block-scan set membership is best-effort: the DB is the source of
      // truth and rebuildPendingAddressSet / the address scanner recover it.
      try {
        await orderEngine.registerWatchedAddress(updated.address);
      } catch (err) {
        logger.warn({ err, address: updated.address }, 'Failed to add address to pending set');
      }

      logger.info(
        { merchantId: req.params.id, address: updated.address },
        'Merchant address confirmed — awaiting test transfer',
      );
      return serializeMerchantAddress(updated);
    },
  );

  app.put<{ Params: { id: string; addressId: string } }>(
    '/api/v1/admin/merchants/:id/addresses/:addressId',
    { preHandler: adminAuthMiddleware },
    async (req) => {
      const row = await requireAddress(req.params.id, req.params.addressId);
      const body = parseOrThrow(updateAddressSchema, req.body ?? {});
      const merchantId = req.params.id;

      if (body.status === ADDRESS_STATUS.DISABLED && row.status === ADDRESS_STATUS.DISABLED) {
        throw coded('Address is already disabled', 'INVALID_STATE');
      }
      if (body.status === ADDRESS_STATUS.ACTIVE) {
        if (row.status !== ADDRESS_STATUS.DISABLED) {
          throw coded(`Cannot move address from ${row.status} to active`, 'INVALID_STATE');
        }
        if (!row.activatedAt) {
          throw coded('Address was never activated — it needs a test transfer', 'INVALID_STATE');
        }
      }

      // The default address must be usable: only an active row (or one being
      // re-enabled in this same request) may hold the role.
      const resultingStatus = body.status ?? row.status;
      if (body.role === ADDRESS_ROLE.DEFAULT && resultingStatus !== ADDRESS_STATUS.ACTIVE) {
        throw coded('Only an active address can be the default', 'INVALID_STATE');
      }

      const updated = await getDb().transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${merchantId}))`);

        if (body.role === ADDRESS_ROLE.DEFAULT) {
          await tx
            .update(merchantAddresses)
            .set({ role: ADDRESS_ROLE.SUB, updatedAt: new Date() })
            .where(
              and(
                eq(merchantAddresses.merchantId, merchantId),
                eq(merchantAddresses.role, ADDRESS_ROLE.DEFAULT),
                ne(merchantAddresses.id, row.id),
              ),
            );
        }

        const patch: Partial<typeof merchantAddresses.$inferInsert> = { updatedAt: new Date() };
        if (body.label !== undefined) patch.label = body.label;
        if (body.role !== undefined) patch.role = body.role;
        if (body.status !== undefined) {
          patch.status = body.status;
          patch.disabledAt = body.status === ADDRESS_STATUS.DISABLED ? new Date() : null;
          // A disabled address must not stay the default.
          if (body.status === ADDRESS_STATUS.DISABLED && row.role === ADDRESS_ROLE.DEFAULT) {
            patch.role = ADDRESS_ROLE.SUB;
          }
        }

        const [r] = await tx
          .update(merchantAddresses)
          .set(patch)
          .where(eq(merchantAddresses.id, row.id))
          .returning();
        return r;
      });

      logger.info(
        { merchantId, address: updated.address, patch: body },
        'Merchant address updated',
      );
      return serializeMerchantAddress(updated);
    },
  );

  // Remove a mistyped address before it was ever activated. Active/disabled
  // rows are kept because orders reference the address string.
  app.delete<{ Params: { id: string; addressId: string } }>(
    '/api/v1/admin/merchants/:id/addresses/:addressId',
    { preHandler: adminAuthMiddleware },
    async (req, reply) => {
      const row = await requireAddress(req.params.id, req.params.addressId);
      if (
        row.status !== ADDRESS_STATUS.PENDING_CONFIRM &&
        row.status !== ADDRESS_STATUS.PENDING_TEST
      ) {
        throw coded('Only addresses that were never activated can be deleted', 'INVALID_STATE');
      }
      await getDb().delete(merchantAddresses).where(eq(merchantAddresses.id, row.id));
      logger.info({ merchantId: req.params.id, address: row.address }, 'Merchant address deleted');
      return reply.code(204).send();
    },
  );

  // Allowlist for the merchant's own server (see cloud-watch-only.html §5).
  // Content = active addresses; version = newest updated_at across ALL of
  // the merchant's addresses, so disabling one also bumps the version.
  app.get<{ Params: { id: string } }>(
    '/api/v1/admin/merchants/:id/addresses/export',
    { preHandler: adminAuthMiddleware },
    async (req, reply) => {
      await requireMerchant(req.params.id);
      const rows = await getDb()
        .select()
        .from(merchantAddresses)
        .where(eq(merchantAddresses.merchantId, req.params.id))
        .orderBy(merchantAddresses.createdAt);

      const newest = rows.reduce((max, r) => Math.max(max, r.updatedAt.getTime()), 0);
      const active = rows.filter((r) => r.status === ADDRESS_STATUS.ACTIVE);
      return reply
        .header(
          'Content-Disposition',
          `attachment; filename="paywarden-addresses-${req.params.id}.json"`,
        )
        .header('Cache-Control', 'no-store')
        .send({
          merchant_id: req.params.id,
          generated_at: new Date().toISOString(),
          version: newest > 0 ? new Date(newest).toISOString() : null,
          addresses: active.map((r) => ({ address: r.address, label: r.label, role: r.role })),
        });
    },
  );

  // ─── Unmatched transfers ─────────────────────────────────────────────────

  app.get('/api/v1/admin/unmatched-transfers', { preHandler: adminAuthMiddleware }, async (req) => {
    const query = parseOrThrow(unmatchedQuerySchema, req.query ?? {});
    const filters = [
      query.claimed === 'false' ? isNull(unmatchedTransfers.claimedOrderId) : undefined,
      query.claimed === 'true' ? isNotNull(unmatchedTransfers.claimedOrderId) : undefined,
      query.merchant_id ? eq(unmatchedTransfers.merchantId, query.merchant_id) : undefined,
    ].filter((f): f is NonNullable<typeof f> => f !== undefined);
    const where = filters.length > 0 ? and(...filters) : undefined;

    const db = getDb();
    const [rows, [{ count }]] = await Promise.all([
      db
        .select()
        .from(unmatchedTransfers)
        .where(where)
        .orderBy(desc(unmatchedTransfers.createdAt))
        .limit(query.limit)
        .offset(query.offset),
      db
        .select({ count: sql<number>`count(*)` })
        .from(unmatchedTransfers)
        .where(where),
    ]);

    return {
      data: rows.map(serializeUnmatchedTransfer),
      total: Number(count),
      limit: query.limit,
      offset: query.offset,
    };
  });

  app.post<{ Params: { id: string } }>(
    '/api/v1/admin/unmatched-transfers/:id/claim',
    { preHandler: adminAuthMiddleware },
    async (req) => {
      if (!uuid.safeParse(req.params.id).success) {
        throw coded('Unmatched transfer not found', 'NOT_FOUND');
      }
      const body = parseOrThrow(claimSchema, req.body ?? {});
      await orderEngine.claimUnmatched(req.params.id, body.order_id, {
        claimedBy: 'admin',
        force: body.force === true,
      });
      return { ok: true };
    },
  );
}
