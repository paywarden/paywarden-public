CREATE TABLE "merchant_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"address" varchar(42) NOT NULL,
	"label" varchar(64),
	"role" varchar(10) DEFAULT 'sub' NOT NULL,
	"status" varchar(20) DEFAULT 'pending_confirm' NOT NULL,
	"confirmed_at" timestamp with time zone,
	"test_tx_hash" varchar(66),
	"activated_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_addresses_address_unique" UNIQUE("address")
);
--> statement-breakpoint
CREATE TABLE "unmatched_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tx_hash" varchar(66) NOT NULL,
	"merchant_id" uuid,
	"address" varchar(42) NOT NULL,
	"amount" varchar(78) NOT NULL,
	"from_address" varchar(42) NOT NULL,
	"block_number" bigint NOT NULL,
	"block_timestamp" timestamp with time zone,
	"reason" varchar(32) DEFAULT 'no_pending_order_for_tail' NOT NULL,
	"claimed_order_id" uuid,
	"claimed_by" varchar(64),
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unmatched_transfers_tx_hash_unique" UNIQUE("tx_hash")
);
--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "derivation_idx" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tail" varchar(4);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "amount_payable" varchar(78);--> statement-breakpoint
ALTER TABLE "merchant_addresses" ADD CONSTRAINT "merchant_addresses_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unmatched_transfers" ADD CONSTRAINT "unmatched_transfers_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unmatched_transfers" ADD CONSTRAINT "unmatched_transfers_claimed_order_id_orders_id_fk" FOREIGN KEY ("claimed_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "merchant_addresses_merchant_id_idx" ON "merchant_addresses" USING btree ("merchant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_addresses_default_uq" ON "merchant_addresses" USING btree ("merchant_id") WHERE "merchant_addresses"."role" = 'default';--> statement-breakpoint
CREATE INDEX "unmatched_transfers_merchant_id_idx" ON "unmatched_transfers" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "unmatched_transfers_unclaimed_idx" ON "unmatched_transfers" USING btree ("created_at") WHERE "unmatched_transfers"."claimed_order_id" IS NULL;--> statement-breakpoint
CREATE INDEX "order_events_order_id_idx" ON "order_events" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "orders_address_idx" ON "orders" USING btree ("address");--> statement-breakpoint
CREATE INDEX "orders_tx_hash_idx" ON "orders" USING btree ("tx_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_pending_address_tail_uq" ON "orders" USING btree ("address","tail") WHERE "orders"."status" = 'pending' AND "orders"."tail" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "transactions_order_id_idx" ON "transactions" USING btree ("order_id");