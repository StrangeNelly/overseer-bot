CREATE TABLE "launch_candidates" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "launch_candidates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"monitor_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"symbol" text,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text DEFAULT 'claims' NOT NULL,
	"post_id" text,
	"post_url" text,
	"posted_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_reason" text
);
--> statement-breakpoint
ALTER TABLE "launch_monitors" ADD COLUMN "x_user_id" text;--> statement-breakpoint
ALTER TABLE "launch_monitors" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "launch_monitors" ADD COLUMN "avatar_url" text;--> statement-breakpoint
ALTER TABLE "launch_monitors" ADD COLUMN "bio" text;--> statement-breakpoint
ALTER TABLE "launch_monitors" ADD COLUMN "followers" integer;--> statement-breakpoint
ALTER TABLE "launch_monitors" ADD COLUMN "followers_at_add" integer;--> statement-breakpoint
ALTER TABLE "launch_monitors" ADD COLUMN "account_created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "launch_monitors" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "launch_monitors" ADD COLUMN "added_message_id" bigint;--> statement-breakpoint
ALTER TABLE "launch_monitors" ADD COLUMN "last_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "launch_monitors" ADD COLUMN "last_post_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "launch_monitors" ADD COLUMN "last_tweet_id" text;--> statement-breakpoint
ALTER TABLE "launch_monitors" ADD COLUMN "provider_rule_id" text;--> statement-breakpoint
ALTER TABLE "launch_monitors" ADD COLUMN "launched_address" text;--> statement-breakpoint
ALTER TABLE "launch_monitors" ADD COLUMN "launched_token_id" integer;--> statement-breakpoint
ALTER TABLE "launch_monitors" ADD COLUMN "launched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "launch_monitors" ADD COLUMN "launch_tweet_id" text;--> statement-breakpoint
ALTER TABLE "launch_monitors" ADD COLUMN "launch_tweet_url" text;--> statement-breakpoint
ALTER TABLE "launch_monitors" ADD COLUMN "launch_pinged" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "launch_monitors" ADD COLUMN "launched_hold_reason" text;--> statement-breakpoint
ALTER TABLE "launch_monitors" ADD COLUMN "launched_token_created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "launch_monitors" ADD COLUMN "profile_refreshed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "launch_monitors" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "launch_candidates" ADD CONSTRAINT "launch_candidates_monitor_id_launch_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."launch_monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "launch_candidates_monitor_token_uq" ON "launch_candidates" USING btree ("monitor_id","token_address");--> statement-breakpoint
CREATE INDEX "launch_candidates_next_attempt_idx" ON "launch_candidates" USING btree ("next_attempt_at");--> statement-breakpoint
ALTER TABLE "launch_monitors" ADD CONSTRAINT "launch_monitors_launched_token_id_tokens_id_fk" FOREIGN KEY ("launched_token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_x_launch_uq" ON "alerts" USING btree ("group_id","type",("details" ->> 'handle'),("details" ->> 'address')) WHERE "alerts"."type" = 'x_launch';--> statement-breakpoint
CREATE INDEX "launch_monitors_group_status_idx" ON "launch_monitors" USING btree ("group_id","status");--> statement-breakpoint
CREATE INDEX "launch_monitors_status_idx" ON "launch_monitors" USING btree ("status");