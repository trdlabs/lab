import { describe, it, expect } from 'vitest';
import { FakeGate1 } from './fake-gate1.ts';
import { FakeSweepDesigner } from './fake-sweep-designer.ts';
import { FakeResultInterpreter } from './fake-result-interpreter.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { BacktestMetricBlock } from '../../ports/platform-gateway.port.ts';
import type { RankedPoint } from '../../research/top-n-prefilter.ts';

const fakeProfile = { id: 'p1', coreIdea: 'x', direction: 'long' } as unknown as StrategyProfile;

function mk(overrides: Partial<BacktestMetricBlock>): BacktestMetricBlock {
  return {
    netPnlUsd: 0,
    netPnlPct: 0,
    totalTrades: 0,
    winRate: 0,
    profitFactor: 0,
    maxDrawdownPct: 0,
    expectancyUsd: 0,
    sharpe: 0,
    topTradeContributionPct: 0,
    ...overrides,
  };
}

describe('FakeGate1', () => {
  it('reports fake adapter identity', () => {
    const g = new FakeGate1();
    expect(g.adapter).toBe('fake');
    expect(g.model).toBe('fake');
  });

  it('decides improve when the baseline already has trades', async () => {
    const out = await new FakeGate1().decide({
      profile: fakeProfile,
      baselineMetrics: mk({ totalTrades: 5 }),
      entryAffecting: [],
      hasEntrySignalEvidence: false,
    });
    expect(out.decision).toBe('improve');
  });

  it('needs BOTH entry params AND entry-signal evidence for exploratory', async () => {
    const g = new FakeGate1();
    const base = { profile: fakeProfile, baselineMetrics: mk({ totalTrades: 0 }), entryAffecting: ['dump.minDropPct'] };
    expect((await g.decide({ ...base, hasEntrySignalEvidence: true })).decision).toBe('allow_exploratory_sweep');
    expect((await g.decide({ ...base, hasEntrySignalEvidence: false })).decision).toBe('stop_insufficient_evidence');
    expect(
      (
        await g.decide({
          profile: fakeProfile,
          baselineMetrics: mk({ totalTrades: 0 }),
          entryAffecting: [],
          hasEntrySignalEvidence: true,
        })
      ).decision,
    ).toBe('stop_insufficient_evidence');
  });
});

describe('FakeSweepDesigner', () => {
  it('reports fake adapter identity', () => {
    const s = new FakeSweepDesigner();
    expect(s.adapter).toBe('fake');
    expect(s.model).toBe('fake');
  });

  it('builds a small grid over the first tunable params', async () => {
    const out = await new FakeSweepDesigner().design({
      profile: fakeProfile,
      baselineTrainSummary: mk({ totalTrades: 3 }),
      tunableParams: [
        { name: 'dump.minDropPct', value: 2, unit: '%', description: 'entry filter', tunable: true },
        { name: 'exit.tpPct', value: 1, unit: '%', description: 'take profit', tunable: true },
      ],
      restrictToEntryParams: false,
      maxPoints: 8,
    });
    expect(Object.keys(out.grid).length).toBeGreaterThan(0);
    expect(Object.keys(out.grid).length).toBeLessThanOrEqual(2);
    expect(out.grid['dump.minDropPct']).toEqual([1, 3]);
    expect(out.rationale.length).toBeGreaterThan(0);
  });

  it('restricts the grid to entry-affecting params when requested', async () => {
    const out = await new FakeSweepDesigner().design({
      profile: fakeProfile,
      baselineTrainSummary: mk({ totalTrades: 0 }),
      tunableParams: [
        { name: 'exit.tpPct', value: 1, unit: '%', description: 'take profit', tunable: true },
        { name: 'dump.minDropPct', value: 2, unit: '%', description: 'entry filter', tunable: true },
      ],
      restrictToEntryParams: true,
      maxPoints: 8,
    });
    expect(Object.keys(out.grid)).toEqual(['dump.minDropPct']);
  });
});

describe('FakeResultInterpreter', () => {
  it('reports fake adapter identity', () => {
    const r = new FakeResultInterpreter();
    expect(r.adapter).toBe('fake');
    expect(r.model).toBe('fake');
  });

  it('selects the top point when candidates exist', async () => {
    const topN: RankedPoint[] = [
      {
        point: {},
        paramsHash: 'h',
        status: 'completed',
        strategyBacktestRunId: 'run-1',
        metrics: mk({ totalTrades: 4 }),
        lowConfidence: false,
        lonePeak: false,
      },
    ];
    const out = await new FakeResultInterpreter().interpret({ topN, roundsSoFar: 1, maxRounds: 2 });
    expect(out).toMatchObject({ decision: 'select', chosenParamsHash: 'h' });
  });

  it('stops when there are no top-N candidates', async () => {
    const out = await new FakeResultInterpreter().interpret({ topN: [], roundsSoFar: 1, maxRounds: 2 });
    expect(out.decision).toBe('stop');
  });
});
