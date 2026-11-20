import { Queue, Worker, type Job } from 'bullmq';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { getDb } from '../db/index.js';
import { orderEvents } from '../db/schema.js';
import { EVENT_TYPE } from '../config/constants.js';
import { ChainExecutionError } from './chain-transactions.js';
import { ensureSweepIntent, recoverSweepIntents } from './sweep-intents.js';
import { runDurableSweep } from './sweep-executor.js';
import type { WalletService } from './wallet.js';
import type { GasManager } from './gas-manager.js';
import type { Notifier } from './notifier.js';

const QUEUE_NAME = 'fund-sweep';
const JOB_NAME = 'sweep';
const IN_FLIGHT_JOB_STATES = new Set(['waiting', 'waiting-children', 'delayed', 'active', 'paused']);

interface SweepJobData {
  orderId: string;
}

export class FundSweeper {
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private notifier: Notifier | null = null;

  constructor(
    private readonly wallet: WalletService,
    private readonly gasManager: GasManager,
    private readonly redisUrl: string,
  ) {}

  setNotifier(notifier: Notifier): void {
    this.notifier = notifier;
  }

  init(): void {
    if (!this.isSweepEnabled()) return;
    this.queue = new Queue(QUEUE_NAME, {
      connection: { url: this.redisUrl },
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 200,
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
      },
    });

    this.worker = new Worker(QUEUE_NAME, (job: Job) => this.processJob(job), {
      connection: { url: this.redisUrl },
      concurrency: 1, // sequential: one sweep at a time
    });

    this.worker.on('failed', (job, err) => {
      const orderId = (job?.data as SweepJobData | undefined)?.orderId;
      const attempts = job?.opts.attempts ?? 1;
      const attemptsMade = job?.attemptsMade ?? 0;

      logger.error(
        { jobId: job?.id, orderId, attemptsMade, attempts, err },
        'Sweep job permanently failed — address remains allocated for manual review',
      );

      if (orderId && (err instanceof ChainExecutionError || attemptsMade >= attempts)) {
        const reason = err instanceof Error ? err.message : String(err);
        if (!(err instanceof ChainExecutionError)) this.recordFailedSweep(orderId, reason, attemptsMade)
          .catch((dbErr) => logger.error({ orderId, dbErr }, 'Failed to record sweep failure event'));
        this.notifier
          ?.notify({ type: 'sweep_failed', orderId, reason })
          .catch((notifyErr) => logger.error({ notifyErr }, 'Failed to send sweep failure notification'));
      }
    });

    logger.info('Fund sweeper initialized');
  }

  isSweepEnabled(): boolean {
    // Static-address mode has no key material on the server — nothing to sign with.
    if (env.ADDRESS_MODE === 'static') return false;
    return !!(env.HOT_WALLET_KEY && env.COLD_WALLET_ADDRESS);
  }

  async getQueueCounts(): Promise<{ waiting: number; active: number; failed: number }> {
    if (!this.queue) return { waiting: 0, active: 0, failed: 0 };
    const counts = await this.queue.getJobCounts('waiting', 'active', 'failed');
    return { waiting: counts.waiting ?? 0, active: counts.active ?? 0, failed: counts.failed ?? 0 };
  }

  /** Queue a sweep job for an order with sweeping enabled. */
  async queueSweep(orderId: string, options: { retry?: boolean } = {}): Promise<void> {
    if (!this.isSweepEnabled()) {
      logger.debug({ orderId }, 'Sweep disabled');
      return;
    }

    if (!this.queue) throw new Error('FundSweeper not initialized — call init() first');
    if (!await ensureSweepIntent(orderId, options.retry)) {
      if (options.retry) throw Object.assign(new Error('Sweep is not due or requires chain reconciliation'), { code: 'INVALID_STATE' });
      return;
    }

    const existing = await this.queue.getJob(`sweep-${orderId}`);
    if (existing) {
      const state = await existing.getState();
      if (IN_FLIGHT_JOB_STATES.has(state)) {
        logger.info({ orderId, state }, 'Sweep already in flight for this order — skipping enqueue');
        return;
      }
      // State is completed/failed/unknown — the slot is held by a stale job
      // that BullMQ would otherwise refuse to overwrite (jobId dedup is
      // active until removeOnComplete/removeOnFail evicts it). Drop it so
      // the add() below actually creates a new job. Without this, admin
      // retrySweep() against a sweep_failed order would silently no-op
      // because the failed job sits in the failed set up to removeOnFail.
      await existing.remove();
      logger.info({ orderId, previousState: state }, 'Removed stale sweep job before re-enqueue');
    }

    // Stable jobId is the last line of defence — BullMQ rejects duplicate
    // jobIds while the job is still tracked, catching any race that slips
    // past the checks above (two callers both seeing getJob() === undefined
    // simultaneously). BullMQ jobIds must NOT contain a colon — see
    // https://docs.bullmq.io/guide/jobs/job-ids — so we use a hyphen
    // separator. Once a job has been evicted via removeOnComplete the
    // durable sweep status prevents constructing a replacement transaction.
    await this.queue.add(JOB_NAME, { orderId } satisfies SweepJobData, {
      jobId: `sweep-${orderId}`,
      delay: 0,
    });

    logger.info({ orderId, delayMs: env.SWEEP_DELAY_MS }, 'Sweep queued');
  }

  async recoverPending(): Promise<void> {
    if (this.isSweepEnabled()) await recoverSweepIntents((orderId) => this.queueSweep(orderId));
  }

  private async processJob(job: Job<SweepJobData>): Promise<void> {
    if (!this.isSweepEnabled()) return;
    await runDurableSweep(job.data.orderId, this.wallet, this.gasManager);
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }

  private async recordFailedSweep(orderId: string, reason: string, attemptsMade: number): Promise<void> {
    const db = getDb();
    await db.insert(orderEvents).values({
      orderId,
      eventType: EVENT_TYPE.SWEEP_FAILED,
      payload: {
        reason,
        attempts_made: attemptsMade,
      },
    });
  }
}
