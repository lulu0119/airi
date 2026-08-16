CREATE TABLE "subscription" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_subscription_id" text,
	"plan_key" text NOT NULL,
	"status" text NOT NULL,
	"period_quota_amount" bigint NOT NULL,
	"period_quota_used" bigint DEFAULT 0 NOT NULL,
	"period_quota_updated_at" timestamp DEFAULT now() NOT NULL,
	"use_balance" boolean DEFAULT false NOT NULL,
	"last_consume_request_id" text,
	"provider_data" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "payment_order" ADD COLUMN "plan_key" text;--> statement-breakpoint
ALTER TABLE "llm_request_log" ADD COLUMN "source" text;--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_provider_sub_uidx" ON "subscription" USING btree ("provider","provider_subscription_id") WHERE provider_subscription_id IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "subscription_user_id_idx" ON "subscription" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_user_active_uidx" ON "subscription" USING btree ("user_id") WHERE status = 'active' AND deleted_at IS NULL;
