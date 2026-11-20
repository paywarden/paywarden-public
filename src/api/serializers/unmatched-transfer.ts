import type { UnmatchedTransfer } from '../../db/schema.js';

/** unmatched_transfers row → snake_case API shape. */
export function serializeUnmatchedTransfer(row: UnmatchedTransfer) {
  return {
    id: row.id,
    tx_hash: row.txHash,
    merchant_id: row.merchantId,
    address: row.address,
    amount: row.amount,
    from_address: row.fromAddress,
    block_number: row.blockNumber,
    block_timestamp: row.blockTimestamp?.toISOString() ?? null,
    reason: row.reason,
    claimed_order_id: row.claimedOrderId,
    claimed_by: row.claimedBy,
    claimed_at: row.claimedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}
