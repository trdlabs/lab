import { describe, it, expect } from 'vitest';
import { parseArgs, planDryRun, renderReport } from './report.ts';

describe('parseArgs', () => {
  it('defaults to dry run; --run flips it', () => {
    expect(parseArgs(['--models', 'a,b']).run).toBe(false);
    expect(parseArgs(['--models', 'a', '--run']).run).toBe(true);
    expect(parseArgs(['--models', 'a,b']).models).toEqual(['a', 'b']);
  });

  it('parses dataset, threshold, repeat, judge flags', () => {
    const args = parseArgs(['--models', 'x', '--dataset', 'my-dataset', '--threshold', '0.8', '--repeat', '3', '--judge', '--judge-model', 'openai/gpt-4o']);
    expect(args.datasetId).toBe('my-dataset');
    expect(args.threshold).toBe(0.8);
    expect(args.repeat).toBe(3);
    expect(args.judge).toBe(true);
    expect(args.judgeModel).toBe('openai/gpt-4o');
  });
});

describe('planDryRun', () => {
  it('computes paid-call volume = models × repeat × caseCount', () => {
    const plan = planDryRun(parseArgs(['--models', 'a,b', '--repeat', '3']), 10);
    expect(plan.classifyCalls).toBe(2 * 3 * 10);
  });

  it('plannedPaidCalls equals classifyCalls when all keys present or no keys needed', () => {
    const plan = planDryRun(parseArgs(['--models', 'a,b']), 5);
    expect(plan.classifyCalls).toBe(2 * 1 * 5);
    expect(plan.plannedPaidCalls).toBe(plan.classifyCalls);
  });

  it('reports missingKeys when env vars are absent', () => {
    const plan = planDryRun(parseArgs(['--models', 'anthropic/claude-haiku-4-5']), 3);
    // If ANTHROPIC_API_KEY is not set in test env, it should be reported
    if (!process.env.ANTHROPIC_API_KEY) {
      expect(plan.missingKeys).toContain('ANTHROPIC_API_KEY');
    }
  });
});

describe('renderReport', () => {
  it('includes the env recommendation line', () => {
    const run = {
      manifest: {
        datasetId: 'd',
        datasetFingerprint: 'fp',
        models: ['nano', 'strong'],
        repeat: 1,
        threshold: 0.75,
        caseCount: 1,
        judgeEnabled: false,
      },
      candidates: [],
      aggregates: [
        { modelId: 'nano', provider: 'p', runs: 1, meanScore: 0.78, passRate: 1, meanLatencyMs: 100 },
        { modelId: 'strong', provider: 'p', runs: 1, meanScore: 0.90, passRate: 1, meanLatencyMs: 100 },
      ],
    };
    const md = renderReport(run as never, {
      decision: 'own-env',
      recommendedModelId: 'strong',
      incumbentScore: 0.78,
      bestScore: 0.90,
      delta: 0.12,
      reason: 'x',
    });
    expect(md).toContain('own-env');
    expect(md).toContain('strong');
  });

  it('includes keep-sharing decision when no candidate beats incumbent', () => {
    const run = {
      manifest: {
        datasetId: 'd',
        datasetFingerprint: 'fp',
        models: ['m1'],
        repeat: 1,
        threshold: 0.75,
        caseCount: 1,
        judgeEnabled: false,
      },
      candidates: [],
      aggregates: [
        { modelId: 'm1', provider: 'p', runs: 1, meanScore: 0.70, passRate: 0, meanLatencyMs: 50 },
      ],
    };
    const md = renderReport(run as never, {
      decision: 'keep-sharing',
      recommendedModelId: null,
      incumbentScore: 0.70,
      bestScore: 0.70,
      delta: 0,
      reason: 'no candidate beats incumbent',
    });
    expect(md).toContain('keep-sharing');
  });
});
