import type { TradeRecord } from '../domain/research-experiment.ts';

export type PreservationReason = 'end_of_data_position' | 'abstention_gaming' | 'winner_degradation';

export interface PreservationThresholds {
  winnerRetention: number;
  maxTradeDropPct: number;
  abstentionShare: number;
  eodShare: number;
  matchToleranceMs: number;
  minWinnerSample: number;
}

export const DEFAULT_PRESERVATION_THRESHOLDS: PreservationThresholds = {
  winnerRetention: 0.9,
  maxTradeDropPct: 20,
  abstentionShare: 0.7,
  eodShare: 0.5,
  matchToleranceMs: 0,
  minWinnerSample: 3,
};

export interface PreservationAggregates {
  baseline: { netPnlUsd: number; totalTrades: number };
  variant: { netPnlUsd: number; totalTrades: number };
}

export interface PreservationMetadata {
  fired: boolean;
  reason: PreservationReason | null;
  metrics: {
    totalDelta: number;
    matchedCount: number;
    disappearedCount: number;
    newCount: number;
    baselineWinnerCount: number;
    eodDelta?: number;
    dropPct?: number;
    removedLosersPnl?: number;
    baselineWinnerGross?: number;
    variantWinnerContribution?: number;
  };
  thresholds: PreservationThresholds;
}

const EOD = 'end_of_data';

interface Indexed { t: TradeRecord; i: number }
function orderKey(x: Indexed, y: Indexed): number {
  return (x.t.entryTs - y.t.entryTs)
    || (x.t.exitTs - y.t.exitTs)
    || (x.t.realizedPnl - y.t.realizedPnl)
    || (x.i - y.i);
}

interface MatchResult {
  matched: Array<{ baseline: TradeRecord; variant: TradeRecord }>;
  disappeared: TradeRecord[];
  newTrades: TradeRecord[];
}

function matchTrades(baseline: TradeRecord[], variant: TradeRecord[], toleranceMs: number): MatchResult {
  const matched: MatchResult['matched'] = [];
  const disappeared: TradeRecord[] = [];
  const newTrades: TradeRecord[] = [];
  for (const side of ['long', 'short'] as const) {
    const bs = baseline.map((t, i) => ({ t, i })).filter((x) => x.t.side === side).sort(orderKey);
    const vs = variant.map((t, i) => ({ t, i })).filter((x) => x.t.side === side).sort(orderKey);
    const usedV = new Set<number>();
    for (const b of bs) {
      let best = -1;
      let bestDist = Infinity;
      for (let k = 0; k < vs.length; k++) {
        if (usedV.has(k)) continue;
        const dist = Math.abs(b.t.entryTs - vs[k]!.t.entryTs);
        if (dist <= toleranceMs && dist < bestDist) { bestDist = dist; best = k; }
      }
      if (best >= 0) { usedV.add(best); matched.push({ baseline: b.t, variant: vs[best]!.t }); }
      else disappeared.push(b.t);
    }
    for (let k = 0; k < vs.length; k++) if (!usedV.has(k)) newTrades.push(vs[k]!.t);
  }
  return { matched, disappeared, newTrades };
}

/**
 * Deterministic trade-level preservation check. Compares baseline-run vs variant-run
 * per-trade records; returns a structured veto verdict. Never mutates inputs; no clock/rng.
 * First-match order: end_of_data_position, abstention_gaming, winner_degradation.
 */
export function evaluateTradePreservation(
  baselineTrades: TradeRecord[],
  variantTrades: TradeRecord[],
  agg: PreservationAggregates,
  t: PreservationThresholds,
): PreservationMetadata {
  const totalDelta = agg.variant.netPnlUsd - agg.baseline.netPnlUsd;
  const { matched, disappeared, newTrades } = matchTrades(baselineTrades, variantTrades, t.matchToleranceMs);
  const winners = baselineTrades.filter((x) => x.realizedPnl > 0);

  const base = {
    totalDelta,
    matchedCount: matched.length,
    disappearedCount: disappeared.length,
    newCount: newTrades.length,
    baselineWinnerCount: winners.length,
  };

  // (1) end_of_data_position → INCONCLUSIVE (handled by the caller's mapping)
  if (totalDelta > 0) {
    let eodDelta = 0;
    for (const m of matched) if (m.variant.closeReason === EOD) eodDelta += Math.max(0, m.variant.realizedPnl - m.baseline.realizedPnl);
    for (const v of newTrades) if (v.closeReason === EOD) eodDelta += Math.max(0, v.realizedPnl);
    if (eodDelta >= t.eodShare * totalDelta) {
      return { fired: true, reason: 'end_of_data_position', metrics: { ...base, eodDelta }, thresholds: t };
    }
  }

  // (2) abstention_gaming → MODIFY
  if (agg.baseline.totalTrades > 0 && totalDelta > 0) {
    const dropPct = ((agg.baseline.totalTrades - agg.variant.totalTrades) / agg.baseline.totalTrades) * 100;
    if (dropPct >= t.maxTradeDropPct) {
      let removedLosersPnl = 0;
      for (const d of disappeared) if (d.realizedPnl < 0) removedLosersPnl += Math.abs(d.realizedPnl);
      if (removedLosersPnl >= t.abstentionShare * totalDelta) {
        return { fired: true, reason: 'abstention_gaming', metrics: { ...base, dropPct, removedLosersPnl }, thresholds: t };
      }
    }
  }

  // (3) winner_degradation → MODIFY
  if (winners.length >= t.minWinnerSample) {
    const baselineWinnerGross = winners.reduce((s, w) => s + w.realizedPnl, 0);
    const variantByBaseline = new Map<TradeRecord, TradeRecord>(matched.map((m) => [m.baseline, m.variant]));
    let variantWinnerContribution = 0;
    for (const w of winners) {
      const v = variantByBaseline.get(w);
      variantWinnerContribution += v ? v.realizedPnl : 0;
    }
    if (variantWinnerContribution < t.winnerRetention * baselineWinnerGross) {
      return { fired: true, reason: 'winner_degradation', metrics: { ...base, baselineWinnerGross, variantWinnerContribution }, thresholds: t };
    }
  }

  return { fired: false, reason: null, metrics: { ...base }, thresholds: t };
}
