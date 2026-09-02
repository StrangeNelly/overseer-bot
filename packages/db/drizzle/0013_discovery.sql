CREATE TABLE "chain_cursor" (
	"id" text PRIMARY KEY NOT NULL,
	"last_block" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_alert_decisions" (
	"event_id" integer NOT NULL,
	"group_id" integer NOT NULL,
	"outcome" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discovery_alert_decisions_event_id_group_id_pk" PRIMARY KEY("event_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "discovery_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "discovery_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"token_address" text NOT NULL,
	"pool_address" text NOT NULL,
	"dex" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"block_number" bigint NOT NULL,
	"tx_hash" text NOT NULL,
	"initial_liquidity_eth" double precision,
	"initial_liquidity_usd" double precision,
	"quote_symbol" text,
	"symbol" text,
	"name" text,
	"image_url" text,
	"twitter_url" text,
	"website_url" text,
	"mcap_usd" double precision,
	"liquidity_usd" double precision,
	"lp_locked_pct" double precision,
	"launch_block_pct" double precision,
	"launch_block_wallets" integer,
	"is_stock" boolean DEFAULT false NOT NULL,
	"enriched_at" timestamp with time zone,
	"data_as_of" timestamp with time zone,
	"refresh_attempted_at" timestamp with time zone,
	"lock_attempted_at" timestamp with time zone,
	"lock_checked_at" timestamp with time zone,
	"alerted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discovery_events_pool_address_unique" UNIQUE("pool_address")
);
--> statement-breakpoint
ALTER TABLE "alerts" ALTER COLUMN "token_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "discovery_alert_decisions" ADD CONSTRAINT "discovery_alert_decisions_event_id_discovery_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."discovery_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_alert_decisions" ADD CONSTRAINT "discovery_alert_decisions_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "discovery_decisions_group_idx" ON "discovery_alert_decisions" USING btree ("group_id","outcome");--> statement-breakpoint
CREATE INDEX "discovery_events_kind_at_idx" ON "discovery_events" USING btree ("kind","at");--> statement-breakpoint
CREATE INDEX "discovery_events_enriched_idx" ON "discovery_events" USING btree ("enriched_at","at");--> statement-breakpoint
CREATE INDEX "discovery_events_data_as_of_idx" ON "discovery_events" USING btree ("data_as_of");--> statement-breakpoint
CREATE INDEX "discovery_events_token_idx" ON "discovery_events" USING btree ("token_address");--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_discovery_pool_uq" ON "alerts" USING btree ("group_id","type",("details" ->> 'pool')) WHERE "alerts"."type" in ('launch', 'graduation');