/**
 * One-time migration: create the default merchant from current env vars
 * and associate all existing orders.
 *
 * Run ONCE after `pnpm db:migrate`:
 *   pnpm migrate:multi-merchant
 */

import { createHmac } from 'crypto';
import { eq, isNull, sql } from 'drizzle-orm';
import { env } from '../config/env.js';
import { getDb } from '../db/index.js';
import { merchants, orders } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import { extractPrefix } from '../utils/api-key.js';

/**
 * Re-runnable: the previous version exited as soon as ANY merchant existed,
 * which left the database tombstoned in a half-migrated state if the script
 * crashed between inserting the default merchant and back-filling orders.
 * Now we:
 *   1. Wrap insert + back-fill in a single transaction
 *   2. Use ON CONFLICT so the merchant insert no-ops on a re-run
 *   3. Always look up the default merchant by api_key_hash (not "any row")
 *   4. Only short-circuit when there are zero legacy orders left to fix
 */
async function main(): Promise<void> {
  const db = getDb();

  const rawKey = env.API_KEY;
  const prefix = extractPrefix(rawKey);
  const apiKeyHash = createHmac('sha256', env.HMAC_SECRET).update(rawKey).digest('hex');

  await db.transaction(async (tx) => {
    // Step 1: ensure the default merchant row exists. ON CONFLICT makes this
    // a no-op on re-run if a previous attempt already inserted it.
    await tx
      .insert(merchants)
      .values({
        name: 'Default',
        apiKeyHash,
        apiKeyPrefix: prefix,
        webhookSecret: env.WEBHOOK_SECRET,
      })
      .onConflictDoNothing({ target: merchants.apiKeyHash });

    // Step 2: look up the merchant by hash so re-runs and partial-failure
    // recovery both find the same row.
    const [defaultMerchant] = await tx
      .select()
      .from(merchants)
      .where(eq(merchants.apiKeyHash, apiKeyHash))
      .limit(1);

    if (!defaultMerchant) {
      throw new Error('Default merchant lookup failed after upsert — schema mismatch?');
    }

    // Step 3: count legacy orders before & after so the operator gets a clear
    // before/after report even on re-runs.
    const [{ count: pending }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(orders)
      .where(isNull(orders.merchantId));

    if (Number(pending) === 0) {
      logger.info({ merchantId: defaultMerchant.id }, 'No legacy orders left to migrate — already complete');
      return;
    }

    // Step 4: back-fill in the same transaction. Failure here aborts the
    // merchant insert too (well, the upsert is idempotent), so re-running
    // is always safe.
    const result = await tx
      .update(orders)
      .set({ merchantId: defaultMerchant.id, webhookSecret: env.WEBHOOK_SECRET })
      .where(isNull(orders.merchantId));

    logger.info(
      {
        merchantId: defaultMerchant.id,
        rowsUpdated: (result as unknown as { rowCount?: number }).rowCount ?? Number(pending),
      },
      'Legacy orders back-filled with default merchant_id',
    );
  });

  logger.info('Migration complete — existing API_KEY continues to work unchanged');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'Migration failed');
    process.exit(1);
  });
