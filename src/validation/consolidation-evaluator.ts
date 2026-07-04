import type { BacktestMetricBlock } from '../ports/platform-gateway.port.ts';

export interface ConsolidationTolerances { tolRel: number; tolAbs: number; }
export const DEFAULT_CONSOLIDATION_TOLERANCES: ConsolidationTolerances = { tolRel: 0.001, tolAbs: 0.01 };
export interface ConsolidationDelta { field: string; accepted: number; clean: number; }
export type ConsolidationVerdict =
  | { decision: 'ACCEPT'; reasons: ['parity_ok']; deltas: ConsolidationDelta[] }
  | { decision: 'REJECT'; reasons: string[]; deltas: ConsolidationDelta[] };

// Every scalar field except totalTrades (which must match EXACTLY).
const PARITY_FIELDS = [
  'netPnlUsd', 'netPnlPct', 'winRate', 'profitFactor', 'maxDrawdownPct',
  'expectancyUsd', 'sharpe', 'topTradeContributionPct',
] as const;

export function evaluateConsolidation(
  accepted: BacktestMetricBlock,
  clean: BacktestMetricBlock,
  tol: ConsolidationTolerances = DEFAULT_CONSOLIDATION_TOLERANCES,
): ConsolidationVerdict {
  if (clean.totalTrades !== accepted.totalTrades) {
    return { decision: 'REJECT', reasons: ['trade_count_changed'],
      deltas: [{ field: 'totalTrades', accepted: accepted.totalTrades, clean: clean.totalTrades }] };
  }
  const reasons: string[] = [];
  const deltas: ConsolidationDelta[] = [];
  for (const f of PARITY_FIELDS) {
    const a = (accepted as unknown as Record<string, unknown>)[f];
    const c = (clean as unknown as Record<string, unknown>)[f];
    if (typeof a !== 'number' || typeof c !== 'number') continue; // absent/undefined → skip
    const bound = Math.max(tol.tolAbs, tol.tolRel * Math.abs(a));
    if (Math.abs(c - a) > bound) { reasons.push(`metric_divergence:${f}`); deltas.push({ field: f, accepted: a, clean: c }); }
  }
  if (reasons.length) return { decision: 'REJECT', reasons, deltas };
  return { decision: 'ACCEPT', reasons: ['parity_ok'], deltas: [] };
}
