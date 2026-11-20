import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import * as schema from './schema.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
      logger.error({ err }, 'Unexpected error on idle database client');
    });
  }
  return pool;
}

export function getDb() {
  return drizzle(getPool(), { schema });
}

export type Db = ReturnType<typeof getDb>;
/** The transaction handle passed to `db.transaction(async (tx) => ...)`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export async function checkDbConnection(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
