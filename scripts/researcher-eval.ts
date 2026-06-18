// researcher:eval — experimental Researcher model evaluation harness.
// Default = DRY RUN. Use --run as the sole trigger for paid LLM calls.
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseRoleModel, type ModelProvider, type ModelProviderEnv } from '../src/adapters/llm/model-provider.ts';
import { rankAggregates } from '../src/experiments/researcher/aggregate.ts';
import { fingerprintFixture, loadBotResultsFixture, loadTradeEvidenceFixture, longOiStrategyProfile, resolveResearcherFixture } from '../src/experiments/researcher/fixtures.ts';
import { runEval } from '../src/experiments/researcher/eval-harness.ts';
import type { EvalRunResult, ModelAggregate } from '../src/experiments/researcher/types.ts';

function parseCli() {
  const { values } = parseArgs({
    options: {
      fixture: { type: 'string', default: 'long-oi-vps-2026-06-01' },
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

function renderMarkdownReport(result: EvalRunResult, fixtureId: string, date: string): string {
  const ranking = rankAggregates(result.aggregates);

  const tableRows = ranking.map((a: ModelAggregate, i: number) => {
    const passRatePct = Math.round(a.passRate * 100);
    const score = a.scoreMean === null ? 'n/a' : r3(a.scoreMean).toFixed(3);
    const latency = Math.round(a.latencyMeanMs / 1000);
    return `| ${i + 1} | \`${a.model}\` | ${passRatePct}% | ${score} | ${latency}s | ${a.runs.ok}/${a.runs.total} |`;
  });

  const perModelDetail = ranking.map((agg: ModelAggregate) => {
    const runs = result.perModel.filter((r) => r.model === agg.model);
    const checkRows = runs
      .filter((r) => r.score !== null)
      .flatMap((r, ri) =>
        r.score!.checks.map((c) =>
          `  - run${ri + 1} \`${c.id}\`: ${r3(c.contribution).toFixed(3)} / ${c.weight} (matched: ${c.matched.slice(0, 3).join(', ') || 'none'})`,
        ),
      );
    const gateRows = runs
      .filter((r) => r.score !== null)
      .map((r, ri) => {
        const g = r.score!.gates;
        const failed = (Object.entries(g) as [string, boolean][]).filter(([, v]) => !v).map(([k]) => k);
        return `  - run${ri + 1} gates failed: ${failed.length === 0 ? 'none' : failed.join(', ')}`;
      });
    return [
      `### ${agg.model}`,
      '',
      '**Checks per run:**',
      ...checkRows,
      '',
      '**Gates per run:**',
      ...gateRows,
      '',
    ].join('\n');
  });

  return [
    `# Researcher Eval Bake-off — ${date}`,
    '',
    `**Fixture:** \`${fixtureId}\`  `,
    `**Threshold:** ${result.threshold}  `,
    `**Repeat:** ${result.repeat}  `,
    `**Overall success:** ${result.overallSuccess}`,
    '',
    '## Ranking',
    '',
    '| # | Model | Pass Rate | Score Mean | Latency (avg) | Runs OK |',
    '|---|-------|-----------|------------|---------------|---------|',
    ...tableRows,
    '',
    '## Per-Model Check Detail',
    '',
    ...perModelDetail,
  ].join('\n');
}

async function main(): Promise<number> {
  const args = parseCli();
  const fixture = resolveResearcherFixture(args.fixtureId);
  const profile = longOiStrategyProfile();
  const botResults = await loadBotResultsFixture(fixture.botResultsDir);
  const tradeEvidence = await loadTradeEvidenceFixture(fixture.botResultsDir, botResults);
  const fixtureFingerprint = fingerprintFixture(profile, botResults, tradeEvidence);

  if (!args.run) {
    process.stdout.write(`${JSON.stringify({
      mode: 'dry-run',
      fixture: fixture.id,
      threshold: args.threshold,
      repeat: args.repeat,
      models: args.models,
      botRuns: botResults.length,
      closedTrades: botResults.reduce((sum, d) => sum + d.trades.length, 0),
      tradeEvidenceBundles: tradeEvidence.length,
      plannedPaidCalls: args.models.length * args.repeat,
      note: 'DRY RUN — no real models constructed, nothing sent. Re-run with --run to make paid calls.',
    }, null, 2)}\n`);
    return 0;
  }

  const env = modelEnv();
  const { buildRealResearcherFor } = await import('../src/experiments/researcher/real-researcher-factory.ts');
  const result = await runEval(
    { models: args.models, fixtureId: fixture.id, fixtureFingerprint, profile, botResults, tradeEvidence, threshold: args.threshold, repeat: args.repeat },
    {
      researcherFor: buildRealResearcherFor(env),
      providerOf: (m) => { const r = parseRoleModel(env, m); return { provider: r.provider, modelId: r.modelId }; },
      clock: () => Date.now(),
    },
  );

  if (args.saveOutputs) {
    const date = new Date().toISOString().slice(0, 10);
    const outDir = `docs/eval-results`;
    mkdirSync(outDir, { recursive: true });
    const slug = `${date}-${fixture.id}`;
    writeFileSync(`${outDir}/${slug}.json`, JSON.stringify(result, null, 2));
    const md = renderMarkdownReport(result, fixture.id, date);
    writeFileSync(`${outDir}/${slug}.md`, md);
    process.stderr.write(`[eval] saved raw outputs → ${outDir}/${slug}.json\n`);
    process.stderr.write(`[eval] saved markdown report → ${outDir}/${slug}.md\n`);
  }

  const ranking = rankAggregates(result.aggregates).map((a: ModelAggregate) => ({
    model: a.model,
    runs: `${a.runs.ok}/${a.runs.total}`,
    passRate: r3(a.passRate),
    scoreMean: a.scoreMean === null ? null : r3(a.scoreMean),
    latencyMeanMs: Math.round(a.latencyMeanMs),
  }));

  process.stdout.write(`${JSON.stringify({ mode: 'run', fixture: fixture.id, repeat: result.repeat, overallSuccess: result.overallSuccess, ranking, perModel: result.perModel }, null, 2)}\n`);
  return result.overallSuccess ? 0 : 3;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`researcher:eval failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
