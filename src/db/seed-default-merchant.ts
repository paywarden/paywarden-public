import { createHmac } from 'crypto';
import { sql, isNull } from 'drizzle-orm';
import { getDb } from './index.js';
import { merchants, orders } from './schema.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { extractPrefix } from '../utils/api-key.js';

/**
 * On first boot of a fresh database, create a default merchant whose API key
 * matches `env.API_KEY`. This avoids the "Invalid API key" trap for new users
 * following the README, where the shipped .env has an API_KEY with no
 * corresponding row in the DB.
 *
 * Skipped when:
 *  - any merchant already exists (idempotent on subsequent boots), OR
 *  - any order with merchant_id IS NULL exists (legacy single-tenant DB that
 *    still needs `pnpm migrate:multi-merchant` to back-fill). Seeding here
 *    would otherwise tombstone the migration script and leave historical
 *    orders unreachable from merchant-scoped routes.
 *
 * Concurrency: this races against parallel boots on the same fresh DB. We
 * rely on the merchants.api_key_hash UNIQUE index — `onConflictDoNothing`
 * makes the loser of the race a no-op instead of crashing on startup.
 */
export async function seedDefaultMerchantIfEmpty(): Promise<void> {
  const db = getDb();

  // ALWAYS check for legacy half-migrated state first, regardless of
  // whether merchants already exist. A previous migration attempt (or
  // manual SQL fix) may have created merchant rows but failed to back-fill
  // historical orders, leaving merchant_id IS NULL on the old data. Early
  // returning on merchantCount > 0 — as an earlier draft did — would mean
  // this fail-fast never triggers on the exact half-migrated DBs it was
  // written to catch, and the API silently boots with invisible historical
  // orders unreachable from merchant-scoped routes.
  const [{ count: legacyOrderCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(orders)
    .where(isNull(orders.merchantId));

  if (Number(legacyOrderCount) > 0) {
    logger.fatal(
      { legacyOrderCount: Number(legacyOrderCount) },
      'Legacy orders without merchant_id detected — refusing to start. ' +
        'Run `pnpm migrate:multi-merchant` to back-fill, then restart.',
    );
    process.exit(1);
  }

  const [{ count: merchantCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(merchants);

  if (Number(merchantCount) > 0) return;

  const hash = createHmac('sha256', env.HMAC_SECRET).update(env.API_KEY).digest('hex');
  const prefix = extractPrefix(env.API_KEY);

  // onConflictDoNothing wins the race safely: if another boot inserted the
  // same api_key_hash first, we silently no-op instead of dying on startup.
  const inserted = await db
    .insert(merchants)
    .values({
      name: 'Default Merchant',
      apiKeyHash: hash,
      apiKeyPrefix: prefix,
      webhookSecret: env.WEBHOOK_SECRET,
    })
    .onConflictDoNothing({ target: merchants.apiKeyHash })
    .returning({ id: merchants.id });

  if (inserted.length > 0) {
    logger.info(
      { prefix: `pw_${prefix}...` },
      'Seeded default merchant from env.API_KEY (first boot)',
    );
  }
}
