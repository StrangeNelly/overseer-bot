CREATE TABLE "alerts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "alerts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"group_id" integer NOT NULL,
	"token_id" integer NOT NULL,
	"type" text NOT NULL,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"mcap_usd" double precision,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "watches" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "watches_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"group_id" integer NOT NULL,
	"token_id" integer NOT NULL,
	"added_by" bigint NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_cooldown_idx" ON "alerts" USING btree ("group_id","token_id","type","fired_at");--> statement-breakpoint
CREATE UNIQUE INDEX "watches_group_token_uq" ON "watches" USING btree ("group_id","token_id");