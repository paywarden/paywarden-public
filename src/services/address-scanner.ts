import { Decimal } from 'decimal.js';
import { fetch } from 'undici';
import { z } from 'zod';
import { NETWORK, USDT_MULTIPLIER } from '../config/constants.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { isTransferOfContract } from '../utils/tron-address.js';
import type { OrderEngine } from './order-engine.js';
import { collectWatchedAddresses } from './watched-addresses.js';

const addressPage = z.object({
  success: z.literal(true),
  data: z.array(z.looseObject({})),
  meta: z.object({ fingerprint: z.string().min(1).optional() }).optional(),
});
const transfer = z.object({
  transaction_id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  value: z.string().regex(/^\d+$/),
  block_timestamp: z.int().nonnegative(),
});
const tokenInfo = z.object({ address: z.string() });

export async function scanForPayments(
  engine: Pick<OrderEngine, 'onPaymentDetected'>,
): Promise<void> {
  const watched = await collectWatchedAddresses();
  for (const [address, minTimestamp] of watched) {
    try {
      await scanAddress(address, minTimestamp, engine);
    } catch (err) {
      logger.error({ err, address }, 'Error scanning address');
    }
  }
}

async function scanAddress(
  address: string,
  minTimestamp: number,
  engine: Pick<OrderEngine, 'onPaymentDetected'>,
): Promise<void> {
  // Freeze the time range while following cursors; newly indexed transfers
  // are picked up by the next scan. All pages use identical filter values.
  const params = new URLSearchParams({
    only_to: 'true',
    only_confirmed: 'true',
    contract_address: env.USDT_CONTRACT,
    min_timestamp: String(minTimestamp),
    max_timestamp: String(Date.now()),
    order_by: 'block_timestamp,asc',
    limit: '200',
  });
  const cursors = new Set<string>();

  while (true) {
    const url = `${NETWORK.trongridUrl}/v1/accounts/${address}/transactions/trc20?${params}`;
    const response = await fetch(url, {
      headers: { 'TRON-PRO-API-KEY': env.TRONGRID_API_KEY },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`TronGrid address scan returned HTTP ${response.status}`);
    const { data, meta } = addressPage.parse(await response.json());

    for (const record of data) {
      const token = tokenInfo.safeParse(record.token_info);
      if (
        record.to !== address ||
        !token.success ||
        !isTransferOfContract(record.type, token.data.address, env.USDT_CONTRACT)
      )
        continue;
      const tx = transfer.parse(record);
      const amount = new Decimal(tx.value).div(USDT_MULTIPLIER).toFixed(6);
      await engine.onPaymentDetected(
        tx.transaction_id,
        address,
        amount,
        tx.from,
        0,
        tx.block_timestamp,
      );
    }

    const cursor = meta?.fingerprint;
    if (!cursor) return;
    if (cursors.has(cursor))
      throw new Error(`TronGrid repeated an address pagination cursor for ${address}`);
    cursors.add(cursor);
    params.set('fingerprint', cursor);
  }
}
