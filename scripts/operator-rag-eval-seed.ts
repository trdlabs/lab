// scripts/operator-rag-eval-seed.ts
//
// operator-rag eval seed — populate strategy_retrieval_document with the
// hand-authored eval corpus so that operator-rag-eval.ts --run can execute
// against real bge-m3 embeddings.
//
// Usage:
//   DATABASE_URL=postgres://... node --experimental-strip-types \
//     --env-file-if-exists=.env scripts/operator-rag-eval-seed.ts
//
// Requires: DATABASE_URL  OPENROUTER_API_KEY (via env or .env file)

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createDbClient } from '../src/db/client.ts';
import { OpenRouterEmbeddingAdapter } from '../src/adapters/embedding/openrouter-embedding.adapter.ts';
import { PgStrategyRetrievalIndexAdapter } from '../src/adapters/repository/pg-strategy-retrieval-index.adapter.ts';
import { sql } from 'drizzle-orm';

// ---- config ----------------------------------------------------------------

const EMBEDDING_MODEL = 'baai/bge-m3';
const INDEX_VERSION = 1;
const CORPUS_PATH = 'src/experiments/operator-rag/__fixtures__/strategy-retrieval-v1-corpus.json';

// ---- types -----------------------------------------------------------------

interface CorpusEntry {
  strategyProfileId: string;
  content: string;
  metadata: {
    market?: string;
    symbol?: string;
    timeframe?: string;
    direction?: 'long' | 'short' | 'both';
  };
}

// ---- helpers ---------------------------------------------------------------

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function validateEnv(): { databaseUrl: string; openrouterApiKey: string } {
  const databaseUrl = process.env.DATABASE_URL;
  const openrouterApiKey = process.env.OPENROUTER_API_KEY;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (!openrouterApiKey) throw new Error('OPENROUTER_API_KEY is required');
  return { databaseUrl, openrouterApiKey };
}

// ---- main ------------------------------------------------------------------

async function main(): Promise<void> {
  const { databaseUrl, openrouterApiKey } = validateEnv();

  // 1. Load corpus
  const corpus: CorpusEntry[] = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as CorpusEntry[];
  process.stdout.write(`[seed] Loaded ${corpus.length} corpus entries from ${CORPUS_PATH}\n`);

  // 2. Connect to DB
  const { db, pool } = createDbClient(databaseUrl);

  try {
    // 3. Wipe the test DB clean
    process.stdout.write('[seed] Deleting all rows from strategy_retrieval_document...\n');
    await db.execute(sql`DELETE FROM strategy_retrieval_document`);
    process.stdout.write('[seed] Table cleared.\n');

    // 4. Build adapters
    const embeddingAdapter = new OpenRouterEmbeddingAdapter(EMBEDDING_MODEL, openrouterApiKey);
    const indexAdapter = new PgStrategyRetrievalIndexAdapter(db, {
      embeddingModel: EMBEDDING_MODEL,
      indexVersion: INDEX_VERSION,
    });

    // 5. Embed all contents in one batched call (saves API round-trips)
    const texts = corpus.map((e) => e.content);
    process.stdout.write(`[seed] Embedding ${texts.length} document(s) via ${EMBEDDING_MODEL}...\n`);
    const embeddings = await embeddingAdapter.embed(texts);
    process.stdout.write(`[seed] Received ${embeddings.length} embedding vector(s).\n`);

    // 6. Upsert each document
    let seeded = 0;
    for (let i = 0; i < corpus.length; i++) {
      const entry = corpus[i]!;
      const embedding = embeddings[i];
      if (!embedding) {
        throw new Error(`Missing embedding at index ${i} for ${entry.strategyProfileId}`);
      }

      await indexAdapter.upsert({
        strategyProfileId: entry.strategyProfileId,
        content: entry.content,
        contentHash: sha256Hex(entry.content),
        embedding,
        embeddingModel: EMBEDDING_MODEL,
        indexVersion: INDEX_VERSION,
        metadata: entry.metadata,
        indexedAt: new Date().toISOString(),
      });

      process.stdout.write(`[seed]   upserted ${entry.strategyProfileId}\n`);
      seeded++;
    }

    process.stdout.write(`\n[seed] Done. Seeded ${seeded} document(s).\n`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[seed] FAILED: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
