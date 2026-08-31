CREATE TABLE "calls" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "calls_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"group_id" integer NOT NULL,
	"token_id" integer NOT NULL,
	"caller_user_id" bigint NOT NULL,
	"caller_name" text NOT NULL,
	"message_id" bigint NOT NULL,
	"called_at" timestamp with time zone NOT NULL,
	"mcap_at_call" double precision,
	"liquidity_at_call" double precision,
	"peak_mcap_since_call" double precision,
	"peak_at" timestamp with time zone,
	"mentions_count" integer DEFAULT 1 NOT NULL,
	"last_mention_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"binned_by" bigint,
	"binned_at" timestamp with time zone,
	"revive_requested" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_members" (
	"group_id" integer NOT NULL,
	"user_id" bigint NOT NULL,
	"status" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_members_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "groups_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"chat_id" bigint NOT NULL,
	"title" text,
	"slug" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groups_chat_id_unique" UNIQUE("chat_id"),
	CONSTRAINT "groups_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "launch_monitors" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "launch_monitors_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"group_id" integer NOT NULL,
	"x_handle" text NOT NULL,
	"added_by" bigint NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mentions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mentions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"call_id" integer NOT NULL,
	"user_id" bigint NOT NULL,
	"user_name" text NOT NULL,
	"message_id" bigint NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"token_id" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"price_usd" double precision,
	"mcap_usd" double precision,
	"liquidity_usd" double precision,
	"vol24_usd" double precision
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tokens_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"chain_id" integer NOT NULL,
	"address" text NOT NULL,
	"symbol" text,
	"name" text,
	"image_url" text,
	"socials" jsonb,
	"launchpad" text,
	"phase" text DEFAULT 'unresolved' NOT NULL,
	"pool_address" text,
	"token_created_at" timestamp with time zone,
	"graduated_at" timestamp with time zone,
	"died_at" timestamp with time zone,
	"death_reason" text,
	"price_usd" double precision,
	"mcap_usd" double precision,
	"liquidity_usd" double precision,
	"vol24_usd" double precision,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_polled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_monitors" ADD CONSTRAINT "launch_monitors_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calls_group_token_uq" ON "calls" USING btree ("group_id","token_id");--> statement-breakpoint
CREATE INDEX "calls_group_activity_idx" ON "calls" USING btree ("group_id","last_mention_at");--> statement-breakpoint
CREATE UNIQUE INDEX "launch_monitors_group_handle_uq" ON "launch_monitors" USING btree ("group_id",lower("x_handle"));--> statement-breakpoint
CREATE UNIQUE INDEX "mentions_call_message_uq" ON "mentions" USING btree ("call_id","message_id");--> statement-breakpoint
CREATE INDEX "snapshots_token_at_idx" ON "snapshots" USING btree ("token_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "tokens_chain_address_uq" ON "tokens" USING btree ("chain_id","address");