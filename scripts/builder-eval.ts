// builder:eval — experimental Builder model evaluation harness.
// Default = DRY RUN. Use --run as the sole trigger for paid LLM calls.
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseRoleModel, type ModelProvider, type ModelProviderEnv } from '../src/adapters/llm/model-provider.ts';
import { resolveBuilderFixture, defaultBuilderEvalInput } from '../src/experiments/builder/fixtures.ts';
import { runBuilderEval } from '../src/experiments/builder/eval-harness.ts';
import type { BuilderEvalRunResult, ModelAggregate, CandidateResult } from '../src/experiments/builder/types.ts';

function parseCli() {
  const { values } = parseArgs({
    options: {
      fixture: { type: 'string', default: 'long-oi-skip-entry' },
      models: { type: 'string' },
      run: { type: 'boolean', default: false },
      threshold: { type: 'string', default: '0.7' },
      repeat: { type: 'string', default: '1' },
      'save-outputs': { type: 'boolean', default: false },
    },
  });
  const models = (values.models ?? '').split(',').map((m) => m.trim()).filter(Boolean);
  if (models.length === 0) throw new Error('--models is required');
  const threshold = Number(values.threshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error(`--threshold must be in [0,1], got ${values.threshold}`);
  const repeat = Number(values.repeat);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) throw new Error(`--repeat must be an integer in [1,20], got ${values.repeat}`);
  return { fixtureId: values.fixture!, models, run: values.run!, threshold, repeat, saveOutputs: values['save-outputs']! };
}

function modelEnv(): ModelProviderEnv {
  return {
    MODEL_PROVIDER: process.env.MODEL_PROVIDER as ModelProvider,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  };
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000;

function renderMarkdownReport(result: BuilderEvalRunResult, fixtureId: string, date: string): string {
  const sorted = [...result.aggregates].sort((a, b) => (b.scoreMean ?? 0) - (a.scoreMean ?? 0));

  const tableRows = sorted.map((a: ModelAggregate, i: number) => {
    const passRatePct = Math.round(a.passRate * 100);
    const score = a.scoreMean === null ? 'n/a' : r3(a.scoreMean).toFixed(3);
    const latency = Math.round(a.latencyMeanMs / 1000);
    return `| ${i + 1} | \`${a.model}\` | ${passRatePct}% | ${score} | ${latency}s | ${a.runs.ok}/${a.runs.total} |`;
  });

  const perModelDetail = sorted.map((agg: ModelAggregate) => {
    const runs = result.perModel.filter((r: CandidateResult) => r.model === agg.model);
    const checkRows = runs
      .filter((r) => r.score !== null)
      .flatMap((r, ri) =>
        r.score!.checks.map((c) =>
          `  - [hyp:${r.hypothesisId.slice(-8)}] run${ri + 1} \`${c.id}\`: ${r3(c.contribution).toFixed(3)}/${c.weight} (${c.evidence.slice(0, 2).join('; ') || 'n/a'})`,
        ),
      );
    const errorRows = runs.filter((r) => r.error !== null).map((r, ri) =>
      `  - run${ri + 1} ERROR (${r.error!.type}): ${r.error!.message.slice(0, 120)}`,
    );
    return [
      `### ${agg.model}`,
      '',
      `pass_rate=${Math.round(agg.passRate * 100)}% score=${agg.scoreMean === null ? 'n/a' : r3(agg.scoreMean).toFixed(3)} latency=${Math.round(agg.latencyMeanMs / 1000)}s`,
      '',
      '**Checks per run:**',
      ...checkRows,
      ...(errorRows.length > 0 ? ['', '**Errors:**', ...errorRows] : []),
      '',
    ].join('\n');
  });

  return [
    `# Builder Eval — ${fixtureId} — ${date}`,
    '',
    `threshold=${result.threshold} repeat=${result.repeat} fixture=${fixtureId}`,
    '',
    '## Ranking',
    '',
    '| # | Model | Pass% | Score | Latency | ok/total |',
    '|---|-------|-------|-------|---------|----------|',
    ...tableRows,
    '',
    '## Per-model detail',
    '',
    ...perModelDetail,
  ].join('\n');
}

async function main(): Promise<number> {
  const args = parseCli();
  const fixture = resolveBuilderFixture(args.fixtureId);

  if (!args.run) {
    process.stdout.write(`${JSON.stringify({
      fixture: fixture.id,
      models: args.models,
      hypotheses: 2,
      repeat: args.repeat,
      threshold: args.threshold,
      plannedPaidCalls: args.models.length * 2 * args.repeat,
      note: 'DRY RUN — no real models constructed, nothing sent. Re-run with --run to make paid calls.',
    }, null, 2)}\n`);
    return 0;
  }

  const env = modelEnv();
  const { buildRealBuilderFor } = await import('../src/experiments/builder/real-builder-factory.ts');
  const evalInput = defaultBuilderEvalInput(args.models, args.threshold, args.repeat);

  if (args.models.length > 0) process.stderr.write(`[builder:eval] models: ${args.models.join(', ')}\n`);

  const result = await runBuilderEval(
    evalInput,
    {
      builderFor: buildRealBuilderFor(env),
      providerOf: (m) => { const r = parseRoleModel(env, m); return { provider: r.provider, modelId: r.modelId }; },
      clock: () => Date.now(),
    },
  );

  const date = new Date().toISOString().slice(0, 10);
  const report = renderMarkdownReport(result, fixture.id, date);
  process.stdout.write(report + '\n');

  if (args.saveOutputs) {
    const dir = `docs/eval-outputs/builder/${date}`;
    mkdirSync(dir, { recursive: true });
    const slug = args.models.join('-').replace(/[^a-z0-9-]/gi, '_').slice(0, 60);
    writeFileSync(`${dir}/${fixture.id}-${slug}.md`, report, 'utf8');
    writeFileSync(`${dir}/${fixture.id}-${slug}.json`, JSON.stringify(result, null, 2), 'utf8');
    process.stderr.write(`[builder:eval] saved to ${dir}/\n`);
  }

  const winner = [...result.aggregates].sort((a, b) => (b.scoreMean ?? 0) - (a.scoreMean ?? 0))[0];
  if (winner) {
    process.stderr.write(`[builder:eval] winner: ${winner.model} (score=${r3(winner.scoreMean ?? 0)}, pass=${Math.round(winner.passRate * 100)}%)\n`);
  }

  return result.overallSuccess ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(`[builder:eval] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
