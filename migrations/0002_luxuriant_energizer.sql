CREATE TABLE IF NOT EXISTS "hypothesis_proposal" (
	"id" text PRIMARY KEY NOT NULL,
	"strategy_profile_id" text NOT NULL,
	"thesis" text NOT NULL,
	"target_behavior" text NOT NULL,
	"rule_action" jsonb NOT NULL,
	"required_features" jsonb NOT NULL,
	"validation_plan" text NOT NULL,
	"expected_effect" jsonb NOT NULL,
	"invalidation_criteria" jsonb NOT NULL,
	"confidence" real NOT NULL,
	"status" text NOT NULL,
	"fingerprint" text NOT NULL,
	"proposal" jsonb NOT NULL,
	"issues" jsonb NOT NULL,
	"contract_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hypothesis_review" (
	"id" text PRIMARY KEY NOT NULL,
	"hypothesis_id" text NOT NULL,
	"critic_adapter" text NOT NULL,
	"critic_model" text NOT NULL,
	"verdict" text NOT NULL,
	"concerns" jsonb NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hypothesis_proposal_profile_fp_uq" ON "hypothesis_proposal" USING btree ("strategy_profile_id","fingerprint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hypothesis_proposal_profile_idx" ON "hypothesis_proposal" USING btree ("strategy_profile_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hypothesis_proposal_status_idx" ON "hypothesis_proposal" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hypothesis_review_hypothesis_idx" ON "hypothesis_review" USING btree ("hypothesis_id");