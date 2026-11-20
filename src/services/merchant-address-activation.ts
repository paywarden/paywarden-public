import { and, eq } from 'drizzle-orm';
import { Decimal } from 'decimal.js';
import { getDb } from '../db/index.js';
import { merchantAddresses, transactions } from '../db/schema.js';
import type { MerchantAddress } from '../db/schema.js';
import { ADDRESS_STATUS, ADDRESS_TEST_MIN_USDT } from '../config/constants.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * A pending_test address received an inbound transfer. Records it (any size)
 * and activates the address when the amount meets the minimum. Returns true
 * only when the address was activated by this call.
 */
export async function activateAddress(
  merchantAddress: MerchantAddress,
  txHash: string,
  amount: string,
  fromAddress: string,
  blockNumber: number,
): Promise<boolean> {
  const db = getDb();

  return db.transaction(async (tx) => {
    // Record the transfer regardless of size so the scanner does not
    // re-process it next cycle (idempotency anchor is transactions.tx_hash).
    await tx
      .insert(transactions)
      .values({
        txHash,
        fromAddress,
        toAddress: merchantAddress.address,
        amount,
        contractAddr: env.USDT_CONTRACT,
        blockNumber,
        orderId: null,
      })
      .onConflictDoNothing();

    if (new Decimal(amount).lt(ADDRESS_TEST_MIN_USDT)) {
      logger.info(
        { address: merchantAddress.address, txHash, amount, min: ADDRESS_TEST_MIN_USDT },
        'Test transfer below minimum — address stays pending_test',
      );
      return false;
    }

    const [updated] = await tx
      .update(merchantAddresses)
      .set({
        status: ADDRESS_STATUS.ACTIVE,
        testTxHash: txHash,
        activatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(merchantAddresses.id, merchantAddress.id),
          eq(merchantAddresses.status, ADDRESS_STATUS.PENDING_TEST),
        ),
      )
      .returning({ id: merchantAddresses.id });

    if (!updated) return false;

    logger.info(
      { merchantId: merchantAddress.merchantId, address: merchantAddress.address, txHash, amount },
      'Merchant address activated by test transfer',
    );
    return true;
  });
}
