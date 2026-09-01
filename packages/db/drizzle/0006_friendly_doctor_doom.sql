CREATE TABLE "sleeper_entries" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sleeper_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"scan_at" timestamp with time zone NOT NULL,
	"band_lo_usd" double precision NOT NULL,
	"band_hi_usd" double precision NOT NULL,
	"rank" integer NOT NULL,
	"address" text NOT NULL,
	"symbol" text,
	"name" text,
	"image_url" text,
	"twitter_url" text,
	"website_url" text,
	"pool_address" text NOT NULL,
	"mcap_usd" double precision NOT NULL,
	"vol24_usd" double precision NOT NULL,
	"liquidity_usd" double precision NOT NULL,
	"txns24" integer NOT NULL,
	"turnover" double precision NOT NULL,
	"pool_created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sleeper_seen" (
	"address" text PRIMARY KEY NOT NULL,
	"first_listed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_listed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "sleeper_entries_scan_idx" ON "sleeper_entries" USING btree ("scan_at","band_lo_usd","rank");--> statement-breakpoint
CREATE INDEX "sleeper_seen_last_listed_idx" ON "sleeper_seen" USING btree ("last_listed_at");