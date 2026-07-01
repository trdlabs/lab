import type { ComparisonSummary, BacktestMetricBlock } from '../../ports/platform-gateway.port.ts';

function block(over: Partial<BacktestMetricBlock> = {}): BacktestMetricBlock {
  return {
    netPnlUsd: 0, netPnlPct: 0, totalTrades: 40, winRate: 0.5, profitFactor: 1.6,
    maxDrawdownPct: 5, expectancyUsd: 1, sharpe: 1, topTradeContributionPct: 10, ...over,
  };
}

// kind → evaluateBacktest decision (DEFAULT_EVALUATOR_THRESHOLDS):
//  'strong'    → PAPER_CANDIDATE (delta 200 ≥ 100, pf 1.6 ≥ 1.5, winRate 0.6 ≥ baseline 0.5)
//  'pass'      → PASS            (delta 30 > 0 but not strong)
//  'fail'      → FAIL            (delta -50 ≤ 0)
//  'lowsample' → INCONCLUSIVE    (variant.totalTrades 5 < 20)
export function comparisonSummary(kind: 'strong' | 'pass' | 'fail' | 'lowsample'): ComparisonSummary {
  const baseline = block();
  const variant =
    kind === 'strong' ? block({ netPnlUsd: 200, winRate: 0.6 })
    : kind === 'pass' ? block({ netPnlUsd: 30 })
    : kind === 'fail' ? block({ netPnlUsd: -50 })
    : block({ netPnlUsd: 200, totalTrades: 5 });
  return {
    baseline, variant,
    sampleSize: { baselineTrades: baseline.totalTrades, variantTrades: variant.totalTrades },
    platformContractVersion: 'test.1',
  };
}
