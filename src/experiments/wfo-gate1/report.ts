// src/experiments/wfo-gate1/report.ts
// Pure, testable helpers for the WFO Gate-1 eval CLI: argument parsing, dry-run planning,
// markdown report rendering, and artifact writing. No model construction here.
// Mirror of src/experiments/turn-interpreter/report.ts conventions.
import { parseArgs as nodeParseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MODEL_PROVIDERS, type ModelProvider, type ModelProviderEnv } from '../../adapters/llm/model-provider.ts';
import type { EvalRunResult, ManifestMeta, ModelAggregate } from './eval-harness.ts';
import type { FrontierVerdict } from './aggregate.ts';

// ---- Env key mapping (mirrors turn-interpreter/report.ts) ----

export const KEY_BY_PROVIDER: Record<ModelProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

const PROVIDER_PREFIXES = new Set<string>(MODEL_PROVIDERS);

function isProvider(value: string | undefined): value is ModelProvider {
  return value != null && (MODEL_PROVIDERS as readonly string[]).includes(value);
}

/** Resolve a model's provider from its explicit `anthropic/|openai/|openrouter/` prefix,
 *  else fall back to env.MODEL_PROVIDER. Never throws — returns undefined when neither resolves. */
function resolveProviderForDryRun(model: string, env: DryRunEnv): ModelProvider | undefined {
  const slash = model.indexOf('/');
  if (slash > 0) {
    const head = model.slice(0, slash);
    if (PROVIDER_PREFIXES.has(head)) {
      return head as ModelProvider;
    }
  }
  return isProvider(env.MODEL_PROVIDER) ? env.MODEL_PROVIDER : undefined;
}

// ---- CLI args ----

export interface CliArgs {
  models: string[];
  snapshot: string | undefined;
  run: boolean;
  label: boolean;
  threshold: number;
  repeat: number;
  teacherModel: string | undefined;
  source: string | undefined;
}

const DEFAULT_THRESHOLD = 0.9;

export function parseArgs(argv: string[]): CliArgs {
  const { values } = nodeParseArgs({
    args: argv,
    options: {
      models: { type: 'string' },
      snapshot: { type: 'string' },
      run: { type: 'boolean', default: false },
      label: { type: 'boolean', default: false },
      threshold: { type: 'string', default: String(DEFAULT_THRESHOLD) },
      repeat: { type: 'string', default: '1' },
      'teacher-model': { type: 'string' },
      source: { type: 'string' },
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

  if (values.run && !values.snapshot) {
    throw new Error('--run requires --snapshot <snapshotId>');
  }

  if (values.label && !values['teacher-model']) {
    throw new Error('--label requires --teacher-model <provider/model>');
  }

  return {
    models,
    snapshot: values.snapshot,
    run: values.run!,
    label: values.label!,
    threshold,
    repeat,
    teacherModel: values['teacher-model'],
    source: values.source,
  };
}

// ---- Dry-run plan ----

export interface DryRunPlan {
  mode: 'dry-run';
  plannedPaidCalls: number;
  classifyCalls: number;
  caseCount: number;
  models: string[];
  missingKeys: string[];
}

export type DryRunEnv = Partial<ModelProviderEnv> & { MODEL_PROVIDER?: ModelProvider };

/** Must never throw on missing paid env — reports exactly what a --run would need. */
export function planDryRun(args: CliArgs, env: DryRunEnv, caseCount: number): DryRunPlan {
  const missingKeys: string[] = [];

  for (const model of args.models) {
    const provider = resolveProviderForDryRun(model, env);
    if (provider == null) {
      missingKeys.push('MODEL_PROVIDER (unset)');
      continue;
    }
    const requiredKey = KEY_BY_PROVIDER[provider];
    if (!env[requiredKey as keyof DryRunEnv]) {
      missingKeys.push(requiredKey);
    }
  }

  const classifyCalls = args.models.length * args.repeat * caseCount;

  return {
    mode: 'dry-run',
    plannedPaidCalls: classifyCalls,
    classifyCalls,
    caseCount,
    models: args.models,
    missingKeys: [...new Set(missingKeys)],
  };
}

// ---- Report rendering ----

function f3(x: number): string {
  return x.toFixed(3);
}

/** Deterministic markdown render of an eval round. Pure — no I/O. */
export function renderReport(run: EvalRunResult, verdict: FrontierVerdict): string {
  const { manifest } = run;
  const lines: string[] = [];

  if (manifest.teacherCircular) {
    lines.push(
      `> ⚠ **teacher-circular**: candidate == teacher (${manifest.teacherModel}); teacher-labeled accuracy is not independent.`,
      '',
    );
  }

  // ---- Header ----
  lines.push('# WFO Gate-1 eval — report', '');
  lines.push(`- **snapshot:** ${manifest.snapshotId}`);
  lines.push(`- **caseCount:** ${manifest.caseCount}`);
  lines.push(`- **threshold:** ${manifest.threshold}`);
  lines.push(`- **repeat:** ${manifest.repeat}`);
  lines.push(`- **models:** ${manifest.models.join(', ')}`);
  lines.push('');

  // ---- Frontier verdict headline ----
  const verdictLabel = verdict.passes ? 'PASS' : 'FAIL';
  lines.push(`## Frontier verdict: ${verdictLabel}`, '');
  lines.push(`${verdictLabel} — ${verdict.reason}`, '');

  // ---- Aggregate table ----
  lines.push('## Aggregates', '');
  const header = ['Model', 'Provider', 'Accuracy', 'OracleAcc', 'TeacherAcc', 'PassRate', 'MeanLatencyMs', 'Verdict'];
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`|${header.map(() => '---').join('|')}|`);

  for (const a of run.aggregates as ModelAggregate[]) {
    const rowVerdict = a.passRate >= 1 ? 'PASS' : 'FAIL';
    const row = [
      a.modelId,
      a.provider,
      f3(a.accuracy),
      f3(a.oracleAccuracy),
      f3(a.teacherAccuracy),
      f3(a.passRate),
      `${Math.round(a.meanLatencyMs)}`,
      rowVerdict,
    ];
    lines.push(`| ${row.join(' | ')} |`);
  }
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
export function writeRunArtifacts(outDir: string, result: EvalRunResult): string[] {
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];

  for (const cand of result.candidates) {
    const slug = slugModel(cand.modelId);
    const runPath = join(outDir, `${slug}.run.json`);
    writeJson(runPath, cand);
    written.push(runPath);
  }

  const manifestPath = join(outDir, 'manifest.json');
  writeJson(manifestPath, result.manifest satisfies ManifestMeta);
  written.push(manifestPath);

  return written;
}

/** Writes report.md into outDir and returns its path. Content is exactly renderReport(...). */
export function writeReport(outDir: string, result: EvalRunResult, verdict: FrontierVerdict): string {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, 'report.md');
  writeFileSync(path, renderReport(result, verdict), 'utf8');
  return path;
}
