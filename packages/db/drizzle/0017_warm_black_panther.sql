CREATE TABLE "deployer_watches" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "deployer_watches_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"group_id" integer NOT NULL,
	"address" text NOT NULL,
	"kind" text NOT NULL,
	"added_by" bigint NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	"status" text DEFAULT 'active' NOT NULL,
	"last_nonce" integer,
	"nonce_checked_at" timestamp with time zone,
	"fired_address" text,
	"fired_token_id" integer,
	"fired_at" timestamp with time zone,
	"fired_via" text,
	"fired_tx_hash" text
);
--> statement-breakpoint
ALTER TABLE "deployer_watches" ADD CONSTRAINT "deployer_watches_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployer_watches" ADD CONSTRAINT "deployer_watches_fired_token_id_tokens_id_fk" FOREIGN KEY ("fired_token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deployer_watches_group_address_uq" ON "deployer_watches" USING btree ("group_id",lower("address"));--> statement-breakpoint
CREATE INDEX "deployer_watches_status_idx" ON "deployer_watches" USING btree ("status");