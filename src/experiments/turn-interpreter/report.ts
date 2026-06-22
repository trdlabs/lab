// src/experiments/turn-interpreter/report.ts
// Pure, testable helpers for the TurnInterpreter eval CLI: argument parsing, dry-run planning,
// markdown report rendering, and artifact writing. No model construction here.
// Mirror of src/experiments/intent-classifier/plan.ts + report.ts conventions.
import { parseArgs as nodeParseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRoleModel, MODEL_PROVIDERS, type ModelProvider, type ModelProviderEnv } from '../../adapters/llm/model-provider.ts';
import { rankAggregates } from './aggregate.ts';
import type { EvalRunResult, ManifestMeta, ModelAggregate } from './types.ts';
import { DEFAULT_THRESHOLD } from './scoring.ts';

export const DEFAULT_DATASET = 'turn-interpretations-v1';
export { DEFAULT_THRESHOLD } from './scoring.ts';

// ---- Env key mapping (mirrors intent-classifier/plan.ts) ----

export const KEY_BY_PROVIDER: Record<ModelProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

function isProvider(value: string | undefined): value is ModelProvider {
  return value != null && (MODEL_PROVIDERS as readonly string[]).includes(value);
}

// ---- CLI args ----

export interface CliArgs {
  datasetId: string;
  models: string[];
  run: boolean;
  threshold: number;
  judge: boolean;
  judgeModel: string | undefined;
  repeat: number;
}

export function parseArgs(argv: string[]): CliArgs {
  const { values } = nodeParseArgs({
    args: argv,
    options: {
      dataset: { type: 'string', default: DEFAULT_DATASET },
      models: { type: 'string' },
      run: { type: 'boolean', default: false },
      threshold: { type: 'string', default: String(DEFAULT_THRESHOLD) },
      judge: { type: 'boolean', default: false },
      'judge-model': { type: 'string' },
      repeat: { type: 'string', default: '1' },
    },
  });

  const models = (values.models ?? '').split(',').map((m) => m.trim()).filter(Boolean);
  if (models.length === 0) {
    throw new Error('--models is required (comma-separated, e.g. anthropic/claude-haiku-4-5,openai/gpt-4o-mini)');
  }

  const threshold = Number(values.threshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(`--threshold must be in [0,1], got ${values.threshold}`);
  }

  const repeat = Number(values.repeat);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) {
    throw new Error(`--repeat must be an integer in [1,20], got ${values.repeat}`);
  }

  if (values.judge && !values['judge-model']) {
    throw new Error('--judge requires --judge-model <provider/model>');
  }

  return {
    datasetId: values.dataset!,
    models,
    run: values.run!,
    threshold,
    judge: values.judge!,
    judgeModel: values['judge-model'],
    repeat,
  };
}

// ---- Dry-run plan ----

export interface DryRunPlan {
  plannedPaidCalls: number;
  classifyCalls: number;
  missingKeys: string[];
}

export function planDryRun(args: CliArgs, caseCount: number): DryRunPlan {
  const env: ModelProviderEnv = { MODEL_PROVIDER: process.env.MODEL_PROVIDER as ModelProvider };

  const perModel = args.models.map((model) => {
    const { provider } = parseRoleModel(env, model);
    if (!isProvider(provider)) {
      return { model, requiredKey: null as string | null, keyPresent: false };
    }
    const requiredKey = KEY_BY_PROVIDER[provider];
    return { model, requiredKey, keyPresent: Boolean(process.env[requiredKey]) };
  });

  const missingKeys = [
    ...new Set(
      perModel
        .filter((m) => m.requiredKey != null && !m.keyPresent)
        .map((m) => m.requiredKey as string),
    ),
  ];

  const classifyCalls = args.models.length * args.repeat * caseCount;

  return { plannedPaidCalls: classifyCalls, classifyCalls, missingKeys };
}

// ---- Report rendering ----

function f3(x: number): string {
  return x.toFixed(3);
}

export interface EnvRecommendation {
  decision: 'own-env' | 'keep-sharing';
  recommendedModelId: string | null;
  incumbentScore: number;
  bestScore: number;
  delta: number;
  reason: string;
}

/** Deterministic markdown render of an eval round. Pure — no I/O. */
export function renderReport(run: EvalRunResult, rec: EnvRecommendation): string {
  const { manifest } = run;
  const ranked = rankAggregates(run.aggregates, manifest.judgeEnabled);
  const winner = ranked[0]?.modelId;

  const lines: string[] = [];

  // ---- Header ----
  lines.push('# TurnInterpreter eval — report', '');
  lines.push(`- **dataset:** ${manifest.datasetId} (\`${manifest.datasetFingerprint}\`)`);
  lines.push(`- **caseCount:** ${manifest.caseCount}`);
  lines.push(`- **threshold:** ${manifest.threshold}`);
  lines.push(`- **repeat:** ${manifest.repeat}`);
  lines.push(`- **judge:** ${manifest.judgeEnabled ? 'enabled' : 'disabled'}`);
  lines.push(`- **models:** ${manifest.models.join(', ')}`);
  lines.push('');

  // ---- Summary table (ranked) ----
  lines.push('## Summary (ranked)', '');
  const header = ['#', 'Model', 'Runs', 'passRate', 'meanScore', 'meanLatencyMs'];
  if (manifest.judgeEnabled) header.push('judgeMean');
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`|${header.map(() => '---').join('|')}|`);

  ranked.forEach((a: ModelAggregate, i: number) => {
    const name = a.modelId === winner ? `★ ${a.modelId}` : a.modelId;
    const row = [
      `${i + 1}`,
      name,
      `${a.runs}`,
      f3(a.passRate),
      f3(a.meanScore),
      `${Math.round(a.meanLatencyMs)}`,
    ];
    if (manifest.judgeEnabled) row.push(a.judgeMean != null ? f3(a.judgeMean) : '—');
    lines.push(`| ${row.join(' | ')} |`);
  });
  lines.push('');
  lines.push('★ = winner (rank #1). **meanScore** is the primary ranked metric (weighted field accuracy).', '');

  // ---- Per-candidate sections ----
  for (const a of ranked) {
    lines.push(`## ${a.modelId}`, '');
    const cand = run.candidates.find((c) => c.modelId === a.modelId);
    if (!cand || !cand.ok || !cand.result) {
      lines.push(`Run failed: ${cand?.error ?? 'no result produced'}.`, '');
      continue;
    }
    const s = cand.result;
    lines.push(
      `verdict: **${s.verdict}** · score ${f3(s.score)} · ` +
        `subjectAccuracy ${f3(s.subjectAccuracy)} · ` +
        `schemaValidRate ${f3(s.schemaValidRate)} · ` +
        `fabricationRate ${f3(s.fabricationRate)}.`,
      '',
    );

    // Per-case table
    const ch = ['Case', 'Lang', 'Subject', 'Score', 'Schema', 'Latency (ms)'];
    lines.push(`| ${ch.join(' | ')} |`);
    lines.push(`|${ch.map(() => '---').join('|')}|`);
    for (const c of s.cases) {
      lines.push(
        `| ${c.id} | ${c.lang} | ${c.subject} | ${f3(c.score)} | ${c.schemaValid ? '✓' : '✗'} | ${c.latencyMs} |`,
      );
    }
    lines.push('');

    // Judge verdicts (when present)
    if (cand.judge && cand.judge.length > 0) {
      lines.push('### Judge verdicts', '');
      for (const j of cand.judge) {
        lines.push(`Overall score: ${f3(j.overallScore)}`);
        for (const d of j.dimensions) lines.push(`- **${d.name}** (${f3(d.score)}): ${d.rationale}`);
        if (j.hallucinations.length) {
          lines.push(`- Hallucinations: ${j.hallucinations.join(', ')}`);
        }
        lines.push(`Notes: ${j.notes}`, '');
      }
    }
  }

  // ---- Env recommendation ----
  lines.push('## Env recommendation', '');
  lines.push(`Env recommendation: ${rec.decision} (${rec.recommendedModelId ?? 'none'}) — Δ${rec.delta.toFixed(3)}`);
  lines.push('');
  lines.push(`- **decision:** ${rec.decision}`);
  lines.push(`- **recommendedModelId:** ${rec.recommendedModelId ?? 'none'}`);
  lines.push(`- **incumbentScore:** ${f3(rec.incumbentScore)}`);
  lines.push(`- **bestScore:** ${f3(rec.bestScore)}`);
  lines.push(`- **delta:** ${rec.delta.toFixed(3)}`);
  lines.push(`- **reason:** ${rec.reason}`);
  lines.push('');

  return `${lines.join('\n')}\n`;
}

// ---- Artifact writing ----

function slugModel(model: string): string {
  return model.replace(/[/:]/g, '_');
}

export function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Writes per-candidate JSON artifacts + manifest.json under outDir.
 * Returns the list of written paths.
 */
export function writeRunArtifacts(outDir: string, meta: ManifestMeta, result: EvalRunResult): string[] {
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];

  for (const cand of result.candidates) {
    const slug = slugModel(cand.modelId);
    const { judge, ...withoutJudge } = cand;
    const runPath = join(outDir, `${slug}.run.json`);
    writeJson(runPath, withoutJudge);
    written.push(runPath);

    if (judge != null && judge.length > 0) {
      const judgePath = join(outDir, `${slug}.judge.json`);
      writeJson(judgePath, judge);
      written.push(judgePath);
    }

    const aggregate = result.aggregates.find((a) => a.modelId === cand.modelId);
    if (aggregate) {
      const aggPath = join(outDir, `${slug}.aggregate.json`);
      writeJson(aggPath, aggregate);
      written.push(aggPath);
    }
  }

  const manifestPath = join(outDir, 'manifest.json');
  writeJson(manifestPath, {
    datasetId: meta.datasetId,
    datasetFingerprint: meta.datasetFingerprint,
    models: meta.models,
    repeat: meta.repeat,
    threshold: meta.threshold,
    caseCount: meta.caseCount,
    judgeEnabled: meta.judgeEnabled,
    aggregates: result.aggregates,
  });
  written.push(manifestPath);

  return written;
}

/** Writes report.md into outDir and returns its path. Content is exactly renderReport(...). */
export function writeReport(outDir: string, result: EvalRunResult, rec: EnvRecommendation): string {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, 'report.md');
  writeFileSync(path, renderReport(result, rec), 'utf8');
  return path;
}
