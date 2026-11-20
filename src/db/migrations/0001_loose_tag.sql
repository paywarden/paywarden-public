ALTER TABLE "addresses" ADD COLUMN "last_swept_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "addresses" ADD COLUMN "sweep_tx_hash" varchar(66);