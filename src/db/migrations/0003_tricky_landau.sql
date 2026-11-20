CREATE TABLE "scan_state" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"value" varchar(255) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
