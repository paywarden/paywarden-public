import type { MerchantAddress } from '../../db/schema.js';

/** merchant_addresses row → snake_case API shape. */
export function serializeMerchantAddress(row: MerchantAddress) {
  return {
    id: row.id,
    merchant_id: row.merchantId,
    address: row.address,
    label: row.label,
    role: row.role,
    status: row.status,
    confirmed_at: row.confirmedAt?.toISOString() ?? null,
    test_tx_hash: row.testTxHash,
    activated_at: row.activatedAt?.toISOString() ?? null,
    disabled_at: row.disabledAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
