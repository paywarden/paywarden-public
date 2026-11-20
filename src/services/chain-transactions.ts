import { fetch } from 'undici';
import { TronWeb } from 'tronweb';
import { env } from '../config/env.js';
import { NETWORK } from '../config/constants.js';

export interface ExpectedNativeTransfer { from: string; to: string; amountSun: string }
export interface ExpectedTransfer extends ExpectedNativeTransfer { contract: string }
export type ChainOutcome = { status: 'pending' } | { status: 'success' } | { status: 'failed'; reason: string };
export class ChainExecutionError extends Error {}

async function query(path: string, txId: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${NETWORK.trongridUrl}/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'TRON-PRO-API-KEY': env.TRONGRID_API_KEY },
    body: JSON.stringify({ value: txId }), signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Transaction lookup returned HTTP ${response.status}`);
  return await response.json() as Record<string, unknown>;
}

const hex = (value: string) => value.replace(/^0x/i, '').toLowerCase();
const addressHex = (value: string) => hex(TronWeb.address.toHex(value)).slice(-40);
const transferTopic = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function matchesTransfer(log: unknown, expected: ExpectedTransfer): boolean {
  if (!log || typeof log !== 'object') return false;
  const event = log as { address?: unknown; topics?: unknown; data?: unknown };
  if (typeof event.address !== 'string' || !Array.isArray(event.topics) || typeof event.data !== 'string') return false;
  const topics = event.topics;
  return hex(event.address) === addressHex(expected.contract) && topics.length === 3 &&
    typeof topics[0] === 'string' && hex(topics[0]) === transferTopic &&
    typeof topics[1] === 'string' && hex(topics[1]) === addressHex(expected.from).padStart(64, '0') &&
    typeof topics[2] === 'string' && hex(topics[2]) === addressHex(expected.to).padStart(64, '0') &&
    /^[0-9a-f]{64}$/i.test(hex(event.data)) && BigInt('0x' + hex(event.data)) === BigInt(expected.amountSun);
}

/** Pending includes unknown transport/indexing outcomes; it never means safe to replace. */
export async function getChainOutcome(txId: string, kind: 'trx' | 'trc20' = 'trc20', expected?: ExpectedNativeTransfer & { contract?: string }): Promise<ChainOutcome> {
  if (kind === 'trx') {
    const body = await query('walletsolidity/gettransactionbyid', txId);
    if (body.txID !== txId) return { status: 'pending' };
    const ret = body.ret as Array<{ contractRet?: string }> | undefined;
    const result = ret?.[0]?.contractRet;
    if (!result) return { status: 'pending' };
    if (result !== 'SUCCESS') return { status: 'failed', reason: result };
    if (expected) {
      const contracts = (body.raw_data as { contract?: Array<{ type?: string; parameter?: { value?: {
        owner_address?: string; to_address?: string; amount?: number | string;
      } } }> } | undefined)?.contract;
      const transfer = contracts?.[0]; const value = transfer?.parameter?.value;
      if (contracts?.length !== 1 || transfer?.type !== 'TransferContract' ||
          !value?.owner_address || !value.to_address ||
          addressHex(value.owner_address) !== addressHex(expected.from) || addressHex(value.to_address) !== addressHex(expected.to) ||
          (typeof value.amount === 'number' && !Number.isSafeInteger(value.amount)) || String(value.amount) !== expected.amountSun) {
        return { status: 'pending' };
      }
    }
    return { status: 'success' };
  }
  const receipt = await query('walletsolidity/gettransactioninfobyid', txId);
  if (receipt.id !== txId || !Number.isSafeInteger(receipt.blockNumber)) return { status: 'pending' };
  const execution = (receipt.receipt as { result?: string } | undefined)?.result;
  if (receipt.result === 'FAILED' || (execution && execution !== 'SUCCESS')) {
    return { status: 'failed', reason: execution ?? 'FAILED' };
  }
  if (execution !== 'SUCCESS') return { status: 'pending' };
  if (expected && (!expected.contract || !Array.isArray(receipt.log) ||
      !receipt.log.some((log) => matchesTransfer(log, { ...expected, contract: expected.contract! })))) {
    // Execution succeeded but expected business effect is unproved. Never
    // authorize another transfer or mark the existing one complete.
    return { status: 'pending' };
  }
  return { status: 'success' };
}
