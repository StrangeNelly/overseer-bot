ALTER TABLE "calls" ADD COLUMN "death_marked_by" text;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "txns24" integer;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "flat_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "flat_readings" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "flat_last_at" timestamp with time zone;