CREATE TABLE "subscription_quota_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"subscription_id" text NOT NULL,
	"request_id" text,
	"amount" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "subscription_quota_ledger_user_id_idx" ON "subscription_quota_ledger" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_quota_ledger_user_request_uniq" ON "subscription_quota_ledger" USING btree ("user_id","request_id") WHERE request_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription" DROP COLUMN "last_consume_request_id";