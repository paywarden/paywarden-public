CREATE TABLE "native_funding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"funding_id" uuid NOT NULL,
	"purpose" varchar(16) NOT NULL,
	"address" varchar(42) NOT NULL,
	"from_address" varchar(42) NOT NULL,
	"amount_sun" varchar(78) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"tx_hash" varchar(66),
	"signed_transaction" jsonb,
	"expires_at" timestamp with time zone,
	"last_error" varchar(2048),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "native_funding_tx_hash_unique" UNIQUE("tx_hash")
);
--> statement-breakpoint
ALTER TABLE "sweep_jobs" ADD COLUMN "funding_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "native_funding" ADD CONSTRAINT "native_funding_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "native_funding_cycle_purpose_uq" ON "native_funding" USING btree ("funding_id","purpose");--> statement-breakpoint
CREATE UNIQUE INDEX "native_funding_unresolved_address_uq" ON "native_funding" USING btree ("address","purpose") WHERE "native_funding"."status" IN ('pending', 'prepared', 'broadcast', 'unknown');