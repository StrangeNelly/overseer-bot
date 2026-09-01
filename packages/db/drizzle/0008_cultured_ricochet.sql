ALTER TABLE "calls" ADD COLUMN "mcap_at_death" double precision;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "mcap_at_death" double precision;--> statement-breakpoint
CREATE INDEX "watches_group_member_idx" ON "watches" USING btree ("group_id","added_by");