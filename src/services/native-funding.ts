import { and, eq, inArray } from 'drizzle-orm';
import type { TronWeb, Types } from 'tronweb';
import { getDb } from '../db/index.js';
import { nativeFunding, orderEvents } from '../db/schema.js';
import type { NativeFunding } from '../db/schema.js';
import { ChainExecutionError, getChainOutcome, type ExpectedNativeTransfer } from './chain-transactions.js';

export interface NativeFundingScope { orderId: string; fundingId: string }
type Purpose = 'activation' | 'gas';
type Wait = (hash: string, expected: ExpectedNativeTransfer) => Promise<void>;

async function prepare(
  tronWeb: TronWeb, scope: NativeFundingScope, purpose: Purpose, address: string,
  fromAddress: string, amountSun: string, key: string, needed: () => Promise<boolean>,
): Promise<NativeFunding> {
  if (!scope?.orderId || !scope.fundingId) throw new Error('Durable funding scope is required');
  // This transaction intentionally commits independently of sweep preparation.
  return getDb().transaction(async (tx) => {
    await tx.insert(nativeFunding).values({ ...scope, purpose, address, fromAddress, amountSun }).onConflictDoNothing();
    const [operation] = await tx.select().from(nativeFunding).where(and(
      eq(nativeFunding.fundingId, scope.fundingId), eq(nativeFunding.purpose, purpose),
    )).for('update');
    if (!operation) throw new Error('Unresolved native funding for this address requires reconciliation');
    if (operation.orderId !== scope.orderId || operation.address !== address) throw new Error('Native funding scope mismatch');
    if (operation.status !== 'pending') return operation;
    if (!await needed()) {
      const [skipped] = await tx.update(nativeFunding).set({ status: 'skipped', updatedAt: new Date() })
        .where(eq(nativeFunding.id, operation.id)).returning();
      return skipped;
    }
    const amount = Number(amountSun);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Invalid native funding amount');
    const unsigned = await tronWeb.transactionBuilder.sendTrx(address, amount, fromAddress);
    const signed = await tronWeb.trx.sign(unsigned, key);
    const expiration = signed.raw_data.expiration;
    if (!/^[0-9a-f]{64}$/i.test(signed.txID) || !Number.isSafeInteger(expiration) || expiration <= Date.now()) {
      throw new Error('Invalid or expired native funding transaction');
    }
    const [prepared] = await tx.update(nativeFunding).set({
      status: 'prepared', txHash: signed.txID, signedTransaction: signed as unknown as Record<string, unknown>,
      expiresAt: new Date(expiration), updatedAt: new Date(),
    }).where(eq(nativeFunding.id, operation.id)).returning();
    await tx.insert(orderEvents).values({ orderId: scope.orderId, eventType: 'native_funding_prepared',
      payload: { funding_id: scope.fundingId, purpose, tx_hash: signed.txID, address, from_address: fromAddress, amount_sun: amountSun } });
    return prepared;
  });
}

async function finish(operation: NativeFunding, status: 'confirmed' | 'failed' | 'unknown', reason: string | null = null): Promise<void> {
  await getDb().transaction(async (tx) => {
    const [changed] = await tx.update(nativeFunding).set({ status, lastError: reason?.slice(0, 2048) ?? null, updatedAt: new Date() })
      .where(and(eq(nativeFunding.id, operation.id), inArray(nativeFunding.status, ['prepared', 'broadcast', 'unknown']))).returning();
    if (changed && status !== 'unknown') await tx.insert(orderEvents).values({
      orderId: operation.orderId, eventType: `native_funding_${status}`,
      payload: { funding_id: operation.fundingId, purpose: operation.purpose, tx_hash: operation.txHash, reason },
    });
  });
}

export async function fundNative(
  tronWeb: TronWeb, scope: NativeFundingScope, purpose: Purpose, address: string,
  fromAddress: string, amountSun: string, key: string, needed: () => Promise<boolean>, wait: Wait,
): Promise<boolean> {
  const operation = await prepare(tronWeb, scope, purpose, address, fromAddress, amountSun, key, needed);
  if (operation.status === 'skipped') return false;
  if (operation.status === 'confirmed') return true;
  if (operation.status === 'failed') throw new ChainExecutionError(operation.lastError ?? 'Native funding execution failed');
  if (!operation.txHash || !operation.signedTransaction) throw new Error('Incomplete durable native funding');
  const expected = { from: operation.fromAddress, to: operation.address, amountSun: operation.amountSun };
  try {
    const outcome = await getChainOutcome(operation.txHash, 'trx', expected);
    if (outcome.status === 'failed') throw new ChainExecutionError(outcome.reason);
    if (outcome.status === 'success') { await finish(operation, 'confirmed'); return true; }
    if (operation.expiresAt && operation.expiresAt.getTime() > Date.now()) {
      const response = await tronWeb.trx.sendRawTransaction(operation.signedTransaction as unknown as Types.SignedTransaction);
      if (!response.result && !['DUP_TRANSACTION_ERROR', '5'].includes(String(response.code))) {
        throw new Error('Native funding broadcast response: ' + response.code);
      }
      await getDb().update(nativeFunding).set({ status: 'broadcast', updatedAt: new Date() })
        .where(and(eq(nativeFunding.id, operation.id), inArray(nativeFunding.status, ['prepared', 'broadcast', 'unknown'])));
    }
    await wait(operation.txHash, expected);
    await finish(operation, 'confirmed');
    return true;
  } catch (error) {
    await finish(operation, error instanceof ChainExecutionError ? 'failed' : 'unknown',
      error instanceof Error ? error.message : String(error));
    throw error;
  }
}
