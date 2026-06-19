// scripts/operator-rag-reindex.ts
//
// operator-rag:reindex — build/repair strategy retrieval projections.
//
// DRY-RUN by default (no --run flag):
//   Loads and validates config, prints the reindex plan + counts.
//   Does NOT construct DB or OpenRouter clients; makes ZERO network/provider calls.
//
// Live mode (--run):
//   Constructs real DB + OpenRouter embedding adapter, fetches all strategy
//   profiles, and performs paid embedding calls + DB upserts.
//   Requires DATABASE_URL and OPENROUTER_API_KEY in the environment.
//
// Usage:
//   pnpm operator-rag:reindex               # dry-run
//   pnpm operator-rag:reindex --run          # live (paid)

const isDryRun = !process.argv.includes('--run');

// ---- config ----

const EMBEDDING_MODEL = 'baai/bge-m3';
const EMBEDDING_DIMENSIONS = 1024;
const INDEX_VERSION = 1;

function validateLiveEnv(env: NodeJS.ProcessEnv): { databaseUrl: string; openrouterApiKey: string } {
  const databaseUrl = env.DATABASE_URL;
  const openrouterApiKey = env.OPENROUTER_API_KEY;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required when --run is passed');
  }
  if (!openrouterApiKey) {
    throw new Error('OPENROUTER_API_KEY is required when --run is passed');
  }
  return { databaseUrl, openrouterApiKey };
}

// ---- dry-run path ----

function printDryRunPlan(): void {
  const banner = [
    '',
    '╔══════════════════════════════════════════════════════╗',
    '║   operator-rag:reindex  [DRY-RUN]                   ║',
    '╚══════════════════════════════════════════════════════╝',
    '',
    'Plan:',
    `  embedding model  : ${EMBEDDING_MODEL}`,
    `  embedding dims   : ${EMBEDDING_DIMENSIONS}`,
    `  index version    : ${INDEX_VERSION}`,
    '',
    'What would happen with --run:',
    '  1. Connect to DATABASE_URL (Postgres)',
    '  2. Load all strategy profiles (listAll → createdAt ASC, id ASC)',
    '  3. For each profile:',
    '       a. Build canonical retrieval text (fixed-label order)',
    '       b. Compute contentHash (sha256 of text)',
    '       c. Check existing projection in strategy_retrieval_document',
    '       d. Skip if contentHash + embeddingModel + indexVersion match',
    '       e. Embed text via OpenRouter (paid API call)',
    '       f. Upsert projection in strategy_retrieval_document',
    '  4. Print summary: indexed / skipped / failed',
    '',
    'No DATABASE_URL or OPENROUTER_API_KEY required in dry-run mode.',
    'Pass --run to perform actual embedding calls (incurs API cost).',
    '',
  ].join('\n');

  process.stdout.write(banner);
}

// ---- live path ----

async function runLive(): Promise<void> {
  const { databaseUrl, openrouterApiKey } = validateLiveEnv(process.env);

  // Lazy imports — only executed when --run is passed
  const { randomUUID } = await import('node:crypto');
  const { createDbClient } = await import('../src/db/client.ts');
  const { DrizzleStrategyProfileRepository } = await import('../src/adapters/repository/drizzle-strategy-profile.repository.ts');
  const { DrizzleAgentEventRepository } = await import('../src/adapters/repository/drizzle-agent-event.repository.ts');
  const { DrizzleStrategyRetrievalIndexRepository } = await import('../src/adapters/repository/drizzle-strategy-retrieval-index.repository.ts');
  const { OpenRouterEmbeddingAdapter } = await import('../src/adapters/embedding/openrouter-embedding.adapter.ts');
  const { StrategyRetrievalIndexer } = await import('../src/operator/strategy-retrieval-indexer.ts');

  const { db, pool } = createDbClient(databaseUrl);

  try {
    const profileRepo = new DrizzleStrategyProfileRepository(db);
    const eventRepo = new DrizzleAgentEventRepository(db);
    const indexRepo = new DrizzleStrategyRetrievalIndexRepository(db);
    const embeddingPort = new OpenRouterEmbeddingAdapter({
      apiKey: openrouterApiKey,
      model: EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
    });

    const indexer = new StrategyRetrievalIndexer(
      embeddingPort,
      indexRepo,
      { embeddingModel: EMBEDDING_MODEL, indexVersion: INDEX_VERSION },
      () => new Date().toISOString(),
      eventRepo,
    );

    process.stdout.write('[operator-rag:reindex] Loading all strategy profiles...\n');
    const profiles = await profileRepo.listAll();
    process.stdout.write(`[operator-rag:reindex] Found ${profiles.length} profile(s). Starting reindex...\n`);

    const summary = await indexer.reindex(profiles);

    process.stdout.write('\nSummary:\n');
    process.stdout.write(`  indexed : ${summary.indexed}\n`);
    process.stdout.write(`  skipped : ${summary.skipped}\n`);
    process.stdout.write(`  failed  : ${summary.failed}\n\n`);

    void randomUUID; // referenced above to avoid lint warning

    if (summary.failed > 0) {
      process.stderr.write(`[operator-rag:reindex] ${summary.failed} profile(s) failed. Check agent_event for details.\n`);
      process.exit(1);
    }
  } finally {
    await pool.end();
  }
}

// ---- main ----

async function main(): Promise<void> {
  if (isDryRun) {
    printDryRunPlan();
    return;
  }
  await runLive();
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    process.stderr.write(
      `operator-rag:reindex failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
