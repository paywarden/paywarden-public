import { Queue, Worker, type Job } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { getDb } from '../db/index.js';
import { scanState } from '../db/schema.js';
import { REDIS_KEYS, SCAN_STATE_LAST_SCANNED_BLOCK } from '../config/constants.js';
import type { OrderEngine } from './order-engine.js';
import { getConfirmedChainHead, scanConfirmedBlock } from './block-scanner.js';
import { scanForPayments } from './address-scanner.js';
import { checkConfirmations } from './confirmation-checker.js';
import { collectWatchedAddresses } from './watched-addresses.js';

const QUEUE_NAME = 'chain-watcher';
const JOB_NAME = 'scan';
const CONFIRM_JOB_NAME = 'check-confirmations';
const MAX_BLOCKS_PER_SCAN = 5;
const BLOCK_REPLAY_DEPTH = 5;
const BLOCK_SCAN_FAILURE_THRESHOLD = 5; // fallback to address scan after N consecutive failures

let queue: Queue | null = null;
let worker: Worker | null = null;
let orderEngine: OrderEngine | null = null;
let redis: Redis | null = null;
let consecutiveBlockScanFailures = 0;
let retryBlockScanAt = 0;

export function initChainWatcher(
  redisUrl: string,
  engine: OrderEngine,
  redisInstance?: Redis,
): void {
  orderEngine = engine;
  redis = redisInstance ?? null;
  consecutiveBlockScanFailures = 0;
  retryBlockScanAt = 0;

  queue = new Queue(QUEUE_NAME, {
    connection: { url: redisUrl },
    defaultJobOptions: { removeOnComplete: 10, removeOnFail: 50 },
  });

  worker = new Worker(QUEUE_NAME, processJob, {
    connection: { url: redisUrl },
    concurrency: 1,
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, name: job?.name, err }, 'Chain watcher job failed');
  });

  logger.info({ scanMode: env.SCAN_MODE }, 'Chain watcher initialized');
}

export async function startChainWatcher(): Promise<void> {
  if (!queue) throw new Error('Chain watcher not initialized');

  const repeatableJobs = await queue.getRepeatableJobs();
  for (const job of repeatableJobs) {
    await queue.removeRepeatableByKey(job.key);
  }

  await queue.add(JOB_NAME, {}, { repeat: { every: env.SCAN_INTERVAL }, jobId: 'chain-scan' });
  await queue.add(CONFIRM_JOB_NAME, {}, { repeat: { every: 15_000 }, jobId: 'confirm-check' });

  logger.info(
    { scanInterval: env.SCAN_INTERVAL, scanMode: env.SCAN_MODE },
    'Chain watcher started',
  );
}

export function isChainWatcherRunning(): boolean {
  return worker !== null && !worker.closing;
}

export async function closeChainWatcher(): Promise<void> {
  await worker?.close();
  await queue?.close();
  worker = null; queue = null;
}

/** Rebuild the pending_addresses Redis Set from DB on startup. */
export async function rebuildPendingAddressSet(redisInstance: Redis): Promise<void> {
  const watched = await collectWatchedAddresses();

  await redisInstance.del(REDIS_KEYS.PENDING_ADDRESSES);
  if (watched.size > 0) {
    await redisInstance.sadd(REDIS_KEYS.PENDING_ADDRESSES, ...watched.keys());
  }
  logger.info({ count: watched.size }, 'Rebuilt pending_addresses Set from DB');
}

async function processJob(job: Job): Promise<void> {
  if (job.name === JOB_NAME) {
    if (env.SCAN_MODE === 'address') {
      await scanForPayments(orderEngine!);
    } else if (Date.now() >= retryBlockScanAt) {
      await scanForPaymentsByBlock(orderEngine!);
    } else if (consecutiveBlockScanFailures >= BLOCK_SCAN_FAILURE_THRESHOLD) {
      await scanForPayments(orderEngine!);
    }
  } else if (job.name === CONFIRM_JOB_NAME) {
    await checkConfirmations(orderEngine!);
  }
}

async function persistCheckpoint(blockNum: number): Promise<void> {
  await getDb()
    .insert(scanState)
    .values({ key: SCAN_STATE_LAST_SCANNED_BLOCK, value: String(blockNum), updatedAt: new Date() })
    .onConflictDoUpdate({
      target: scanState.key,
      set: { value: String(blockNum), updatedAt: new Date() },
      setWhere: sql`${scanState.value}::bigint < ${blockNum}`,
    });
}

async function mirrorCheckpoint(blockNum: number): Promise<void> {
  try {
    await redis?.set(REDIS_KEYS.LAST_SCANNED_BLOCK, blockNum);
  } catch (err) {
    logger.warn({ err, blockNum }, 'Could not mirror the PostgreSQL scan checkpoint to Redis');
  }
}

async function getOrInitLastScannedBlock(confirmedHead: number): Promise<number> {
  // The old implementation wrote Redis first. Always resume from PostgreSQL
  // so a stale or ahead-of-database Redis value cannot skip a block.
  const db = getDb();
  let [row] = await db
    .select({ value: scanState.value })
    .from(scanState)
    .where(eq(scanState.key, SCAN_STATE_LAST_SCANNED_BLOCK));

  if (!row) {
    // If two workers start together, keep the checkpoint established by the
    // first one. A later head must not move the start past unread blocks.
    [row] = await db
      .insert(scanState)
      .values({ key: SCAN_STATE_LAST_SCANNED_BLOCK, value: String(confirmedHead - 1) })
      .onConflictDoUpdate({ target: scanState.key, set: { value: scanState.value } })
      .returning({ value: scanState.value });
    logger.info({ checkpoint: row.value }, 'Initialized the PostgreSQL block scan checkpoint');
  }

  const checkpoint = Number(row.value);
  if (!Number.isSafeInteger(checkpoint) || checkpoint < -1) {
    throw new Error('Invalid PostgreSQL block scan checkpoint');
  }
  await mirrorCheckpoint(checkpoint);
  return checkpoint;
}

async function scanForPaymentsByBlock(engine: OrderEngine): Promise<void> {
  let blockNum: number | undefined;
  try {
    const confirmedHead = await getConfirmedChainHead();
    const lastScanned = await getOrInitLastScannedBlock(confirmedHead);
    const toBlock = Math.min(confirmedHead, lastScanned + MAX_BLOCKS_PER_SCAN);

    if (confirmedHead - lastScanned > MAX_BLOCKS_PER_SCAN) {
      logger.warn({ confirmedHead, lastScanned }, 'Confirmed block scan is catching up');
    }

    for (let height = lastScanned + 1; height <= toBlock; height++) {
      blockNum = height;
      // Read every height again after five more confirmed blocks to catch
      // events that arrived late in the provider index.
      if (height >= BLOCK_REPLAY_DEPTH) {
        await scanConfirmedBlock(height - BLOCK_REPLAY_DEPTH, engine);
      }
      await scanConfirmedBlock(height, engine);
      await persistCheckpoint(height);
      await mirrorCheckpoint(height);
    }

    consecutiveBlockScanFailures = 0;
    retryBlockScanAt = 0;
  } catch (err) {
    consecutiveBlockScanFailures++;
    const delayMs = Math.min(1_000 * 2 ** consecutiveBlockScanFailures, 30_000);
    retryBlockScanAt = Date.now() + delayMs;
    logger.error(
      { err, blockNum, consecutiveFailures: consecutiveBlockScanFailures, delayMs },
      'Confirmed block scan failed, resuming from the durable checkpoint on retry',
    );
  }
}
