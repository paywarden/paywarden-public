import { eq } from 'drizzle-orm';
import { fetch } from 'undici';
import { env } from '../config/env.js';
import { NETWORK, ORDER_STATUS } from '../config/constants.js';
import { getDb } from '../db/index.js';
import { orders } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import type { OrderEngine } from './order-engine.js';

interface TronBlock {
  block_header: { raw_data: { number: number } };
}

export async function checkConfirmations(
  engine: Pick<OrderEngine, 'alertStuckDetected' | 'onPaymentConfirmed'>,
): Promise<void> {
  const db = getDb();

  const detectedOrders = await db
    .select({ txHash: orders.txHash, id: orders.id, updatedAt: orders.updatedAt })
    .from(orders)
    .where(eq(orders.status, ORDER_STATUS.DETECTED));

  if (detectedOrders.length === 0) return;

  const currentBlock = await getCurrentBlockNumber();
  if (currentBlock === null) return;

  const stuckThresholdMs = env.DETECTED_STUCK_HOURS * 3_600_000;

  for (const order of detectedOrders) {
    // Escape hatch for permanent limbo: a detected order whose tx never
    // reaches the confirmation threshold (reorged out, dropped) would sit
    // here forever — the expiry sweep only touches pending orders. Alert-only
    // (deduped in the engine); recovery stays a manual admin decision.
    const stuckMs = Date.now() - order.updatedAt.getTime();
    if (stuckMs > stuckThresholdMs) {
      try {
        await engine.alertStuckDetected(order.id, order.txHash, Math.floor(stuckMs / 3_600_000));
      } catch (err) {
        // Alerting must never abort confirmation checks for the other orders.
        logger.error({ err, orderId: order.id }, 'Error sending stuck-order alert');
      }
    }

    if (!order.txHash) continue;
    try {
      await checkTxConfirmations(order.txHash, currentBlock, engine);
    } catch (err) {
      logger.error({ err, txHash: order.txHash }, 'Error checking confirmations');
    }
  }
}

async function getCurrentBlockNumber(): Promise<number | null> {
  try {
    const response = await fetch(`${NETWORK.trongridUrl}/wallet/getnowblock`, {
      headers: { 'TRON-PRO-API-KEY': env.TRONGRID_API_KEY },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) return null;
    const block = (await response.json()) as TronBlock;
    return block.block_header?.raw_data?.number ?? null;
  } catch {
    return null;
  }
}

async function checkTxConfirmations(
  txHash: string,
  currentBlock: number,
  engine: Pick<OrderEngine, 'onPaymentConfirmed'>,
): Promise<void> {
  const response = await fetch(`${NETWORK.trongridUrl}/wallet/gettransactioninfobyid`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'TRON-PRO-API-KEY': env.TRONGRID_API_KEY,
    },
    body: JSON.stringify({ value: txHash }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) return;

  const tx = (await response.json()) as { blockNumber?: number };
  const blockNumber = tx?.blockNumber;
  if (typeof blockNumber !== 'number' || !Number.isSafeInteger(blockNumber) || blockNumber <= 0 || blockNumber > currentBlock) return;

  const confirmations = currentBlock - blockNumber;

  if (confirmations >= env.MIN_CONFIRMATIONS) {
    logger.info({ txHash, confirmations }, 'Transaction confirmed');
    await engine.onPaymentConfirmed(txHash, confirmations, blockNumber);
  } else {
    logger.debug(
      { txHash, confirmations, needed: env.MIN_CONFIRMATIONS },
      'Waiting for confirmations',
    );
  }
}
