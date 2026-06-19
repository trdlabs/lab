CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "strategy_retrieval_document" (
	"strategy_profile_id" text PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(1024),
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', "content")) STORED,
	"embedding_model" text NOT NULL,
	"index_version" integer NOT NULL,
	"metadata" jsonb NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "action_proposal" ADD COLUMN "evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "action_proposal" ADD COLUMN "evidence_warnings" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "strategy_retrieval_document_search_vector_gin" ON "strategy_retrieval_document" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "strategy_retrieval_document_embedding_hnsw" ON "strategy_retrieval_document" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "strategy_retrieval_document_version_model_idx" ON "strategy_retrieval_document" USING btree ("index_version","embedding_model");