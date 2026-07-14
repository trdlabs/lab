import { describe, it, expect } from 'vitest';
import { buildCycleScorecard, type CycleScorecardSnapshot } from './cycle-scorecard-builder.ts';
import { DEFAULT_REVISION_EVALUATOR_POLICY } from '../validation/revision-evaluator.ts';

import type { StrategyRevision, HoldoutValidation } from '../domain/strategy-revision.ts';

const M = (o: Record<string, number> = {}) => ({
  netPnlUsd: 1000, netPnlPct: 10, totalTrades: 50, winRate: 0.55, profitFactor: 2,
  maxDrawdownPct: 10, expectancyUsd: 20, sharpe: 1, topTradeContributionPct: 20, ...o,
});

// Full StrategyRevision factory — NO `as never`; tsc checks the shape.
const rev = (over: Partial<StrategyRevision>): StrategyRevision => ({
  id: 'r1', strategyProfileId: 'p1', version: 2, hypothesisIds: [], dropped: [],
  mergedRuleSet: { order: [], rules: [] }, status: 'rejected', createdAt: 'now', updatedAt: 'now', ...over,
});

function baseSnapshot(over: Partial<CycleScorecardSnapshot> = {}): CycleScorecardSnapshot {
  return {
    correlationId: 'c1', strategyProfileId: 'p1', sourceTaskId: 't1',
    terminalOutcome: { kind: 'accepted', reason: 'pnl_improved' },
    eligibleHypIds: ['h1', 'h2'], consideredHypIds: ['h1', 'h2'],
    revision: null,
    hypotheses: [
      { hypId: 'h1', status: 'merged', lastDecision: 'PASS', evaluated: true },
      { hypId: 'h2', status: 'proxy_passed', lastDecision: 'PASS', evaluated: true },
    ],
    ...over,
  };
}

describe('buildCycleScorecard', () => {
  it('accepted champion: deltas computed, champion set, selected=1', () => {
    const revision = rev({
      status: 'accepted', hypothesisIds: ['h1'], verdictReason: 'pnl_improved',
      selectionEvaluation: {
        evaluatorVersion: 'revision-combo-v1', baselineMetrics: M({ netPnlUsd: 800 }), candidateMetrics: M({ netPnlUsd: 1000 }),
        thresholds: DEFAULT_REVISION_EVALUATOR_POLICY, decision: 'ACCEPT', reasons: ['pnl_improved'],
      },
    });
    const sc = buildCycleScorecard(baseSnapshot({ revision }));
    expect(sc.champion).toEqual({ revisionId: 'r1', version: 2 });
    expect(sc.counts.selected).toBe(1);
    expect(sc.revisionAssessment!.aggregate!.deltas.netPnlUsd).toBe(200); // 1000 - 800
    expect(sc.counts.eligible).toBe(2);
  });

  it('rejected: champion null, revisionAssessment carries aggregate, selected=0', () => {
    const revision = rev({
      status: 'rejected', hypothesisIds: ['h1'], verdictReason: 'drawdown_regression',
      selectionEvaluation: { evaluatorVersion: 'revision-combo-v1', baselineMetrics: M(), candidateMetrics: M({ maxDrawdownPct: 20 }),
        thresholds: DEFAULT_REVISION_EVALUATOR_POLICY, decision: 'REJECT', reasons: ['drawdown_regression'] },
    });
    const sc = buildCycleScorecard(baseSnapshot({ terminalOutcome: { kind: 'rejected', reason: 'drawdown_regression' }, revision }));
    expect(sc.champion).toBeNull();
    expect(sc.counts.selected).toBe(0);
    expect(sc.revisionAssessment!.aggregate!.decision).toBe('REJECT');
  });

  it('rejected with no selectionEvaluation → aggregate null (final attempt no comparison / consolidated)', () => {
    const revision = rev({ status: 'rejected', hypothesisIds: ['h1'], verdictReason: 'comparison_baseline_unavailable', selectionEvaluation: undefined });
    const sc = buildCycleScorecard(baseSnapshot({ terminalOutcome: { kind: 'rejected', reason: 'comparison_baseline_unavailable' }, revision }));
    expect(sc.revisionAssessment!.aggregate).toBeNull();
    expect(sc.champion).toBeNull();
  });

  it('abandoned/no_baseline (sets null) → eligible/considered null + reason', () => {
    const sc = buildCycleScorecard(baseSnapshot({
      terminalOutcome: { kind: 'abandoned', reason: 'wait_cap_exhausted' },
      eligibleHypIds: null, consideredHypIds: null, revision: null,
    }));
    expect(sc.revisionAssessment).toBeNull();
    expect(sc.counts.eligible).toBeNull();
    expect(sc.eligibleUnavailableReason).toBe('terminated_before_selection');
    expect(sc.selectionBias.n).toBeNull();
  });

  it('no_eligible_hypotheses (empty sets, NOT null) → eligible=0, no unavailable reason', () => {
    const sc = buildCycleScorecard(baseSnapshot({
      terminalOutcome: { kind: 'skipped', reason: 'no_eligible_hypotheses' },
      eligibleHypIds: [], consideredHypIds: [], revision: null,
    }));
    expect(sc.counts.eligible).toBe(0);            // selection ran, found nothing — a KNOWN 0
    expect(sc.eligibleUnavailableReason).toBeUndefined();
    expect(sc.selectionBias.n).toBe(0);
  });

  it('dropped is a union by hypId (status dropped_* ∪ revision.dropped, no double count)', () => {
    const revision = rev({ status: 'rejected', hypothesisIds: [], dropped: [{ hypothesisId: 'h1', reason: 'combo_fail_dropped', detail: 'merge conflict' }], verdictReason: 'x', selectionEvaluation: undefined });
    const sc = buildCycleScorecard(baseSnapshot({
      terminalOutcome: { kind: 'rejected', reason: 'x' }, revision,
      hypotheses: [{ hypId: 'h1', status: 'dropped_combo_fail', lastDecision: 'FAIL', evaluated: true }],
    }));
    expect(sc.counts.dropped).toBe(1); // h1 in both sources → counted once
  });

  it('accepted CONSOLIDATED revision (no selectionEvaluation) → champion set, aggregate null', () => {
    // G3b path uses evaluateConsolidation, not evaluateRevision → kind:'consolidated' rows have no selectionEvaluation.
    const revision = rev({ status: 'accepted', kind: 'consolidated', hypothesisIds: ['h1'], verdictReason: 'consolidated', selectionEvaluation: undefined });
    const sc = buildCycleScorecard(baseSnapshot({ revision }));
    expect(sc.champion).toEqual({ revisionId: 'r1', version: 2 });   // still a champion
    expect(sc.revisionAssessment!.aggregate).toBeNull();             // but no aggregate to show
  });

  it('rejected: tradeSplit (preservationGate) + robustness (holdoutValidation) carried onto revisionAssessment', () => {
    const holdout = { mode: 'trade_based', reason: 'holdout_failed', holdoutDecision: 'REJECT', holdoutReasons: ['drawdown_regression'] } as HoldoutValidation;
    const preservation = { fired: true } as never; // adapt to the real PreservationMetadata shape (src/validation/trade-preservation.ts)
    const revision = rev({ status: 'rejected', hypothesisIds: ['h1'], verdictReason: 'holdout_failed', preservationGate: preservation, holdoutValidation: holdout, selectionEvaluation: undefined });
    const sc = buildCycleScorecard(baseSnapshot({ terminalOutcome: { kind: 'rejected', reason: 'holdout_failed' }, revision }));
    expect(sc.revisionAssessment!.tradeSplit).toBe(preservation);    // R2 veto visible even on a rejected row
    expect(sc.revisionAssessment!.robustness).toBe(holdout);         // R3a holdout verdict visible
  });
});
