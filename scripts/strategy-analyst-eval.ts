// scripts/strategy-analyst-eval.ts
// analyst:eval — experimental StrategyAnalyst model evaluation harness.
// Default = DRY RUN (no real model construction, no composeMastra, no paid calls).
// --run is the SOLE trigger for paid calls. No DB, no backtester, no persistence.
import { parseArgs } from 'node:util';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { resolveFixture, fingerprintSource } from '../src/experiments/strategy-analyst/fixtures.ts';
import { planDryRun } from '../src/experiments/strategy-analyst/plan.ts';
import { runEval } from '../src/experiments/strategy-analyst/eval-harness.ts';
import { writeRunArtifacts, compactTimestamp } from '../src/experiments/strategy-analyst/artifacts.ts';
import { rankAggregates } from '../src/experiments/strategy-analyst/aggregate.ts';
import { parseRoleModel, type ModelProvider, type ModelProviderEnv } from '../src/adapters/llm/model-provider.ts';
import { STRATEGY_PROFILE_CONTRACT_VERSION } from '../src/domain/strategy-profile.ts';
import { gatherStrategyCode } from '../src/domain/strategy-code.ts';
import type { ManifestMeta } from '../src/experiments/strategy-analyst/types.ts';

const HARNESS_VERSION = 'analyst-eval-v1';

function parseCli() {
  const { values } = parseArgs({
    options: {
      fixture: { type: 'string', default: 'long-oi' },
      models: { type: 'string' },
      run: { type: 'boolean', default: false },
      threshold: { type: 'string', default: '0.8' },
      judge: { type: 'boolean', default: false },
      'judge-model': { type: 'string' },
      repeat: { type: 'string', default: '1' },
    },
  });
  const models = (values.models ?? '').split(',').map((m) => m.trim()).filter(Boolean);
  if (models.length === 0) throw new Error('--models is required (comma-separated, e.g. anthropic/claude-x,openai/gpt-x)');
  const threshold = Number(values.threshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error(`--threshold must be in [0,1], got ${values.threshold}`);
  const repeat = Number(values.repeat);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) throw new Error(`--repeat must be an integer in [1,20], got ${values.repeat}`);
  if (values.judge && !values['judge-model']) throw new Error('--judge requires --judge-model <provider/model>');
  return { fixtureId: values.fixture!, models, run: values.run!, threshold, judge: values.judge!, judgeModel: values['judge-model'], repeat };
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
  const fixture = resolveFixture(args.fixtureId);

  let fixtureText: string;
  let inputKind: 'manual_description' | 'bot_code';
  if (fixture.sourceDir) {
    const files = readdirSync(fixture.sourceDir)
      .filter((f) => f.endsWith('.ts'))
      .map((name) => ({ name, content: readFileSync(join(fixture.sourceDir!, name), 'utf8') }));
    fixtureText = gatherStrategyCode(files, { pathPrefix: 'src/strategies/long_oi' });
    inputKind = fixture.kind ?? 'bot_code';
  } else {
    fixtureText = readFileSync(fixture.sourcePath!, 'utf8');
    inputKind = fixture.kind ?? 'manual_description';
  }

  // ---------- DRY RUN (default): no model construction, no composeMastra ----------
  if (!args.run) {
    const plan = planDryRun({ models: args.models, judge: args.judge, env: process.env, repeat: args.repeat });
    process.stdout.write(`${JSON.stringify({
      mode: 'dry-run', fixture: args.fixtureId, inputKind, threshold: args.threshold, judge: args.judge, repeat: args.repeat,
      plannedPaidCalls: plan.totalPaidCalls, analystCalls: plan.analystCalls, judgeCalls: plan.judgeCalls,
      models: plan.perModel, missingKeys: plan.missingKeys,
      note: 'DRY RUN — no real models constructed, nothing sent. Re-run with --run to make paid calls.',
    }, null, 2)}\n`);
    return 0;
  }

  // ---------- REAL RUN (--run): dynamically import the composeMastra-backed factory ----------
  const env = modelEnv();
  const { buildRealAnalystFor, buildRealJudge } = await import('../src/experiments/strategy-analyst/real-analyst-factory.ts');

  let judge: Awaited<ReturnType<typeof buildRealJudge>> | undefined;
  if (args.judge && args.judgeModel) {
    const rubricText = readFileSync(fixture.rubricPath, 'utf8');
    const notesText = readFileSync(fixture.notesPath, 'utf8');
    judge = buildRealJudge(env, args.judgeModel, rubricText, notesText);
  }

  const result = await runEval(
    { models: args.models, fixtureId: fixture.id, fixtureText, fixtureFingerprint: fingerprintSource(fixtureText), threshold: args.threshold, repeat: args.repeat, direction: fixture.direction, sourceKind: inputKind },
    {
      analystFor: buildRealAnalystFor(env),
      providerOf: (m) => { const r = parseRoleModel(env, m); return { provider: r.provider, modelId: r.modelId }; },
      clock: () => Date.now(),
      judge,
    },
  );

  const now = new Date();
  const timestamp = compactTimestamp(now);
  const outDir = `.artifacts/experiments/strategy-analyst/${fixture.id}/${timestamp}`;
  const meta: ManifestMeta = { timestamp, gitSha: gitSha(), harnessVersion: HARNESS_VERSION, contractVersion: STRATEGY_PROFILE_CONTRACT_VERSION, mode: 'run' };
  const written = writeRunArtifacts(outDir, meta, result);

  // Aggregated ranking summary (judge-mean -> PASS-rate -> det-mean). Per-run detail is in the artifacts.
  const r3 = (x: number): number => Math.round(x * 1000) / 1000;
  const ranking = rankAggregates(result.aggregates, result.judgeEnabled).map((a) => ({
    model: a.model,
    runs: `${a.runs.ok}/${a.runs.total}`,
    passRate: r3(a.passRate),
    detMean: a.det ? r3(a.det.mean) : null,
    detStd: a.det ? r3(a.det.std) : null,
    judgeMean: a.judge ? r3(a.judge.mean) : null,
    judgeStd: a.judge ? r3(a.judge.std) : null,
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
    process.stderr.write(`analyst:eval failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
