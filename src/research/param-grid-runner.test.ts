import { describe, it, expect } from 'vitest';
import { ParamGridRunner } from './param-grid-runner.ts';
import type { StrategyExperimentRunExecutor, StrategyExperimentRunRequest } from './strategy-experiment-run-executor.ts';
import type { RunGridInput } from './param-grid-runner.ts';

const bundle = {
  bytes: new Uint8Array(),
  source: '',
  manifest: { id: 'mod_x', version: '1', kind: 'strategy' },
  bundleHash: 'sha256:h',
} as any;
const trainRun = { datasetId: 'd', symbols: ['S'], timeframe: '1h', period: { from: 'a', to: 'b' }, seed: 42 };

// point index i <-> params.x === i (single-key grid, expandGrid preserves value-list order)
const pointIndexOf = (params: Record<string, unknown>): number => Number(params['x']);

const fakeMetrics = (i: number) => ({
  netPnlUsd: 0, netPnlPct: 0, totalTrades: 10 + i, winRate: 0, profitFactor: 1,
  maxDrawdownPct: 0, expectancyUsd: 0, sharpe: i, topTradeContributionPct: 0,
});

const POINTS = 4;
const INPUT: RunGridInput = {
  experimentId: 'e', strategyBundle: bundle, strategyProfileId: 'p', trainRun,
  grid: { x: [0, 1, 2, 3] }, metrics: ['sharpe'], maxPoints: 8, topN: 4, minTradesTrain: 1, foldId: 0,
};
const INPUT_6_POINTS: RunGridInput = {
  experimentId: 'e', strategyBundle: bundle, strategyProfileId: 'p', trainRun,
  grid: { x: [0, 1, 2, 3, 4, 5] }, metrics: ['sharpe'], maxPoints: 8, topN: 6, minTradesTrain: 1, foldId: 0,
};

describe('ParamGridRunner', () => {
  it('runs every grid point on train, ledgers ALL results, ranks only completed', async () => {
    const seen: Record<string, unknown>[] = [];
    const fakeExec: StrategyExperimentRunExecutor = {
      async execute(req) {
        seen.push(req.params);
        const drop = Number(req.params['dump.minDropPct']);
        if (drop === 9) return { status: 'rejected', runId: 'r9', platformRunId: 'p9' }; // one point rejected by engine
        return {
          status: 'completed', runId: `r${drop}`, platformRunId: `p${drop}`, totalTrades: 5,
          metrics: {
            netPnlUsd: 0, netPnlPct: 0, totalTrades: 5, winRate: 0, profitFactor: 1,
            maxDrawdownPct: 0, expectancyUsd: 0, sharpe: drop, topTradeContributionPct: 0,
          },
        };
      },
    };
    const out = await new ParamGridRunner({ strategyRunExecutor: fakeExec }).runGrid({
      experimentId: 'e', strategyBundle: bundle, strategyProfileId: 'p', trainRun,
      grid: { 'dump.minDropPct': [2, 5, 9] }, metrics: ['sharpe'], maxPoints: 8, topN: 3, minTradesTrain: 3, foldId: 0,
    });
    expect(seen.length).toBe(3); // all points submitted on train
    expect(out.allResults.length).toBe(3); // ALL points in the ledger (incl. rejected)
    expect(out.allResults.find((r) => r.paramsHash === out.allResults[2]!.paramsHash)?.status).toBeDefined();
    expect(out.allResults.filter((r) => r.status === 'rejected').length).toBe(1);
    expect(out.ranked.map((r) => r.metrics.sharpe)).toEqual([5, 2]); // only completed, sharpe desc; rejected excluded
    expect(out.submitted).toBe(3);
    expect(out.rejected).toBe(1);
  });

  it('parallel run (concurrency 4, shuffled completion) equals serial run output', async () => {
    // fake executor: point index i completes after (POINTS - i) * 5 ms, so
    // completion order is REVERSED vs submission order.
    const makeExec = (): StrategyExperimentRunExecutor => ({
      execute: async (req: StrategyExperimentRunRequest) => {
        const i = pointIndexOf(req.params);
        await new Promise((r) => setTimeout(r, (POINTS - i) * 5));
        return {
          status: 'completed' as const, runId: `run-${i}`, platformRunId: `p-${i}`,
          metrics: fakeMetrics(i), totalTrades: 10 + i,
        };
      },
    });

    const serial = await new ParamGridRunner({ strategyRunExecutor: makeExec(), concurrency: 1 }).runGrid(INPUT);
    const parallel = await new ParamGridRunner({ strategyRunExecutor: makeExec(), concurrency: 4 }).runGrid(INPUT);
    expect(parallel).toEqual(serial); // order, ranking, submitted, rejected — identical
  });

  it('respects the concurrency bound', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const exec: StrategyExperimentRunExecutor = {
      execute: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return {
          status: 'completed' as const, runId: 'r', platformRunId: 'p',
          metrics: fakeMetrics(0), totalTrades: 3,
        };
      },
    };
    await new ParamGridRunner({ strategyRunExecutor: exec, concurrency: 2 }).runGrid(INPUT_6_POINTS);
    expect(maxInFlight).toBe(2);
  });

  it('default concurrency is 1 (constructor without the field stays serial)', async () => {
    const started: number[] = [];
    const exec: StrategyExperimentRunExecutor = {
      execute: async (req: StrategyExperimentRunRequest) => {
        const i = pointIndexOf(req.params);
        started.push(i);
        await new Promise((r) => setTimeout(r, 0));
        return {
          status: 'completed' as const, runId: `run-${i}`, platformRunId: `p-${i}`,
          metrics: fakeMetrics(i), totalTrades: 10 + i,
        };
      },
    };
    await new ParamGridRunner({ strategyRunExecutor: exec }).runGrid(INPUT);
    expect(started).toEqual([0, 1, 2, 3]);
  });
});
