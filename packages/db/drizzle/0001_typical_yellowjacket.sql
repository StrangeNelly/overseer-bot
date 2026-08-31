ALTER TABLE "tokens" ADD COLUMN "revived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "last_snapshot_at" timestamp with time zone;