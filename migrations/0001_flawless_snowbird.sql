CREATE TABLE IF NOT EXISTS "strategy_profile" (
	"id" text PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"source_kind" text NOT NULL,
	"source_fingerprint" text NOT NULL,
	"direction" text NOT NULL,
	"core_idea" text NOT NULL,
	"required_market_features" jsonb NOT NULL,
	"confidence" real NOT NULL,
	"unknowns" jsonb NOT NULL,
	"profile" jsonb NOT NULL,
	"source_artifact_ref" jsonb NOT NULL,
	"contract_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "strategy_profile_fingerprint_uq" ON "strategy_profile" USING btree ("source_fingerprint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "strategy_profile_source_kind_idx" ON "strategy_profile" USING btree ("source_kind");