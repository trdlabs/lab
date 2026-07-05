ALTER TABLE "strategy_revision" ADD COLUMN "kind" text DEFAULT 'composed' NOT NULL;--> statement-breakpoint
ALTER TABLE "strategy_revision" ADD COLUMN "consolidated_from_revision_id" text;--> statement-breakpoint
ALTER TABLE "strategy_revision" ADD COLUMN "semantic_parent_revision_id" text;--> statement-breakpoint
ALTER TABLE "strategy_revision" ADD COLUMN "composition_depth" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "strategy_revision" ADD COLUMN "baseline_validation_status" text;--> statement-breakpoint
ALTER TABLE "strategy_revision" ADD COLUMN "baseline_experiment_id" text;--> statement-breakpoint
ALTER TABLE "strategy_revision" ADD COLUMN "baseline_task_id" text;
--> statement-breakpoint
WITH RECURSIVE chain AS (
  SELECT id, base_revision_id, 1 AS depth FROM strategy_revision WHERE base_revision_id IS NULL
  UNION ALL
  SELECT r.id, r.base_revision_id, c.depth + 1 FROM strategy_revision r JOIN chain c ON r.base_revision_id = c.id
)
UPDATE strategy_revision s SET composition_depth = chain.depth FROM chain WHERE s.id = chain.id;