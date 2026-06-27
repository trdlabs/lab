// src/experiments/strategy-analyst/artifacts.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeRunArtifacts, slugModel, compactTimestamp } from './artifacts.ts';
import type { EvalRunResult, ManifestMeta, CandidateResult, ModelAggregate } from './types.ts';

const ROOT = '.artifacts-test/analyst-eval';

afterEach(() => rmSync('.artifacts-test', { recursive: true, force: true }));

describe('slugModel', () => {
  it('replaces / and : with _', () => {
    expect(slugModel('openrouter/x-ai/grok:beta')).toBe('openrouter_x-ai_grok_beta');
  });
});

describe('compactTimestamp', () => {
  it('formats a Date as compact UTC', () => {
    expect(compactTimestamp(new Date('2026-06-16T15:30:00.000Z'))).toBe('20260616T153000Z');
  });
});

function candidate(over: Partial<CandidateResult> = {}): CandidateResult {
  return {
    model: 'openai/gpt-x', provider: 'openai', modelId: 'gpt-x', latencyMs: 123,
    verdict: 'PASS',
    score: { gates: { schemaValid: true, directionLong: true }, checks: [], score: 0.9, threshold: 0.8, verdict: 'PASS' },
    secondaryScore: null, rawOutput: null, error: null,
    judge: { dimensions: [], overallScore: 0.8, hallucinations: [], missingFromProfile: [], notes: 'n' },
    ...over,
  };
}
function aggregate(over: Partial<ModelAggregate> = {}): ModelAggregate {
  return {
    model: 'openai/gpt-x', provider: 'openai', modelId: 'gpt-x',
    runs: { total: 2, ok: 2, failed: 0, failedByType: {} }, passRate: 1,
    det: { mean: 0.9, median: 0.9, std: 0, min: 0.9, max: 0.9 },
    judge: { mean: 0.8, median: 0.8, std: 0, min: 0.8, max: 0.8 },
    latency: { mean: 123, median: 123 }, ...over,
  };
}

const meta: ManifestMeta = {
  timestamp: '20260616T153000Z', gitSha: 'abc1234', harnessVersion: 'analyst-eval-v1',
  contractVersion: 'strategy-profile-v1', mode: 'run',
};

describe('writeRunArtifacts (repeat-aware)', () => {
  it('writes per-run files, a separate judge file per run, an aggregate file, and a manifest', () => {
    const result: EvalRunResult = {
      fixture: { id: 'long-oi', fingerprint: 'sha256:abc' }, threshold: 0.8, repeat: 2,
      judgeEnabled: true, models: ['openai/gpt-x'],
      perModel: [candidate(), candidate({ judge: null })], // run1 has a judge verdict, run2 does not
      aggregates: [aggregate()],
      overallSuccess: true,
    };
    const outDir = join(ROOT, 'long-oi', meta.timestamp);
    const written = writeRunArtifacts(outDir, meta, result);

    expect(existsSync(join(outDir, 'openai_gpt-x.run1.json'))).toBe(true);
    expect(existsSync(join(outDir, 'openai_gpt-x.run1.judge.json'))).toBe(true);
    expect(existsSync(join(outDir, 'openai_gpt-x.run2.json'))).toBe(true);
    expect(existsSync(join(outDir, 'openai_gpt-x.run2.judge.json'))).toBe(false); // run2 had no judge
    expect(existsSync(join(outDir, 'openai_gpt-x.aggregate.json'))).toBe(true);
    expect(existsSync(join(outDir, 'manifest.json'))).toBe(true);
    // run1 + run1.judge + run2 + aggregate + manifest = 5
    expect(written.length).toBe(5);

    const run1 = JSON.parse(readFileSync(join(outDir, 'openai_gpt-x.run1.json'), 'utf8'));
    expect(run1.judge).toBeUndefined(); // judge excluded from the per-run file
    expect(run1.verdict).toBe('PASS');
    expect(JSON.parse(readFileSync(join(outDir, 'openai_gpt-x.run1.judge.json'), 'utf8')).overallScore).toBe(0.8);

    const agg = JSON.parse(readFileSync(join(outDir, 'openai_gpt-x.aggregate.json'), 'utf8'));
    expect(agg.passRate).toBe(1);
    expect(agg.det.mean).toBe(0.9);

    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'));
    expect(manifest.mode).toBe('run');
    expect(manifest.repeat).toBe(2);
    expect(manifest.contractVersion).toBe('strategy-profile-v1');
    expect(manifest.overallSuccess).toBe(true);
    expect(manifest.perModel).toEqual([{ model: 'openai/gpt-x', aggregate: { passRate: 1, detMean: 0.9, judgeMean: 0.8 } }]);
  });

  it('manifest detMean/judgeMean are null when a model has no scores/judge', () => {
    const result: EvalRunResult = {
      fixture: { id: 'long-oi', fingerprint: 'sha256:abc' }, threshold: 0.8, repeat: 1,
      judgeEnabled: false, models: ['openai/gpt-x'],
      perModel: [candidate({ verdict: 'FAIL', score: null, error: { type: 'schema', message: 'x' }, judge: null })],
      aggregates: [aggregate({ runs: { total: 1, ok: 0, failed: 1, failedByType: { schema: 1 } }, passRate: 0, det: null, judge: null })],
      overallSuccess: false,
    };
    const outDir = join(ROOT, 'long-oi', 'nodet');
    writeRunArtifacts(outDir, meta, result);
    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'));
    expect(manifest.perModel).toEqual([{ model: 'openai/gpt-x', aggregate: { passRate: 0, detMean: null, judgeMean: null } }]);
    expect(existsSync(join(outDir, 'openai_gpt-x.run1.judge.json'))).toBe(false);
  });
});
