import { describe, it, expect } from 'vitest';
import { rankTopN } from './top-n-prefilter.ts';
import type { GridResult } from './top-n-prefilter.ts';
import type { GridPoint } from './param-grid.ts';
import type { BacktestMetricBlock } from '../ports/platform-gateway.port.ts';
import { scrubMetricsBag } from './outcome-embargo.ts';

const mk = (o: Partial<BacktestMetricBlock>): BacktestMetricBlock => ({
  netPnlUsd: 0,
  netPnlPct: 0,
  totalTrades: 5,
  winRate: 0,
  profitFactor: 1,
  maxDrawdownPct: 0,
  expectancyUsd: 0,
  sharpe: 0,
  topTradeContributionPct: 0,
  ...o,
});

const gr = (
  paramsHash: string,
  m: Partial<BacktestMetricBlock>,
  status: GridResult['status'] = 'completed',
): GridResult => ({
  point: {},
  paramsHash,
  status,
  strategyBacktestRunId: `run-${paramsHash}`,
  metrics: mk(m),
  tradeCount: m.totalTrades ?? 5,
});

describe('rankTopN', () => {
  it('drops zero-trade + non-completed points and ranks trade-gated', () => {
    const res = rankTopN(
      [
        gr('z', { totalTrades: 0, sharpe: 9 }), // dropped (zero-trade)
        gr('r', { totalTrades: 9, sharpe: 9 }, 'rejected'), // dropped (not completed)
        gr('a', { totalTrades: 1, sharpe: 9 }), // low-confidence (< 3)
        gr('b', { totalTrades: 5, sharpe: 2 }),
        gr('c', { totalTrades: 5, sharpe: 3 }),
      ],
      { n: 3, minTradesTrain: 3 },
    );
    expect(res.map((r) => r.paramsHash)).toEqual(['c', 'b', 'a']); // full-conf by sharpe desc, then low-conf last
    expect(res.find((r) => r.paramsHash === 'a')?.lowConfidence).toBe(true);
  });

  it('returns empty when all points are zero-trade', () => {
    expect(rankTopN([gr('x', { totalTrades: 0 })], { n: 3, minTradesTrain: 3 })).toEqual([]);
  });
});

// R3 (research-validation-hardening item 3, report-13 gap G3): plateau/neighbor-stability
// analysis — a "lone peak" (axial neighbors far weaker) is demoted in rank, not dropped.
const grAt = (
  paramsHash: string,
  point: GridPoint,
  m: Partial<BacktestMetricBlock>,
  status: GridResult['status'] = 'completed',
): GridResult => ({
  point,
  paramsHash,
  status,
  strategyBacktestRunId: `run-${paramsHash}`,
  metrics: mk(m),
  tradeCount: m.totalTrades ?? 5,
});

describe('rankTopN — lone_peak plateau analysis (R3)', () => {
  it('3x3 grid: isolated center peak (sharpe 3.0, neighbors ~0.2) ranks BELOW an honest plateau peak (sharpe 2.0, neighbors ~1.8)', () => {
    // Group A: a literal 3x3 grid over (row, col) ∈ {0,1,2}×{0,1,2}. Center (1,1) is the lone
    // peak; its 4 axial neighbors (the edge-midpoints) are all weak.
    const groupA: GridResult[] = [];
    for (const row of [0, 1, 2]) {
      for (const col of [0, 1, 2]) {
        const isCenter = row === 1 && col === 1;
        const isEdgeMid = (row === 1) !== (col === 1); // exactly one axis at the center value
        const sharpe = isCenter ? 3.0 : isEdgeMid ? 0.2 : 0.1; // corners are irrelevant filler
        groupA.push(grAt(`A-${row}-${col}`, { row, col }, { totalTrades: 10, sharpe }));
      }
    }
    // Group B: an independent 1-D line over `line` ∈ {0,1,2} — disjoint param key, so it can
    // never be an axial neighbor of anything in group A (always ≥2 differing keys). The
    // midpoint is an honest peak: sharpe 2.0 with two ~1.8 neighbors (real plateau).
    const groupB: GridResult[] = [
      grAt('B-0', { line: 0 }, { totalTrades: 10, sharpe: 1.8 }),
      grAt('B-1', { line: 1 }, { totalTrades: 10, sharpe: 2.0 }),
      grAt('B-2', { line: 2 }, { totalTrades: 10, sharpe: 1.8 }),
    ];

    const ranked = rankTopN([...groupA, ...groupB], { n: 20, minTradesTrain: 1 });

    const centerA = ranked.find((r) => r.paramsHash === 'A-1-1')!;
    const peakB = ranked.find((r) => r.paramsHash === 'B-1')!;

    expect(centerA.lonePeak).toBe(true);
    expect(centerA.neighborCount).toBe(4);
    expect(centerA.neighborSharpeMedian).toBeCloseTo(0.2, 5);

    expect(peakB.lonePeak).toBe(false);
    expect(peakB.neighborCount).toBe(2);
    expect(peakB.neighborSharpeMedian).toBeCloseTo(1.8, 5);

    // Rank inversion: the lower-sharpe HONEST point outranks the higher-sharpe LONE peak.
    const centerAIndex = ranked.findIndex((r) => r.paramsHash === 'A-1-1');
    const peakBIndex = ranked.findIndex((r) => r.paramsHash === 'B-1');
    expect(peakBIndex).toBeLessThan(centerAIndex);
  });

  it('honest plateau: neighbors of the same order → no lone_peak flag', () => {
    const ranked = rankTopN(
      [
        grAt('p0', { x: 0 }, { totalTrades: 10, sharpe: 0.9 }),
        grAt('p1', { x: 1 }, { totalTrades: 10, sharpe: 1.0 }),
        grAt('p2', { x: 2 }, { totalTrades: 10, sharpe: 1.1 }),
      ],
      { n: 3, minTradesTrain: 1 },
    );
    const p1 = ranked.find((r) => r.paramsHash === 'p1')!;
    expect(p1.lonePeak).toBe(false);
    expect(p1.neighborSharpeMedian).toBeCloseTo(1.0, 5); // median of {0.9, 1.1}
    expect(p1.plateauEvidence).toBeUndefined();
  });

  it('single-point grid → insufficient_neighbors, never penalized', () => {
    const ranked = rankTopN([grAt('solo', { x: 0 }, { totalTrades: 10, sharpe: 5 })], { n: 1, minTradesTrain: 1 });
    expect(ranked[0]!.lonePeak).toBe(false);
    expect(ranked[0]!.plateauEvidence).toBe('insufficient_neighbors');
    expect(ranked[0]!.neighborCount).toBe(0);
  });

  it('grid edge with exactly 1 valid axial neighbor → insufficient_neighbors, never penalized', () => {
    const ranked = rankTopN(
      [
        grAt('edge', { x: 0 }, { totalTrades: 10, sharpe: 5 }),
        grAt('mid', { x: 1 }, { totalTrades: 10, sharpe: 0.1 }),
        // x=2 deliberately absent — 'edge' has only ONE potential neighbor (x=1)
      ],
      { n: 2, minTradesTrain: 1 },
    );
    const edge = ranked.find((r) => r.paramsHash === 'edge')!;
    expect(edge.neighborCount).toBe(1);
    expect(edge.lonePeak).toBe(false);
    expect(edge.plateauEvidence).toBe('insufficient_neighbors');
  });

  it('a rejected/zero-trade neighbor does not count toward neighborCount', () => {
    const ranked = rankTopN(
      [
        grAt('center', { x: 1 }, { totalTrades: 10, sharpe: 5 }),
        grAt('left', { x: 0 }, { totalTrades: 10, sharpe: 0.1 }),
        grAt('right', { x: 2 }, { totalTrades: 0, sharpe: 4.9 }, 'rejected'), // invalid neighbor
      ],
      { n: 3, minTradesTrain: 1 },
    );
    const center = ranked.find((r) => r.paramsHash === 'center')!;
    expect(center.neighborCount).toBe(1); // only 'left' is a valid neighbor
    expect(center.plateauEvidence).toBe('insufficient_neighbors'); // < 2 valid neighbors
  });

  it('determinism: repeated calls on the same input produce the identical order (incl. tie-break)', () => {
    const input = [
      grAt('A-1-1', { row: 1, col: 1 }, { totalTrades: 10, sharpe: 3.0 }),
      grAt('A-0-1', { row: 0, col: 1 }, { totalTrades: 10, sharpe: 0.2 }),
      grAt('A-2-1', { row: 2, col: 1 }, { totalTrades: 10, sharpe: 0.2 }),
      grAt('A-1-0', { row: 1, col: 0 }, { totalTrades: 10, sharpe: 0.2 }),
      grAt('A-1-2', { row: 1, col: 2 }, { totalTrades: 10, sharpe: 0.2 }),
      grAt('B-1', { line: 1 }, { totalTrades: 10, sharpe: 2.0 }),
      grAt('B-0', { line: 0 }, { totalTrades: 10, sharpe: 1.8 }),
      grAt('B-2', { line: 2 }, { totalTrades: 10, sharpe: 1.8 }),
    ];
    const first = rankTopN(input, { n: 20, minTradesTrain: 1 }).map((r) => r.paramsHash);
    const second = rankTopN(input, { n: 20, minTradesTrain: 1 }).map((r) => r.paramsHash);
    expect(second).toEqual(first);
  });

  it('scrub survival: lonePeak/neighborSharpeMedian/neighborCount survive scrubMetricsBag (embargo compat)', () => {
    const ranked = rankTopN(
      [
        grAt('center', { x: 1 }, { totalTrades: 10, sharpe: 3.0 }),
        grAt('left', { x: 0 }, { totalTrades: 10, sharpe: 0.2 }),
        grAt('right', { x: 2 }, { totalTrades: 10, sharpe: 0.2 }),
      ],
      { n: 3, minTradesTrain: 1 },
    );
    const { scrubbed } = scrubMetricsBag(ranked);
    const center = scrubbed.find((r) => r.paramsHash === 'center')!;
    expect(center.lonePeak).toBe(true);
    expect(center.neighborSharpeMedian).toBeCloseTo(0.2, 5);
    expect(center.neighborCount).toBe(2);
  });
});
