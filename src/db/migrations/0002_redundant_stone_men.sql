CREATE TABLE "merchants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"api_key_hash" varchar(128) NOT NULL,
	"api_key_prefix" varchar(8) NOT NULL,
	"webhook_secret" varchar(255) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchants_api_key_hash_unique" UNIQUE("api_key_hash")
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "merchant_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "webhook_secret" varchar(255) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;