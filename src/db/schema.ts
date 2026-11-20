import {
  pgTable,
  uuid,
  varchar,
  boolean,
  integer,
  bigint,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { WebhookPayload, WebhookDeliveryContext, WebhookFailureContext } from '../types/payment.js';

// ─── Merchants ────────────────────────────────────────────────────────────────

export const merchants = pgTable('merchants', {
  id:            uuid('id').primaryKey().defaultRandom(),
  name:          varchar('name', { length: 255 }).notNull(),
  apiKeyHash:    varchar('api_key_hash', { length: 128 }).notNull().unique(),
  apiKeyPrefix:  varchar('api_key_prefix', { length: 8 }).notNull(),
  webhookSecret: varchar('webhook_secret', { length: 255 }).notNull(),
  isActive:      boolean('is_active').notNull().default(true),
  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
});

export type Merchant    = typeof merchants.$inferSelect;
export type NewMerchant = typeof merchants.$inferInsert;

export const orders = pgTable('orders', {
  id:             uuid('id').primaryKey().defaultRandom(),
  merchantId:     uuid('merchant_id').references(() => merchants.id),  // nullable for migration
  externalId:     varchar('external_id', { length: 255 }).notNull(),
  address:        varchar('address', { length: 42 }).notNull(),
  // HD derivation index of `address`. NULL for static-address orders
  // (ADDRESS_MODE=static), which have no key material behind them.
  derivationIdx:  integer('derivation_idx'),
  amountExpected: varchar('amount_expected', { length: 78 }).notNull(),
  // Static-address mode only: 4-digit amount tail that tells concurrent
  // orders on the same address apart, and the exact amount the payer must
  // send (amount_expected + 0.00tail). NULL in HD mode — see utils/tail.ts.
  tail:           varchar('tail', { length: 4 }),
  amountPayable:  varchar('amount_payable', { length: 78 }),
  amountReceived: varchar('amount_received', { length: 78 }).notNull().default('0'),
  currency:       varchar('currency', { length: 10 }).notNull().default('USDT'),
  network:        varchar('network', { length: 10 }).notNull().default('TRC20'),
  status:         varchar('status', { length: 20 }).notNull().default('pending'),
  paymentStatus:  varchar('payment_status', { length: 20 }),
  callbackUrl:    varchar('callback_url', { length: 2048 }).notNull(),
  webhookSecret:  varchar('webhook_secret', { length: 255 }).notNull().default(''), // snapshot at creation
  txHash:         varchar('tx_hash', { length: 66 }),
  expiresAt:      timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt:      timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt:      timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => [
  // Hot-path lookups: status sweep every 3s, address on every detection,
  // tx_hash on every confirmation check.
  index('orders_status_idx').on(t.status),
  index('orders_address_idx').on(t.address),
  index('orders_tx_hash_idx').on(t.txHash),
  // Static-address mode invariant: no two pending orders on the same address
  // may share a tail, otherwise an inbound transfer would be ambiguous. The
  // allocator picks a free tail under an advisory lock; this index is the
  // structural backstop for any other write path.
  uniqueIndex('orders_pending_address_tail_uq')
    .on(t.address, t.tail)
    .where(sql`${t.status} = 'pending' AND ${t.tail} IS NOT NULL`),
]);

export const orderEvents = pgTable('order_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id')
    .notNull()
    .references(() => orders.id),
  eventType: varchar('event_type', { length: 50 }).notNull(),
  payload: jsonb('payload').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => [index('order_events_order_id_idx').on(t.orderId)]);

export const addresses = pgTable('addresses', {
  id: uuid('id').primaryKey().defaultRandom(),
  address: varchar('address', { length: 42 }).notNull().unique(),
  derivationIdx: integer('derivation_idx').notNull().unique(),
  isAllocated: boolean('is_allocated').notNull().default(false),
  allocatedTo: uuid('allocated_to').references(() => orders.id),
  lastSweptAt: timestamp('last_swept_at', { withTimezone: true }),
  sweepTxHash: varchar('sweep_tx_hash', { length: 66 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
});

export const transactions = pgTable('transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  txHash: varchar('tx_hash', { length: 66 }).notNull().unique(),
  fromAddress: varchar('from_address', { length: 42 }).notNull(),
  toAddress: varchar('to_address', { length: 42 }).notNull(),
  amount: varchar('amount', { length: 78 }).notNull(),
  contractAddr: varchar('contract_addr', { length: 42 }).notNull(),
  blockNumber: bigint('block_number', { mode: 'number' }).notNull(),
  confirmations: integer('confirmations').notNull().default(0),
  orderId: uuid('order_id').references(() => orders.id),
  detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().default(sql`now()`),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
}, (t) => [index('transactions_order_id_idx').on(t.orderId)]);

// ─── Static-address mode (ADDRESS_MODE=static) ───────────────────────────────

// Receiving addresses registered by merchants themselves. The server never
// holds key material for these — only the public address. Lifecycle:
// pending_confirm → pending_test → active ⇄ disabled (see ADDRESS_STATUS).
export const merchantAddresses = pgTable('merchant_addresses', {
  id: uuid('id').primaryKey().defaultRandom(),
  merchantId: uuid('merchant_id')
    .notNull()
    .references(() => merchants.id),
  // Globally unique: an inbound transfer must map to exactly one merchant.
  address: varchar('address', { length: 42 }).notNull().unique(),
  label: varchar('label', { length: 64 }),
  role: varchar('role', { length: 10 }).notNull().default('sub'),
  status: varchar('status', { length: 20 }).notNull().default('pending_confirm'),
  // Merchant scanned the QR shown by the dashboard and confirmed it matches their wallet.
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  // Inbound test transfer that activated the address.
  testTxHash: varchar('test_tx_hash', { length: 66 }),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => [
  index('merchant_addresses_merchant_id_idx').on(t.merchantId),
  // Exactly one default address per merchant (routes also serialise on an
  // advisory lock; this is the structural guarantee).
  uniqueIndex('merchant_addresses_default_uq')
    .on(t.merchantId)
    .where(sql`${t.role} = 'default'`),
]);

// Inbound USDT transfers to a merchant address that no pending order could be
// credited with (tail mismatch, order already expired, payer rounded the
// amount). Kept for audit and for manual claiming from the dashboard.
export const unmatchedTransfers = pgTable('unmatched_transfers', {
  id: uuid('id').primaryKey().defaultRandom(),
  txHash: varchar('tx_hash', { length: 66 }).notNull().unique(),
  merchantId: uuid('merchant_id').references(() => merchants.id),
  address: varchar('address', { length: 42 }).notNull(),
  amount: varchar('amount', { length: 78 }).notNull(),
  fromAddress: varchar('from_address', { length: 42 }).notNull(),
  blockNumber: bigint('block_number', { mode: 'number' }).notNull(),
  blockTimestamp: timestamp('block_timestamp', { withTimezone: true }),
  // Why it could not be credited automatically (see UnmatchedReason).
  reason: varchar('reason', { length: 32 }).notNull().default('no_pending_order_for_tail'),
  claimedOrderId: uuid('claimed_order_id').references(() => orders.id),
  claimedBy: varchar('claimed_by', { length: 64 }),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => [
  index('unmatched_transfers_merchant_id_idx').on(t.merchantId),
  // Dashboard "awaiting claim" list: newest unclaimed first.
  index('unmatched_transfers_unclaimed_idx')
    .on(t.createdAt)
    .where(sql`${t.claimedOrderId} IS NULL`),
]);

// Durable key-value backup for chain-scan checkpoints. Redis holds the hot
// copy; this table survives Redis flush/failover so a restart never silently
// skips a block range (payments in the gap would otherwise go undetected).
export const scanState = pgTable('scan_state', {
  key: varchar('key', { length: 64 }).primaryKey(),
  value: varchar('value', { length: 255 }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
});

// One immutable payment event per order; Redis is only a delivery accelerator.
export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().unique().references(() => orders.id),
  eventType: varchar('event_type', { length: 50 }).notNull(),
  callbackUrl: varchar('callback_url', { length: 2048 }).notNull(),
  payload: jsonb('payload').$type<WebhookPayload>().notNull(),
  generation: integer('generation').notNull().default(0),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  attempt: integer('attempt').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  leaseToken: uuid('lease_token'),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  receipt: jsonb('receipt').$type<WebhookDeliveryContext>(),
  failure: jsonb('failure').$type<WebhookFailureContext>(),
  lastError: varchar('last_error', { length: 2048 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('webhook_deliveries_due_idx').on(t.status, t.nextAttemptAt)]);

// Prepared signed bytes and txID are committed BEFORE the first broadcast.
// Unknown outcomes never authorize constructing a replacement transaction.
export const sweepJobs = pgTable('sweep_jobs', {
  orderId: uuid('order_id').primaryKey().references(() => orders.id),
  fundingId: uuid('funding_id').notNull().defaultRandom(),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  txHash: varchar('tx_hash', { length: 66 }),
  signedTransaction: jsonb('signed_transaction').$type<Record<string, unknown>>(),
  toAddress: varchar('to_address', { length: 42 }),
  contractAddress: varchar('contract_address', { length: 42 }),
  amount: varchar('amount', { length: 78 }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  lastError: varchar('last_error', { length: 2048 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('sweep_jobs_due_idx').on(t.status, t.nextAttemptAt)]);

// Each sweep funding cycle may activate and top up its address at most once.
// These commits are independent of sweep preparation, which can roll back.
export const nativeFunding = pgTable('native_funding', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => orders.id),
  fundingId: uuid('funding_id').notNull(),
  purpose: varchar('purpose', { length: 16 }).notNull(),
  address: varchar('address', { length: 42 }).notNull(),
  fromAddress: varchar('from_address', { length: 42 }).notNull(),
  amountSun: varchar('amount_sun', { length: 78 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  txHash: varchar('tx_hash', { length: 66 }).unique(),
  signedTransaction: jsonb('signed_transaction').$type<Record<string, unknown>>(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  lastError: varchar('last_error', { length: 2048 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('native_funding_cycle_purpose_uq').on(t.fundingId, t.purpose),
  uniqueIndex('native_funding_unresolved_address_uq').on(t.address, t.purpose)
    .where(sql`${t.status} IN ('pending', 'prepared', 'broadcast', 'unknown')`),
]);

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type OrderEvent = typeof orderEvents.$inferSelect;
export type Address = typeof addresses.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type MerchantAddress = typeof merchantAddresses.$inferSelect;
export type UnmatchedTransfer = typeof unmatchedTransfers.$inferSelect;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type SweepJob = typeof sweepJobs.$inferSelect;
export type NativeFunding = typeof nativeFunding.$inferSelect;
