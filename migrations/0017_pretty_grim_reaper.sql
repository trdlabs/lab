ALTER TABLE "paper_submission" ADD COLUMN "strategy_name" text;--> statement-breakpoint
ALTER TABLE "paper_submission" ADD COLUMN "paper_run_id" text;--> statement-breakpoint
ALTER TABLE "paper_submission" ADD COLUMN "run_started_at_ms" bigint;--> statement-breakpoint
ALTER TABLE "paper_submission" ADD COLUMN "monitor_status" text;--> statement-breakpoint
ALTER TABLE "paper_submission" ADD COLUMN "observed_trades" integer;--> statement-breakpoint
ALTER TABLE "paper_submission" ADD COLUMN "window_policy" jsonb;--> statement-breakpoint
ALTER TABLE "paper_submission" ADD COLUMN "low_confidence" boolean;