CREATE TABLE IF NOT EXISTS "action_proposal" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"subject_hash" text NOT NULL,
	"action" text NOT NULL,
	"source" text NOT NULL,
	"task" jsonb NOT NULL,
	"status" text NOT NULL,
	"confirmed_task_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_session" ADD COLUMN "pending_interaction" jsonb;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "action_proposal_session_status_idx" ON "action_proposal" USING btree ("session_id","status");