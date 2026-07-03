CREATE TABLE IF NOT EXISTS "strategy_revision" (
	"id" text PRIMARY KEY NOT NULL,
	"strategy_profile_id" text NOT NULL,
	"version" integer NOT NULL,
	"base_revision_id" text,
	"hypothesis_ids" jsonb NOT NULL,
	"dropped" jsonb,
	"merged_rule_set" jsonb NOT NULL,
	"bundle_artifact_ref" jsonb,
	"bundle_hash" text,
	"combo_backtest_run_id" text,
	"status" text NOT NULL,
	"metrics" jsonb,
	"verdict_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "strategy_revision_profile_version_uq" ON "strategy_revision" USING btree ("strategy_profile_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "strategy_revision_profile_status_idx" ON "strategy_revision" USING btree ("strategy_profile_id","status");