ALTER TABLE "watches" ADD COLUMN "mcap_at_watch" double precision;--> statement-breakpoint
ALTER TABLE "watches" ADD COLUMN "buy_opp_armed" boolean DEFAULT true NOT NULL;