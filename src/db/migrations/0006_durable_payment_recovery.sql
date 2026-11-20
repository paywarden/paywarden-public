CREATE TABLE "sweep_jobs" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"tx_hash" varchar(66),
	"signed_transaction" jsonb,
	"to_address" varchar(42),
	"contract_address" varchar(42),
	"amount" varchar(78) NOT NULL,
	"expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" varchar(2048),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"event_type" varchar(50) NOT NULL,
	"callback_url" varchar(2048) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"receipt" jsonb,
	"last_error" varchar(2048),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_order_id_unique" UNIQUE("order_id")
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_status" varchar(20);--> statement-breakpoint
ALTER TABLE "sweep_jobs" ADD CONSTRAINT "sweep_jobs_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sweep_jobs_due_idx" ON "sweep_jobs" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("status","next_attempt_at");