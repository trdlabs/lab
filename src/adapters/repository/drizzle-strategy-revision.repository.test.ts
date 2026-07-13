import { describe, it, expect } from 'vitest';
import { strategyRevisionToDomain, type StrategyRevisionRow } from './drizzle-strategy-revision.repository.ts';
import type { PreservationMetadata } from '../../validation/trade-preservation.ts';

const baseRow = (): StrategyRevisionRow => ({
  id: 'rev-1', strategyProfileId: 'profile-1', version: 1,
  baseRevisionId: null,
  hypothesisIds: ['h1'],
  dropped: null,
  mergedRuleSet: { order: ['h1'], rules: [] },
  bundleArtifactRef: null,
  bundleHash: null,
  comboBacktestRunId: null,
  status: 'candidate',
  metrics: null,
  verdictReason: null,
  preservationGate: null,
  holdoutValidation: null,
  kind: 'composed',
  consolidatedFromRevisionId: null,
  semanticParentRevisionId: null,
  compositionDepth: 1,
  baselineValidationStatus: null,
  baselineExperimentId: null,
  baselineTaskId: null,
  createdAt: new Date('2026-07-11T00:00:00Z'),
  updatedAt: new Date('2026-07-11T00:00:00Z'),
});

describe('strategyRevisionToDomain (preservationGate mapping)', () => {
  it('maps a NULL preservation_gate column to undefined', () => {
    const domain = strategyRevisionToDomain(baseRow());
    expect(domain.preservationGate).toBeUndefined();
  });

  it('maps a populated preservation_gate column through verbatim', () => {
    const gate: PreservationMetadata = {
      fired: false,
      reason: null,
      metrics: {
        totalDelta: 0, matchedCount: 3, disappearedCount: 0, newCount: 0, baselineWinnerCount: 2,
      },
      thresholds: {
        winnerRetention: 0.9, maxTradeDropPct: 20, abstentionShare: 0.7, eodShare: 0.5,
        matchToleranceMs: 0, minWinnerSample: 3,
      },
    };
    const domain = strategyRevisionToDomain({ ...baseRow(), preservationGate: gate });
    expect(domain.preservationGate?.fired).toBe(false);
    expect(domain.preservationGate).toEqual(gate);
  });
});

describe('strategyRevisionToDomain (holdoutValidation mapping)', () => {
  it('maps a NULL holdout_validation column to undefined', () => {
    const domain = strategyRevisionToDomain(baseRow());
    expect(domain.holdoutValidation).toBeUndefined();
  });

  it('maps a populated holdout_validation column through verbatim', () => {
    const hv: NonNullable<StrategyRevisionRow['holdoutValidation']> = {
      mode: 'trade_based',
      t: '2026-06-25T00:00:00Z',
      reason: 'holdout_passed',
      lowConfidence: false,
      trainMetrics: { netPnlUsd: 10 },
      holdoutMetrics: { netPnlUsd: 8 },
    };
    const domain = strategyRevisionToDomain({ ...baseRow(), holdoutValidation: hv });
    expect(domain.holdoutValidation?.reason).toBe('holdout_passed');
    expect(domain.holdoutValidation).toEqual(hv);
  });
});
