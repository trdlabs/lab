CREATE TABLE IF NOT EXISTS "paper_submission" (
	"id" text PRIMARY KEY NOT NULL,
	"experiment_id" text NOT NULL,
	"strategy_profile_id" text NOT NULL,
	"submission_status" text NOT NULL,
	"candidate_id" text,
	"admission_status" text,
	"admission_reason_code" text,
	"error" jsonb,
	"idempotency_key" text NOT NULL,
	"bundle_hash" text NOT NULL,
	"params" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "paper_submission_experiment_uq" ON "paper_submission" USING btree ("experiment_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "paper_submission_idempotency_uq" ON "paper_submission" USING btree ("idempotency_key");