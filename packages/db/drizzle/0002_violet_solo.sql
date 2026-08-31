ALTER TABLE "calls" ADD COLUMN "died_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "death_reason" text;