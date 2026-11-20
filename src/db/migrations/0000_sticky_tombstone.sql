CREATE TABLE "addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address" varchar(42) NOT NULL,
	"derivation_idx" integer NOT NULL,
	"is_allocated" boolean DEFAULT false NOT NULL,
	"allocated_to" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "addresses_address_unique" UNIQUE("address"),
	CONSTRAINT "addresses_derivation_idx_unique" UNIQUE("derivation_idx")
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"event_type" varchar(50) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" varchar(255) NOT NULL,
	"address" varchar(42) NOT NULL,
	"derivation_idx" integer NOT NULL,
	"amount_expected" varchar(78) NOT NULL,
	"amount_received" varchar(78) DEFAULT '0' NOT NULL,
	"currency" varchar(10) DEFAULT 'USDT' NOT NULL,
	"network" varchar(10) DEFAULT 'TRC20' NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"callback_url" varchar(2048) NOT NULL,
	"tx_hash" varchar(66),
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tx_hash" varchar(66) NOT NULL,
	"from_address" varchar(42) NOT NULL,
	"to_address" varchar(42) NOT NULL,
	"amount" varchar(78) NOT NULL,
	"contract_addr" varchar(42) NOT NULL,
	"block_number" bigint NOT NULL,
	"confirmations" integer DEFAULT 0 NOT NULL,
	"order_id" uuid,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "transactions_tx_hash_unique" UNIQUE("tx_hash")
);
--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_allocated_to_orders_id_fk" FOREIGN KEY ("allocated_to") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;