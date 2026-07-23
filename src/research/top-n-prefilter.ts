import type { GridPoint } from './param-grid.ts';
import type { BacktestMetricBlock } from '../ports/platform-gateway.port.ts';
import { stableStringify } from '../orchestrator/handlers/backtest-support.ts';

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
  /** R3 (report-13 gap G3): true when this point's axial-grid neighbors are far weaker — a
   *  classic overfit-to-noise signature. Informational rank-demotion only; never drops a point. */
  lonePeak: boolean;
  /** Median sharpe of the valid (completed, totalTrades>0) axial neighbors. Absent when fewer
   *  than 2 valid neighbors exist (see `plateauEvidence`). */
  neighborSharpeMedian?: number;
  /** Count of valid axial neighbors found in the FULL grid (`results`), not just the top-N. */
  neighborCount?: number;
  /** Set only when there weren't enough valid neighbors to judge plateau vs. peak — the point
   *  is never penalized for missing data (grid edge, or a single-point grid). */
  plateauEvidence?: 'insufficient_neighbors';
}

/** PRELIMINARY — pending SSOT threshold pinning (research-validation-hardening item 7). A point
 *  is `lone_peak` when its axial-neighbor sharpe median falls below this fraction of its own
 *  sharpe. Rank-demotion only — see requirement 3's sort-key placement below. */
export const LONE_PEAK_NEIGHBOR_RATIO = 0.5;

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Sorted-unique-value index per grid-param key, built from the FULL grid actually present in
 * `results` — not the declared param-grid definition — so "one step along an axis" always
 * matches the real sweep (including a merged/partial grid). Numeric axes sort numerically;
 * any other value type falls back to a deterministic lexicographic string compare.
 */
function buildAxisIndex(results: GridResult[]): Map<string, Map<string, number>> {
  const valuesByKey = new Map<string, unknown[]>();
  for (const r of results) {
    for (const [k, v] of Object.entries(r.point)) {
      if (!valuesByKey.has(k)) valuesByKey.set(k, []);
      valuesByKey.get(k)!.push(v);
    }
  }

  const axisIndex = new Map<string, Map<string, number>>();
  for (const [k, vals] of valuesByKey) {
    const seen = new Map<string, unknown>();
    for (const v of vals) {
      const s = stableStringify(v);
      if (!seen.has(s)) seen.set(s, v);
    }
    const unique = [...seen.values()].sort((a, b) => (
      typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))
    ));
    const idx = new Map<string, number>();
    unique.forEach((v, i) => idx.set(stableStringify(v), i));
    axisIndex.set(k, idx);
  }
  return axisIndex;
}

/**
 * True when `b` is an axial (Von Neumann — no diagonals) grid neighbor of `a`: they differ in
 * EXACTLY one param key, and that key's value is exactly one step away in the axis's
 * sorted-unique-value order. Two grid points from unrelated sweeps (disjoint key sets) always
 * differ in ≥2 keys and are correctly never neighbors of each other.
 */
function isAxialNeighbor(a: GridPoint, b: GridPoint, axisIndex: Map<string, Map<string, number>>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let diffKey: string | null = null;
  for (const k of keys) {
    if (stableStringify(a[k]) === stableStringify(b[k])) continue;
    if (diffKey !== null) return false; // more than one differing key — not axial
    diffKey = k;
  }
  if (diffKey === null) return false; // identical point — not a neighbor of itself

  const idx = axisIndex.get(diffKey);
  const ai = idx?.get(stableStringify(a[diffKey]));
  const bi = idx?.get(stableStringify(b[diffKey]));
  if (ai === undefined || bi === undefined) return false;
  return Math.abs(ai - bi) === 1;
}

function isValidNeighbor(r: GridResult): boolean {
  return r.status === 'completed' && r.metrics !== undefined && r.metrics.totalTrades > 0;
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

  // R3: neighbor pool is the FULL grid (`results`), not just `filtered`/top-N — an axis index
  // built once up front, reused for every candidate below.
  const axisIndex = buildAxisIndex(results);

  // Map to RankedPoint with lowConfidence + lone_peak/plateau fields
  const ranked: RankedPoint[] = filtered.map((r) => {
    const lowConfidence = r.metrics!.totalTrades < opts.minTradesTrain;

    const neighbors = results.filter((other) => other !== r && isAxialNeighbor(r.point, other.point, axisIndex));
    const validNeighbors = neighbors.filter(isValidNeighbor);
    const neighborCount = validNeighbors.length;

    let lonePeak = false;
    let neighborSharpeMedian: number | undefined;
    let plateauEvidence: 'insufficient_neighbors' | undefined;

    if (neighborCount < 2) {
      // Not enough data to judge plateau vs. peak — never penalize for missing neighbors.
      plateauEvidence = 'insufficient_neighbors';
    } else {
      neighborSharpeMedian = median(validNeighbors.map((n) => n.metrics!.sharpe));
      if (r.metrics!.sharpe > 0 && neighborSharpeMedian < LONE_PEAK_NEIGHBOR_RATIO * r.metrics!.sharpe) {
        lonePeak = true;
      }
    }

    return {
      ...r,
      status: 'completed' as const,
      metrics: r.metrics!,
      lowConfidence,
      lonePeak,
      neighborCount,
      ...(neighborSharpeMedian !== undefined ? { neighborSharpeMedian } : {}),
      ...(plateauEvidence ? { plateauEvidence } : {}),
    };
  });

  // Sort: lowConfidence (false first), then lonePeak (false first), then sharpe desc,
  // profitFactor desc, maxDrawdownPct asc, netPnlPct desc
  ranked.sort((a, b) => {
    // lowConfidence: false comes before true
    if (a.lowConfidence !== b.lowConfidence) {
      return a.lowConfidence ? 1 : -1;
    }

    // lonePeak: false comes before true (R3 — inserted right after lowConfidence)
    if (a.lonePeak !== b.lonePeak) {
      return a.lonePeak ? 1 : -1;
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
