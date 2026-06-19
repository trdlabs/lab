// scripts/operator-rag-eval.ts
// operator-rag:eval — strategy retrieval golden eval harness.
// Default = DRY RUN: reads + validates fixtures, prints dataset fingerprint,
// case count, and planned provider/DB calls. ZERO network/DB access.
// --run is the SOLE trigger for real embedding + similarity calls.
// Requires DATABASE_URL + OPENROUTER_API_KEY ONLY with --run.
import { parseArgs } from 'node:util';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCases, fingerprintCases } from '../src/experiments/operator-rag/fixtures.ts';
import { assembleResult, runRetrieval, HARNESS_VERSION, CONTRACT_VERSION, type RetrievalPort } from '../src/experiments/operator-rag/eval-harness.ts';
import type { ManifestMeta, StrategyRetrievalEvalCase } from '../src/experiments/operator-rag/types.ts';

function parseCli() {
  const { values } = parseArgs({
    options: {
      dataset: { type: 'string', default: 'strategy-retrieval-v1' },
      run: { type: 'boolean', default: false },
    },
  });
  return { datasetId: values.dataset!, run: values.run! };
}

function gitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function checkKeys(): { missingKeys: string[]; databaseUrl: boolean; openrouterKey: boolean } {
  const databaseUrl = Boolean(process.env.DATABASE_URL);
  const openrouterKey = Boolean(process.env.OPENROUTER_API_KEY);
  const missingKeys: string[] = [];
  if (!databaseUrl) missingKeys.push('DATABASE_URL');
  if (!openrouterKey) missingKeys.push('OPENROUTER_API_KEY');
  return { missingKeys, databaseUrl, openrouterKey };
}

async function main(): Promise<number> {
  const args = parseCli();

  // Dataset loading is safe in dry-run: it is a local JSON read, no network.
  const cases = loadCases(args.datasetId);
  const fingerprint = fingerprintCases(cases);
  const exactCaseCount = cases.filter((c) => c.expectedExactId != null).length;
  const noMatchCaseCount = cases.filter((c) => c.expectedRelevantIds.length === 0).length;

  // ---------- DRY RUN (default): zero network/DB calls ----------
  if (!args.run) {
    const { missingKeys } = checkKeys();

    process.stdout.write(`${JSON.stringify({
      mode: 'dry-run',
      dataset: args.datasetId,
      datasetFingerprint: fingerprint,
      caseCount: cases.length,
      breakdown: {
        exactCopyCases: exactCaseCount,
        noMatchCases: noMatchCaseCount,
        semanticCases: cases.length - exactCaseCount - noMatchCaseCount,
      },
      plannedCalls: {
        embeddingCalls: cases.length,
        similaritySearchCalls: cases.length,
        totalNetworkCalls: cases.length * 2,
        requiresKeys: ['DATABASE_URL', 'OPENROUTER_API_KEY'],
      },
      missingKeys,
      gates: {
        exactIdentityAccuracy: '= 1.0 (every expectedExactId must rank first)',
        falseSemanticExactCount: '= 0 (no unexpected grade-3 at rank-1)',
        recallAt20: '>= 0.90',
        mrr: 'reported (informational)',
        ndcgAt5: 'reported (informational)',
      },
      note: 'DRY RUN — fixtures validated, zero network/DB calls made. Re-run with --run to execute retrieval.',
    }, null, 2)}\n`);
    return 0;
  }

  // ---------- REAL RUN (--run): construct adapters, embed, search ----------
  const { missingKeys } = checkKeys();
  if (missingKeys.length > 0) {
    process.stderr.write(`operator-rag:eval --run requires: ${missingKeys.join(', ')}\n`);
    return 1;
  }

  // Dynamically import adapters so DRY RUN never touches them.
  const { OpenRouterEmbeddingAdapter } = await import('../src/adapters/embedding/openrouter-embedding.adapter.ts');
  const { createDbClient } = await import('../src/db/client.ts');
  const { PgHybridStrategySimilarityAdapter } = await import('../src/adapters/similarity/pg-hybrid-strategy-similarity.adapter.ts');

  // OpenRouterEmbeddingAdapter(model, apiKey, fetchFn?)
  // Model is LOCKED to the Operator embedding model (baai/bge-m3, 1024 dims): the adapter
  // rejects any non-1024 vector, and the corpus projection must use the same model.
  const EMBEDDING_MODEL = process.env.OPERATOR_EMBEDDING_MODEL ?? 'baai/bge-m3';
  const embeddingAdapter = new OpenRouterEmbeddingAdapter(EMBEDDING_MODEL, process.env.OPENROUTER_API_KEY!);
  // createDbClient returns { db, pool }
  const { db } = createDbClient(process.env.DATABASE_URL!);
  const similarityAdapter = new PgHybridStrategySimilarityAdapter(db);

  const port: RetrievalPort = {
    async retrieve(_caseId: string, query: string, filters: StrategyRetrievalEvalCase['filters']) {
      // embed returns readonly number[][] — take the first (and only) vector
      const embeddings = await embeddingAdapter.embed([query]);
      const embedding = embeddings[0];
      if (embedding === undefined) throw new Error('embedding adapter returned empty result');
      const result = await similarityAdapter.search({
        text: query,
        embedding,
        filters: {
          market: filters.market,
          symbol: filters.symbol,
          timeframe: filters.timeframe,
          direction: filters.direction,
        },
        lexicalLimit: 50,
        vectorLimit: 50,
        fusedLimit: 20,
      });
      return result.candidates.map((c) => c.strategyProfileId);
    },
  };

  process.stderr.write(`Running retrieval for ${cases.length} cases...\n`);
  const retrievalResults = await runRetrieval(cases, port);
  const result = assembleResult(args.datasetId, fingerprint, cases, retrievalResults);

  const now = new Date();
  const timestamp = compactTimestamp(now);
  const outDir = `.artifacts/experiments/operator-rag/${args.datasetId}/${timestamp}`;
  mkdirSync(outDir, { recursive: true });

  const meta: ManifestMeta = {
    timestamp,
    gitSha: gitSha(),
    harnessVersion: HARNESS_VERSION,
    contractVersion: CONTRACT_VERSION,
    mode: 'run',
  };

  const manifestPath = join(outDir, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify({ meta, result }, null, 2)}\n`, 'utf8');

  const reportLines: string[] = [
    `# Operator RAG Eval Report`,
    ``,
    `**Dataset:** ${args.datasetId}  `,
    `**Fingerprint:** ${fingerprint}  `,
    `**Cases:** ${cases.length}  `,
    `**Timestamp:** ${timestamp}  `,
    `**Git SHA:** ${meta.gitSha}  `,
    ``,
    `## Gate Results`,
    ``,
    `| Gate | Value | Pass |`,
    `|------|-------|------|`,
    `| Exact Identity Accuracy | ${result.gates.exactIdentityAccuracy.toFixed(4)} | ${result.gates.gateExactIdentity ? 'PASS' : 'FAIL'} |`,
    `| False Semantic Exact Count | ${result.gates.falseSemanticExactCount} | ${result.gates.gateFalseSemanticExact ? 'PASS' : 'FAIL'} |`,
    `| Recall@20 | ${result.gates.recallAt20.toFixed(4)} | ${result.gates.gateRecallAt20 ? 'PASS' : 'FAIL'} |`,
    ``,
    `## Informational Metrics`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| MRR | ${result.gates.mrr.toFixed(4)} |`,
    `| nDCG@5 | ${result.gates.ndcgAt5.toFixed(4)} |`,
    ``,
    `## Overall: ${result.overallPass ? 'PASS' : 'FAIL'}`,
  ];
  const reportPath = join(outDir, 'report.md');
  writeFileSync(reportPath, reportLines.join('\n'), 'utf8');

  const r4 = (x: number): number => Math.round(x * 10000) / 10000;
  process.stdout.write(`${JSON.stringify({
    mode: 'run',
    outDir,
    dataset: args.datasetId,
    datasetFingerprint: fingerprint,
    caseCount: cases.length,
    gates: {
      exactIdentityAccuracy: r4(result.gates.exactIdentityAccuracy),
      exactIdentityPass: result.gates.gateExactIdentity,
      falseSemanticExactCount: result.gates.falseSemanticExactCount,
      falseSemanticExactPass: result.gates.gateFalseSemanticExact,
      recallAt20: r4(result.gates.recallAt20),
      recallAt20Pass: result.gates.gateRecallAt20,
    },
    metrics: {
      mrr: r4(result.gates.mrr),
      ndcgAt5: r4(result.gates.ndcgAt5),
    },
    overallPass: result.overallPass,
    artifacts: [manifestPath, reportPath],
  }, null, 2)}\n`);

  return result.overallPass ? 0 : 3;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`operator-rag:eval failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
