// scripts/strategy-critic-eval.ts
// critic:eval — experimental StrategyCritic mode/model evaluation harness.
// Default = DRY RUN (no real model construction, no composeMastra, no paid calls).
// --run is the SOLE trigger for paid calls. No DB, no backtester, no persistence.
import { parseArgs } from 'node:util';
import { execSync } from 'node:child_process';
import { buildCandidates } from '../src/experiments/strategy-critic/candidates.ts';
import { CRITIC_EVAL_CASES, resolveCase } from '../src/experiments/strategy-critic/fixtures.ts';
import { planDryRun } from '../src/experiments/strategy-critic/plan.ts';
import { runEval } from '../src/experiments/strategy-critic/eval-harness.ts';
import { rankAggregates } from '../src/experiments/strategy-critic/aggregate.ts';
import { writeRunArtifacts, compactTimestamp } from '../src/experiments/strategy-critic/artifacts.ts';
import { parseRoleModel, type ModelProvider, type ModelProviderEnv } from '../src/adapters/llm/model-provider.ts';
import type { ManifestMeta } from '../src/experiments/strategy-critic/types.ts';

const HARNESS_VERSION = 'critic-eval-v1';
const CONTRACT_VERSION = 'strategy-critic-v0';

function splitList(v: string | undefined): string[] {
  return (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

function parseCli() {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string', default: 'single' },
      models: { type: 'string' },
      'critic-models': { type: 'string' },
      'refiner-models': { type: 'string' },
      cases: { type: 'string' },
      run: { type: 'boolean', default: false },
      threshold: { type: 'string', default: '0.6' },
      judge: { type: 'boolean', default: false },
      'judge-model': { type: 'string' },
      repeat: { type: 'string', default: '1' },
      'round-trip': { type: 'boolean', default: false },
      'analyst-model': { type: 'string', default: 'openrouter/x-ai/grok-4.3' },
    },
  });
  const mode = values.mode!;
  if (mode !== 'single' && mode !== 'two_stage') throw new Error(`--mode must be 'single' or 'two_stage', got ${mode}`);
  const candidates = buildCandidates({
    mode,
    models: splitList(values.models),
    criticModels: splitList(values['critic-models']),
    refinerModels: splitList(values['refiner-models']),
  });
  const caseIds = splitList(values.cases);
  const cases = caseIds.length > 0 ? caseIds : Object.keys(CRITIC_EVAL_CASES);
  const threshold = Number(values.threshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error(`--threshold must be in [0,1], got ${values.threshold}`);
  const repeat = Number(values.repeat);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) throw new Error(`--repeat must be an integer in [1,20], got ${values.repeat}`);
  if (values.judge && !values['judge-model']) throw new Error('--judge requires --judge-model <provider/model>');
  return { candidates, cases, run: values.run!, threshold, judge: values.judge!, judgeModel: values['judge-model'], repeat, roundTrip: values['round-trip']!, analystModel: values['analyst-model']! };
}

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
  const args = parseCli();

  // ---------- DRY RUN (default): no model construction, no composeMastra ----------
  if (!args.run) {
    const plan = planDryRun({ candidates: args.candidates, cases: args.cases, judge: args.judge, judgeModel: args.judgeModel, env: process.env, repeat: args.repeat, roundTrip: args.roundTrip, analystModel: args.analystModel });
    process.stdout.write(`${JSON.stringify({
      mode: 'dry-run', threshold: args.threshold, judge: args.judge, repeat: args.repeat, cases: args.cases,
      roundTrip: args.roundTrip, analystModel: args.analystModel,
      plannedPaidCalls: plan.totalPaidCalls, refineCalls: plan.refineCalls, judgeCalls: plan.judgeCalls, analystCalls: plan.analystCalls,
      candidates: plan.perCandidate, missingKeys: plan.missingKeys,
      note: 'DRY RUN — no real models constructed, nothing sent. Re-run with --run to make paid calls.',
    }, null, 2)}\n`);
    return 0;
  }

  // ---------- REAL RUN (--run): dynamically import the composeMastra-backed factory ----------
  const env = modelEnv();
  const { buildRealCriticFor, buildRealJudge } = await import('../src/experiments/strategy-critic/real-critic-factory.ts');

  let judge: Awaited<ReturnType<typeof buildRealJudge>> | undefined;
  if (args.judge && args.judgeModel) judge = buildRealJudge(env, args.judgeModel);

  let analystFor: ((modelId: string) => import('../src/ports/strategy-analyst.port.ts').StrategyAnalystPort) | undefined;
  if (args.roundTrip) {
    const { buildRealAnalystFor } = await import('../src/experiments/strategy-analyst/real-analyst-factory.ts');
    analystFor = buildRealAnalystFor(env);
  }

  const result = await runEval(
    { candidates: args.candidates, cases: args.cases.map((id) => resolveCase(id)), threshold: args.threshold, repeat: args.repeat, roundTrip: args.roundTrip, analystModel: args.analystModel },
    {
      criticFor: buildRealCriticFor(env),
      providerOf: (m) => { const r = parseRoleModel(env, m); return { provider: r.provider, modelId: r.modelId }; },
      clock: () => Date.now(),
      judge,
      analystFor,
    },
  );

  const now = new Date();
  const timestamp = compactTimestamp(now);
  const outDir = `.artifacts/experiments/strategy-critic/${timestamp}`;
  const meta: ManifestMeta = { timestamp, gitSha: gitSha(), harnessVersion: HARNESS_VERSION, contractVersion: CONTRACT_VERSION, mode: 'run' };
  const written = writeRunArtifacts(outDir, meta, result);

  const r3 = (x: number): number => Math.round(x * 1000) / 1000;
  const ranking = rankAggregates(result.aggregates, result.judgeEnabled).map((a) => ({
    label: a.label,
    mode: a.mode,
    criticModel: a.criticModel,
    refinerModel: a.refinerModel,
    runs: `${a.runs.ok}/${a.runs.total}`,
    passRate: r3(a.passRate),
    detMean: a.det ? r3(a.det.mean) : null,
    detStd: a.det ? r3(a.det.std) : null,
    judgeMean: a.judge ? r3(a.judge.mean) : null,
    judgeStd: a.judge ? r3(a.judge.std) : null,
    profileMean: a.profile ? r3(a.profile.mean) : null,
    latencyMeanMs: Math.round(a.latency.mean),
  }));

  process.stdout.write(`${JSON.stringify({
    mode: 'run', outDir, repeat: result.repeat, overallSuccess: result.overallSuccess,
    ranking, artifacts: written,
  }, null, 2)}\n`);

  return result.overallSuccess ? 0 : 3;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`critic:eval failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
