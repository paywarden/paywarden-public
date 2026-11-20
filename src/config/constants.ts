import { env } from './env.js';

export const TRON_NETWORKS = {
  mainnet: {
    trongridUrl: 'https://api.trongrid.io',
    usdtContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  },
  nile: {
    trongridUrl: 'https://nile.trongrid.io',
    usdtContract: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf',
  },
  shasta: {
    trongridUrl: 'https://api.shasta.trongrid.io',
    usdtContract: 'TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs',
  },
} as const;

export const NETWORK = TRON_NETWORKS[env.TRON_NETWORK];

// BIP44: m/44'/195'/0'/0/{index}
export const BIP44_COIN_TYPE = 195;
export const BIP44_PATH = `m/44'/${BIP44_COIN_TYPE}'/0'/0`;

// USDT has 6 decimals
export const USDT_DECIMALS = 6;
export const USDT_MULTIPLIER = 10 ** USDT_DECIMALS;

export const ORDER_STATUS = {
  PENDING: 'pending',
  DETECTED: 'detected',
  CONFIRMED: 'confirmed',
  CALLBACK_SENT: 'callback_sent',
  COMPLETED: 'completed',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
  UNDERPAID: 'underpaid',
  OVERPAID: 'overpaid',
  CALLBACK_FAILED: 'callback_failed',
} as const;

export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];

export const EVENT_TYPE = {
  ORDER_CREATED: 'order_created',
  PAYMENT_DETECTED: 'payment_detected',
  // Payment seen on-chain that cannot be credited: order expired in the
  // detection race window, or the transfer predates the current order on a
  // reused address (block-scan). No state change — recorded for audit +
  // manual recovery. NOTE: top-up transfers to an already-`detected` order
  // are NOT covered — the scanner only watches pending addresses.
  LATE_PAYMENT_DETECTED: 'late_payment_detected',
  PAYMENT_CONFIRMED: 'payment_confirmed',
  PAYMENT_STATUS_RECONCILED: 'payment_status_reconciled',
  ORDER_EXPIRED: 'order_expired',
  ORDER_CANCELLED: 'order_cancelled',
  WEBHOOK_SENT: 'webhook_sent',
  WEBHOOK_FAILED: 'webhook_failed',
  SWEEP_QUEUED: 'sweep_queued',
  SWEEP_COMPLETED: 'sweep_completed',
  SWEEP_FAILED: 'sweep_failed',
  NATIVE_FUNDING_PREPARED: 'native_funding_prepared',
  NATIVE_FUNDING_CONFIRMED: 'native_funding_confirmed',
  NATIVE_FUNDING_FAILED: 'native_funding_failed',
  SWEEP_FUNDING_RECONCILIATION_REQUIRED: 'sweep_funding_reconciliation_required',
  ADMIN_WEBHOOK_RETRY: 'admin_webhook_retry',
  ADMIN_SWEEP_RETRY: 'admin_sweep_retry',
  // Static-address mode: an unmatched on-chain transfer was manually linked
  // to this order by an operator. Follows the same detected → confirmed path.
  PAYMENT_CLAIMED: 'payment_claimed',
} as const;

export type EventType = (typeof EVENT_TYPE)[keyof typeof EVENT_TYPE];

// ─── Static-address mode (ADDRESS_MODE=static) ───────────────────────────────

// Lifecycle of a merchant-registered receiving address. Forward-only except
// active ⇄ disabled.
export const ADDRESS_STATUS = {
  PENDING_CONFIRM: 'pending_confirm', // format-valid, merchant has not yet confirmed via wallet scan
  PENDING_TEST: 'pending_test', // confirmed, waiting for a small inbound test transfer
  ACTIVE: 'active', // usable for new orders
  DISABLED: 'disabled', // no new orders; pending orders keep being watched until expiry
} as const;

export type AddressStatus = (typeof ADDRESS_STATUS)[keyof typeof ADDRESS_STATUS];

export const ADDRESS_ROLE = {
  DEFAULT: 'default', // exactly one per merchant; first choice for new orders
  SUB: 'sub', // per-product / per-store address
  BACKUP: 'backup', // switched to when the default is frozen
} as const;

export type AddressRole = (typeof ADDRESS_ROLE)[keyof typeof ADDRESS_ROLE];

// Minimum inbound transfer that activates a pending_test address.
export const ADDRESS_TEST_MIN_USDT = '0.1';

export const REDIS_KEYS = {
  PENDING_ADDRESSES: 'paywarden:pending_addresses',
  LAST_SCANNED_BLOCK: 'paywarden:last_scanned_block',
  // Prefix — per-order dedup marker so a stuck-in-detected alert fires once
  // per interval, not on every 15s confirmation sweep.
  STUCK_DETECTED_ALERTED: 'paywarden:stuck_detected_alerted',
} as const;

// Key used in the scan_state table for the persisted block-scan checkpoint
// (durable backup of REDIS_KEYS.LAST_SCANNED_BLOCK).
export const SCAN_STATE_LAST_SCANNED_BLOCK = 'last_scanned_block';

// Address pool: keep at least this many unallocated addresses ready
export const ADDRESS_POOL_MIN = 20;
export const ADDRESS_POOL_REFILL = 50;

// Webhook retry
export const WEBHOOK_MAX_ATTEMPTS = 10;
