CREATE TABLE "apple_iap_transaction" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"transaction_id" text NOT NULL,
	"original_transaction_id" text NOT NULL,
	"product_id" text NOT NULL,
	"bundle_id" text NOT NULL,
	"environment" text NOT NULL,
	"app_account_token" text,
	"purchase_date" timestamp NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"price_micros" integer,
	"currency" text,
	"flux_amount" integer NOT NULL,
	"flux_credited" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "apple_iap_transaction_transaction_id_unique" UNIQUE("transaction_id")
);
--> statement-breakpoint
ALTER TABLE "apple_iap_transaction" ADD CONSTRAINT "apple_iap_transaction_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;