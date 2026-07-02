import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseArgs,
  planDryRun,
  renderReport,
  writeRunArtifacts,
  writeReport,
  compactTimestamp,
  KEY_BY_PROVIDER,
} from './report.ts';
import type { CliArgs, DryRunEnv } from './report.ts';
import type { EvalRunResult } from './eval-harness.ts';
import type { FrontierVerdict } from './aggregate.ts';

function baseArgs(overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    models: ['m1'],
    snapshot: undefined,
    run: false,
    label: false,
    threshold: 0.9,
    repeat: 1,
    teacherModel: undefined,
    source: undefined,
    ...overrides,
  };
}

describe('KEY_BY_PROVIDER', () => {
  it('maps all three providers to their env key names', () => {
    expect(KEY_BY_PROVIDER).toEqual({
      anthropic: 'ANTHROPIC_API_KEY',
      openai: 'OPENAI_API_KEY',
      openrouter: 'OPENROUTER_API_KEY',
    });
  });
});

describe('parseArgs', () => {
  it('throws when --run is passed without --snapshot', () => {
    expect(() => parseArgs(['--models', 'm1', '--run'])).toThrow(/--snapshot/);
  });

  it('does not throw when --run is passed with --snapshot', () => {
    const args = parseArgs(['--models', 'm1', '--run', '--snapshot', 'snap-1']);
    expect(args.run).toBe(true);
    expect(args.snapshot).toBe('snap-1');
  });

  it('throws when --label is passed without --teacher-model', () => {
    expect(() => parseArgs(['--models', 'm1', '--label'])).toThrow(/--teacher-model/);
  });

  it('does not throw when --label is passed with --teacher-model', () => {
    const args = parseArgs(['--models', 'm1', '--label', '--teacher-model', 'anthropic/claude-x']);
    expect(args.label).toBe(true);
    expect(args.teacherModel).toBe('anthropic/claude-x');
  });

  it('parses a comma-separated --models list', () => {
    const args = parseArgs(['--models', 'm1,m2, m3']);
    expect(args.models).toEqual(['m1', 'm2', 'm3']);
  });
});

describe('planDryRun', () => {
  it('computes classifyCalls/plannedPaidCalls as models.length * repeat * caseCount', () => {
    const args = baseArgs({ models: ['m1', 'm2'], repeat: 3 });
    const plan = planDryRun(args, { MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' }, 5);
    expect(plan.classifyCalls).toBe(2 * 3 * 5);
    expect(plan.plannedPaidCalls).toBe(2 * 3 * 5);
    expect(plan.caseCount).toBe(5);
    expect(plan.models).toEqual(['m1', 'm2']);
    expect(plan.mode).toBe('dry-run');
  });

  it('lists the missing key for a prefixed model when its API key env var is absent', () => {
    const args = baseArgs({ models: ['openrouter/x'] });
    const env: DryRunEnv = {};
    const plan = planDryRun(args, env, 2);
    expect(plan.missingKeys).toContain('OPENROUTER_API_KEY');
  });

  it('does not throw with an empty env (no MODEL_PROVIDER) and a bare model id, and flags MODEL_PROVIDER as unset', () => {
    const args = baseArgs({ models: ['bare-model-id'] });
    const env: DryRunEnv = {};
    expect(() => planDryRun(args, env, 2)).not.toThrow();
    const plan = planDryRun(args, env, 2);
    expect(plan.missingKeys).toContain('MODEL_PROVIDER (unset)');
  });

  it('does not flag a missing key when the resolved provider key is already present', () => {
    const args = baseArgs({ models: ['anthropic/claude-x'] });
    const env: DryRunEnv = { ANTHROPIC_API_KEY: 'sk-present' };
    const plan = planDryRun(args, env, 2);
    expect(plan.missingKeys).not.toContain('ANTHROPIC_API_KEY');
  });

  it('resolves provider from env.MODEL_PROVIDER for a bare model id and flags the key when absent', () => {
    const args = baseArgs({ models: ['bare-model-id'] });
    const env: DryRunEnv = { MODEL_PROVIDER: 'openai' };
    const plan = planDryRun(args, env, 2);
    expect(plan.missingKeys).toContain('OPENAI_API_KEY');
    expect(plan.missingKeys).not.toContain('MODEL_PROVIDER (unset)');
  });

  it('dedupes missingKeys across multiple models needing the same key', () => {
    const args = baseArgs({ models: ['openai/a', 'openai/b'] });
    const env: DryRunEnv = {};
    const plan = planDryRun(args, env, 2);
    expect(plan.missingKeys.filter((k) => k === 'OPENAI_API_KEY')).toHaveLength(1);
  });
});

function makeRun(overrides: Partial<EvalRunResult> = {}): EvalRunResult {
  return {
    manifest: {
      snapshotId: 'snap-1',
      models: ['m1'],
      repeat: 1,
      threshold: 0.9,
      caseCount: 2,
      teacherModel: null,
      teacherCircular: false,
      harnessVersion: 'wfo-gate1-eval-v1',
      gitSha: 'abc123',
    },
    candidates: [
      {
        modelId: 'm1',
        provider: 'anthropic',
        ok: true,
        result: {
          schemaValidRate: 1,
          accuracy: 0.9,
          oracleAccuracy: 0.9,
          teacherAccuracy: 0,
          reasonOkRate: 1,
          meanScore: 0.95,
          passRate: 1,
          threshold: 0.9,
          verdict: 'PASS',
          cases: [],
        },
      },
    ],
    aggregates: [
      {
        modelId: 'm1',
        provider: 'anthropic',
        runs: 1,
        meanScore: 0.95,
        accuracy: 0.9,
        oracleAccuracy: 0.9,
        teacherAccuracy: 0,
        passRate: 1,
        meanLatencyMs: 42,
      },
    ],
    ...overrides,
  };
}

function makeVerdict(overrides: Partial<FrontierVerdict> = {}): FrontierVerdict {
  return {
    incumbentModelId: 'm1',
    bestModelId: 'm1',
    bestScore: 0.95,
    threshold: 0.9,
    passes: true,
    reason: 'frontier m1 passes (meanScore 0.95 >= 0.9)',
    ...overrides,
  };
}

describe('renderReport', () => {
  it('contains a PASS headline when the verdict passes', () => {
    const md = renderReport(makeRun(), makeVerdict());
    expect(md).toMatch(/PASS/);
  });

  it('contains a FAIL headline when the verdict fails', () => {
    const md = renderReport(makeRun(), makeVerdict({ passes: false, reason: 'frontier m1 below threshold' }));
    expect(md).toMatch(/FAIL/);
  });

  it('includes the aggregate table columns for each model', () => {
    const md = renderReport(makeRun(), makeVerdict());
    expect(md).toContain('m1');
    expect(md).toContain('anthropic');
  });

  it('prepends a teacher-circular banner when manifest.teacherCircular is true', () => {
    const run = makeRun({
      manifest: {
        snapshotId: 'snap-1',
        models: ['m1'],
        repeat: 1,
        threshold: 0.9,
        caseCount: 2,
        teacherModel: 'm1',
        teacherCircular: true,
        harnessVersion: 'wfo-gate1-eval-v1',
        gitSha: 'abc123',
      },
    });
    const md = renderReport(run, makeVerdict());
    expect(md).toContain('teacher-circular');
    expect(md).toContain('m1');
  });

  it('does not include the teacher-circular banner when manifest.teacherCircular is false', () => {
    const md = renderReport(makeRun(), makeVerdict());
    expect(md).not.toContain('teacher-circular');
  });
});

describe('writeRunArtifacts', () => {
  it('writes one JSON per candidate plus manifest.json under outDir', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'wfo-gate1-report-'));
    const run = makeRun();
    const written = writeRunArtifacts(outDir, run);

    expect(written.length).toBeGreaterThanOrEqual(2);
    const manifestPath = join(outDir, 'manifest.json');
    expect(written).toContain(manifestPath);
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.snapshotId).toBe('snap-1');

    for (const p of written) {
      expect(existsSync(p)).toBe(true);
    }
  });
});

describe('writeReport', () => {
  it('writes report.md with renderReport output under outDir and returns its path', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'wfo-gate1-report-'));
    const run = makeRun();
    const verdict = makeVerdict();
    const path = writeReport(outDir, run, verdict);

    expect(path).toBe(join(outDir, 'report.md'));
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf8');
    expect(content).toBe(renderReport(run, verdict));
  });
});

describe('compactTimestamp', () => {
  it('produces a compact, colon/dash-free ISO-like timestamp', () => {
    const ts = compactTimestamp(new Date('2026-07-02T12:34:56.789Z'));
    expect(ts).toBe('20260702T123456Z');
  });
});
