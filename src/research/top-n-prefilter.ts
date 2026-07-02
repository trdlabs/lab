import type { GridPoint } from './param-grid.ts';
import type { BacktestMetricBlock } from '../ports/platform-gateway.port.ts';

export interface GridResult {
  point: GridPoint;
  paramsHash: string;
  status: 'completed' | 'rejected' | 'pending';
  strategyBacktestRunId: string;
  metrics?: BacktestMetricBlock;
  tradeCount?: number;
}

export interface RankedPoint extends GridResult {
  status: 'completed';
  metrics: BacktestMetricBlock;
  lowConfidence: boolean;
}

export function rankTopN(
  results: GridResult[],
  opts: { n: number; minTradesTrain: number },
): RankedPoint[] {
  // Filter: status === 'completed' && totalTrades > 0
  const filtered = results.filter((r) => {
    if (r.status !== 'completed') return false;
    if (!r.metrics) return false;
    if (r.metrics.totalTrades === 0) return false;
    return true;
  });

  // Map to RankedPoint with lowConfidence flag
  const ranked = filtered.map((r) => {
    const lowConfidence = r.metrics!.totalTrades < opts.minTradesTrain;
    return {
      ...r,
      status: 'completed' as const,
      metrics: r.metrics!,
      lowConfidence,
    };
  });

  // Sort: lowConfidence (false first), then sharpe desc, profitFactor desc, maxDrawdownPct asc, netPnlPct desc
  ranked.sort((a, b) => {
    // lowConfidence: false comes before true
    if (a.lowConfidence !== b.lowConfidence) {
      return a.lowConfidence ? 1 : -1;
    }

    // sharpe desc
    if (a.metrics.sharpe !== b.metrics.sharpe) {
      return b.metrics.sharpe - a.metrics.sharpe;
    }

    // profitFactor desc
    if (a.metrics.profitFactor !== b.metrics.profitFactor) {
      return b.metrics.profitFactor - a.metrics.profitFactor;
    }

    // maxDrawdownPct asc (lower is better)
    if (a.metrics.maxDrawdownPct !== b.metrics.maxDrawdownPct) {
      return a.metrics.maxDrawdownPct - b.metrics.maxDrawdownPct;
    }

    // netPnlPct desc
    return b.metrics.netPnlPct - a.metrics.netPnlPct;
  });

  // Take n results
  return ranked.slice(0, opts.n);
}
