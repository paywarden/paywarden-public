import { Decimal } from 'decimal.js';
import { fetch } from 'undici';
import { TronWeb } from 'tronweb';
import { z } from 'zod';
import { NETWORK, USDT_MULTIPLIER } from '../config/constants.js';
import { env } from '../config/env.js';
import { isTransferOfContract } from '../utils/tron-address.js';
import type { OrderEngine } from './order-engine.js';
import { findWatchedRecipients } from './watched-addresses.js';

const MAX_PAGES_PER_BLOCK = 10;
const tronAddressHex = z.string().regex(/^(?:0x)?[0-9a-f]{40}$/i);
const contractEvent = z.object({
  block_number: z.int().nonnegative(),
  block_timestamp: z.int().nonnegative(),
  transaction_id: z.string().min(1),
  result: z.object({
    from: tronAddressHex,
    to: tronAddressHex,
    value: z.string().regex(/^\d+$/),
  }),
});
const eventPage = z.object({
  success: z.literal(true),
  data: z.array(z.looseObject({ block_number: z.int().nonnegative() })),
  meta: z.object({ fingerprint: z.string().min(1).optional() }).optional(),
});
type ContractEvent = z.infer<typeof contractEvent>;

function tronGridOptions() {
  return {
    headers: { 'TRON-PRO-API-KEY': env.TRONGRID_API_KEY },
    signal: AbortSignal.timeout(10_000),
  };
}

export async function getConfirmedChainHead(): Promise<number> {
  const res = await fetch(`${NETWORK.trongridUrl}/walletsolidity/getnowblock`, tronGridOptions());
  if (!res.ok) throw new Error(`TronGrid confirmed block height returned HTTP ${res.status}`);

  const block = (await res.json()) as { block_header?: { raw_data?: { number?: unknown } } };
  return z.int().nonnegative().parse(block?.block_header?.raw_data?.number);
}

async function fetchUsdtTransfersInBlock(blockNum: number): Promise<ContractEvent[]> {
  const transfers: ContractEvent[] = [];
  const seenCursors = new Set<string>();
  const params = new URLSearchParams({
    event_name: 'Transfer',
    block_number: String(blockNum),
    only_confirmed: 'true',
    limit: '200',
  });

  for (let page = 1; page <= MAX_PAGES_PER_BLOCK; page++) {
    const url = `${NETWORK.trongridUrl}/v1/contracts/${env.USDT_CONTRACT}/events?${params}`;
    const res = await fetch(url, tronGridOptions());
    if (!res.ok)
      throw new Error(`TronGrid block ${blockNum} page ${page} returned HTTP ${res.status}`);

    const { data, meta } = eventPage.parse(await res.json());
    if (data.some((event) => event.block_number !== blockNum)) {
      throw new Error(`TronGrid returned events from another height for block ${blockNum}`);
    }
    for (const event of data) {
      if (isTransferOfContract(event.event_name, event.contract_address, env.USDT_CONTRACT)) {
        transfers.push(contractEvent.parse(event));
      }
    }

    const cursor = meta?.fingerprint;
    if (!cursor) return transfers;
    if (seenCursors.has(cursor)) {
      throw new Error(`TronGrid repeated a pagination cursor for block ${blockNum}`);
    }
    seenCursors.add(cursor);
    params.set('fingerprint', cursor);
  }

  throw new Error(`TronGrid pagination limit reached before finishing block ${blockNum}`);
}

function toTronAddress(hex: string): string {
  return TronWeb.address.fromHex('41' + hex.replace(/^0x/i, ''));
}

export async function scanConfirmedBlock(
  blockNum: number,
  engine: Pick<OrderEngine, 'onPaymentDetected'>,
): Promise<void> {
  const transfers = await fetchUsdtTransfersInBlock(blockNum);
  if (transfers.length === 0) return;

  const recipients = new Map(transfers.map(({ result }) => [result.to, toTronAddress(result.to)]));
  // Query issued HD addresses, including old orders that left the pending set.
  // The same lookup supports automatic replay and an operator's historical backfill.
  const watched = await findWatchedRecipients([...new Set(recipients.values())]);

  for (const transfer of transfers) {
    const address = recipients.get(transfer.result.to);
    if (!address || !watched.has(address)) continue;
    const amount = new Decimal(transfer.result.value).div(USDT_MULTIPLIER).toFixed(6);
    await engine.onPaymentDetected(
      transfer.transaction_id,
      address,
      amount,
      toTronAddress(transfer.result.from),
      blockNum,
      transfer.block_timestamp,
    );
  }
}
