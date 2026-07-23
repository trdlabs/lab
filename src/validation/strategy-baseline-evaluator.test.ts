import { describe, it, expect } from 'vitest';
import { evaluateStrategyBaseline, OOS_DEGRADATION_THRESHOLD_VERSION } from './strategy-baseline-evaluator.ts';
import type { BacktestMetricBlock } from '../ports/platform-gateway.port.ts';

const good = { netPnlUsd: 10, netPnlPct: 1, totalTrades: 40, winRate: 0.6, profitFactor: 1.6, maxDrawdownPct: 8, expectancyUsd: 2, sharpe: 1.2, topTradeContributionPct: 20 };
const bad = { ...good, profitFactor: 0.7, sharpe: -0.3 };
const viableBoundary = { mode: 'trade_based' as const, t: 'T', trainTrades: 60, holdoutTrades: 35, lowConfidence: false, reason: 'ok' as const };
const lowConf = { ...viableBoundary, holdoutTrades: 18, lowConfidence: true };

describe('evaluateStrategyBaseline', () => {
  it('viable survived holdout → PAPER_CANDIDATE', () => {
    expect(evaluateStrategyBaseline({ holdout: good, boundary: viableBoundary }).verdict).toBe('PAPER_CANDIDATE');
  });
  it('below-floor holdout → FAIL', () => {
    const r = evaluateStrategyBaseline({ holdout: bad, boundary: viableBoundary });
    expect(r.verdict).toBe('FAIL');
  });
  it('low-confidence holdout → INCONCLUSIVE even if metrics pass', () => {
    const r = evaluateStrategyBaseline({ holdout: good, boundary: lowConf });
    expect(r.verdict).toBe('INCONCLUSIVE');
    expect(r.flags.lowConfidenceHoldout).toBe(true);
  });
});

// R2 (research-validation-hardening item 2, report-13 gap G2): IS→OOS degradation metric,
// log-mode only — computes + records but never changes the verdict/reason.
describe('evaluateStrategyBaseline — oos_degradation (log-mode, R2)', () => {
  const isViable: BacktestMetricBlock = { ...good, sharpe: 2.0, profitFactor: 1.6 };

  it('degraded OOS vs IS → ratio computed + fragility flag set, verdict UNCHANGED (log-only)', () => {
    const oosDegraded: BacktestMetricBlock = { ...good, sharpe: 0.4 }; // still clears the floor (sharpe>0, PF>=1)
    const r = evaluateStrategyBaseline({ train: isViable, holdout: oosDegraded, boundary: viableBoundary });

    expect(r.verdict).toBe('PAPER_CANDIDATE'); // pinned: degradation never flips the verdict
    const deg = (r.rawScores as { oosDegradation: Record<string, unknown> }).oosDegradation;
    expect(deg.oosIsSharpeRatio).toBeCloseTo(0.2, 5);
    expect(deg.isSharpe).toBe(2.0);
    expect(deg.oosSharpe).toBe(0.4);
    expect(deg.thresholdVersion).toBe(OOS_DEGRADATION_THRESHOLD_VERSION);
    expect(r.flags.fragility).toContain('oos_degradation');
  });

  it('healthy candidate: ratio ≥ preliminary 0.5 floor → no fragility flag', () => {
    const oosHealthy: BacktestMetricBlock = { ...good, sharpe: 1.2 }; // 1.2 / 2.0 = 0.6
    const r = evaluateStrategyBaseline({ train: isViable, holdout: oosHealthy, boundary: viableBoundary });

    const deg = (r.rawScores as { oosDegradation: Record<string, unknown> }).oosDegradation;
    expect(deg.oosIsSharpeRatio).toBeCloseTo(0.6, 5);
    expect(r.flags.fragility).not.toContain('oos_degradation');
  });

  it('IS block absent → ratio null with reason, ladder behavior identical to pre-R2 (pins existing verdicts)', () => {
    const r1 = evaluateStrategyBaseline({ holdout: good, boundary: viableBoundary }); // no `train`
    expect(r1.verdict).toBe('PAPER_CANDIDATE');
    expect((r1.rawScores as { oosDegradation: Record<string, unknown> }).oosDegradation).toEqual({
      oosIsSharpeRatio: null, oosIsPfRatio: null, oosSharpe: good.sharpe, oosPF: good.profitFactor,
      thresholdVersion: OOS_DEGRADATION_THRESHOLD_VERSION, reason: 'is_baseline_nonpositive',
    });
    expect(r1.flags.fragility).toEqual([]);

    const r2 = evaluateStrategyBaseline({ holdout: bad, boundary: viableBoundary }); // no `train`, below floor
    expect(r2.verdict).toBe('FAIL'); // unchanged from the pre-R2 ladder
  });

  it('IS non-positive (sharpe<=0 or PF<=1) → ratio null with reason, never a division by an invalid baseline', () => {
    const isNonPositiveSharpe: BacktestMetricBlock = { ...good, sharpe: 0, profitFactor: 1.6 };
    const r = evaluateStrategyBaseline({ train: isNonPositiveSharpe, holdout: good, boundary: viableBoundary });
    const deg = (r.rawScores as { oosDegradation: Record<string, unknown> }).oosDegradation;
    expect(deg.oosIsSharpeRatio).toBeNull();
    expect(deg.reason).toBe('is_baseline_nonpositive');
    expect(r.flags.fragility).toEqual([]);

    const isNonPositivePf: BacktestMetricBlock = { ...good, sharpe: 2.0, profitFactor: 1.0 };
    const r2 = evaluateStrategyBaseline({ train: isNonPositivePf, holdout: good, boundary: viableBoundary });
    const deg2 = (r2.rawScores as { oosDegradation: Record<string, unknown> }).oosDegradation;
    expect(deg2.oosIsPfRatio).toBeNull();
    expect(deg2.reason).toBe('is_baseline_nonpositive');
  });
});
