import { describe, it, expect } from 'vitest';
import { evaluateExperiment } from './experiment-evaluator.ts';
import { comparisonSummary } from './__fixtures__/comparison-summary.ts';
import type { HoldoutBoundary } from '../domain/research-experiment.ts';

const fullBoundary: HoldoutBoundary = { mode: 'trade_based', t: '2026-02-01T00:00:00.000Z', trainTrades: 60, holdoutTrades: 30, lowConfidence: false, reason: 'ok' };
const lowConf: HoldoutBoundary = { ...fullBoundary, holdoutTrades: 20, lowConfidence: true };

describe('evaluateExperiment', () => {
  it('train pass + holdout fail → FAIL holdout_failed + overfit', () => {
    const r = evaluateExperiment({ train: comparisonSummary('strong'), holdout: comparisonSummary('fail'), boundary: fullBoundary });
    expect(r.verdict).toBe('FAIL');
    expect(r.verdictReason).toBe('holdout_failed');
    expect(r.flags.overfit).toBe(true);
  });
  it('train pass + holdout strong → PAPER_CANDIDATE', () => {
    const r = evaluateExperiment({ train: comparisonSummary('strong'), holdout: comparisonSummary('strong'), boundary: fullBoundary });
    expect(r.verdict).toBe('PAPER_CANDIDATE');
  });
  it('lowConfidence holdout → INCONCLUSIVE + flag even if holdout passes', () => {
    const r = evaluateExperiment({ train: comparisonSummary('strong'), holdout: comparisonSummary('strong'), boundary: lowConf });
    expect(r.verdict).toBe('INCONCLUSIVE');
    expect(r.flags.lowConfidenceHoldout).toBe(true);
  });
  it('train fail → short-circuit FAIL, reason train_*', () => {
    const r = evaluateExperiment({ train: comparisonSummary('fail'), holdout: comparisonSummary('strong'), boundary: fullBoundary });
    expect(r.verdict).toBe('FAIL');
    expect(r.verdictReason?.startsWith('train_')).toBe(true);
  });
  it('train low sample → INCONCLUSIVE train_*', () => {
    const r = evaluateExperiment({ train: comparisonSummary('lowsample'), holdout: comparisonSummary('strong'), boundary: fullBoundary });
    expect(r.verdict).toBe('INCONCLUSIVE');
    expect(r.verdictReason?.startsWith('train_')).toBe(true);
  });
  it('holdout missing → INCONCLUSIVE', () => {
    const r = evaluateExperiment({ train: comparisonSummary('strong'), boundary: fullBoundary });
    expect(r.verdict).toBe('INCONCLUSIVE');
    expect(r.verdictReason).toBe('holdout_not_run');
  });
});
