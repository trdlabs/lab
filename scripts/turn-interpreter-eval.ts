// scripts/turn-interpreter-eval.ts
// turn-interpreter:eval — experimental TurnInterpreter model evaluation harness.
// Default = DRY RUN (no real model construction, no composeMastra, no paid calls).
// --run is the SOLE trigger for paid calls. No DB, no backtester, no persistence.
// Paid-call volume = models x repeat x caseCount (interpret is called per message) — printed up front.
import { execSync } from 'node:child_process';
import { loadCases, fingerprintCases } from '../src/experiments/turn-interpreter/fixtures.ts';
import { parseArgs, planDryRun, writeRunArtifacts, writeReport, compactTimestamp, DEFAULT_THRESHOLD, type EnvRecommendation } from '../src/experiments/turn-interpreter/report.ts';
import { runEval } from '../src/experiments/turn-interpreter/eval-harness.ts';
import { rankAggregates, recommendEnv } from '../src/experiments/turn-interpreter/aggregate.ts';
import { parseRoleModel, type ModelProvider, type ModelProviderEnv } from '../src/adapters/llm/model-provider.ts';

const HARNESS_VERSION = 'turn-interpreter-eval-v1';

function gitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function modelEnv(): ModelProviderEnv {
  return {
    MODEL_PROVIDER: process.env.MODEL_PROVIDER as ModelProvider,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cases = loadCases(args.datasetId); // offline JSON read — safe in dry-run

  // ---------- DRY RUN (default): no model construction, no composeMastra ----------
  if (!args.run) {
    const plan = planDryRun(args, cases.length);
    process.stdout.write(`${JSON.stringify({
      mode: 'dry-run',
      dataset: args.datasetId,
      caseCount: cases.length,
      threshold: args.threshold,
      judge: args.judge,
      repeat: args.repeat,
      plannedPaidCalls: plan.plannedPaidCalls,
      classifyCalls: plan.classifyCalls,
      models: args.models,
      missingKeys: plan.missingKeys,
      note: 'DRY RUN — no real models constructed, nothing sent. classifyCalls = models x repeat x caseCount. Re-run with --run to make paid calls.',
    }, null, 2)}\n`);
    return 0;
  }

  // ---------- REAL RUN (--run): dynamically import the composeMastra-backed factory ----------
  const env = modelEnv();
  const { buildRealInterpreterFor, buildRealJudge } = await import('../src/experiments/turn-interpreter/real-turn-interpreter-factory.ts');

  let judge: Awaited<ReturnType<typeof buildRealJudge>> | undefined;
  if (args.judge && args.judgeModel) {
    judge = buildRealJudge(env, args.judgeModel);
  }

  const result = await runEval(
    {
      models: args.models,
      datasetId: args.datasetId,
      cases,
      datasetFingerprint: fingerprintCases(cases),
      threshold: args.threshold,
      repeat: args.repeat,
    },
    {
      interpreterFor: buildRealInterpreterFor(env),
      providerOf: (m) => {
        const r = parseRoleModel(env, m);
        return { provider: r.provider, modelId: r.modelId };
      },
      clock: () => Date.now(),
      judge,
    },
  );

  const now = new Date();
  const timestamp = compactTimestamp(now);
  const outDir = `.artifacts/experiments/turn-interpreter/${args.datasetId}/${timestamp}`;

  // Env recommendation: incumbent = INTENT_CLASSIFIER_MODEL (shared env, same as intent classifier)
  const ranked = rankAggregates(result.aggregates, result.manifest.judgeEnabled);
  const rec: EnvRecommendation = recommendEnv(ranked, {
    incumbentModelId: process.env.INTENT_CLASSIFIER_MODEL ?? '',
    threshold: args.threshold,
  });

  const written = writeRunArtifacts(outDir, result.manifest, result);
  written.push(writeReport(outDir, result, rec));

  // Summary output
  const r3 = (x: number): number => Math.round(x * 1000) / 1000;
  const ranking = ranked.map((a) => ({
    modelId: a.modelId,
    provider: a.provider,
    runs: a.runs,
    passRate: r3(a.passRate),
    meanScore: r3(a.meanScore),
    meanLatencyMs: Math.round(a.meanLatencyMs),
    judgeMean: a.judgeMean != null ? r3(a.judgeMean) : null,
  }));

  const overallSuccess = result.aggregates.some((a) => a.passRate > 0);

  process.stdout.write(`${JSON.stringify({
    mode: 'run',
    outDir,
    repeat: result.manifest.repeat,
    overallSuccess,
    envRecommendation: rec,
    ranking,
    artifacts: written,
  }, null, 2)}\n`);

  return overallSuccess ? 0 : 3;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`turn-interpreter:eval failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
