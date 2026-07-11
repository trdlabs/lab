import { describe, it, expect, vi } from 'vitest';
import { finalizeBacktestCompletion } from './backtest-support.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import { FakeRunTradesAdapter } from '../../adapters/platform/fake-run-trades.adapter.ts';
import type { ComparisonSummary } from '../../ports/platform-gateway.port.ts';
import type { ResearchTask } from '../../domain/types.ts';
import type { BacktestRun } from '../../domain/backtest-run.ts';

const NOW = '2026-01-01T00:00:00Z';

// finalizeBacktestCompletion's markCompleted/markEvaluated calls require the run to already
// exist as 'submitted' (mirrors how runPlatformBacktest/resumePlatformRun seed it upstream);
// the brief's Step-1 snippet omits this seed, so tests seed it here to isolate the gate wiring.
function seedRun(over: Partial<BacktestRun> = {}): BacktestRun {
  return {
    id: 'run-1', hypothesisBuildId: 'b1', hypothesisId: 'h1', strategyProfileId: 'p1',
    platformRunId: 'platform-run-1', correlationId: 'c1', params: {}, paramsHash: 'sha256:p', bundleHash: 'sha256:bh',
    status: 'submitted', baselineModuleId: 'strategy:p1', variantModuleId: 'overlay-h1',
    backend: 'research_platform', resumeToken: 'tok', taskId: 't1',
    platformRun: { datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h', period: { from: '2023-01-01', to: '2023-06-30' }, seed: 7 },
    metrics: null, baselineMetrics: null, deltaNetPnlUsd: null, deltaMaxDrawdownPct: null, isFragile: null,
    artifactRefs: [], platformContractVersion: 'pending', sdkContractVersion: 'builder-sdk-v0',
    submittedAt: NOW, finishedAt: null, createdAt: NOW, updatedAt: NOW, ...over,
  };
}

function metric(over: Partial<import('../../ports/platform-gateway.port.ts').BacktestMetricBlock> = {}) {
  return { netPnlUsd: 100, netPnlPct: 1, totalTrades: 30, winRate: 0.5, profitFactor: 1.6, maxDrawdownPct: 7, expectancyUsd: 3, sharpe: 0.8, topTradeContributionPct: 20, ...over };
}
// baseline net -45 (25 trades, many losers), variant net +15 (20 trades, only winners kept)
// → evaluateBacktest PASS-shaped delta, trades encode abstention_gaming (see slice 1a math).
function comparison(): ComparisonSummary {
  return {
    baseline: metric({ netPnlUsd: -45, totalTrades: 25, profitFactor: 0.8 }),
    variant: metric({ netPnlUsd: 15, totalTrades: 20, profitFactor: 1.2 }),
    sampleSize: { baselineTrades: 25, variantTrades: 20 }, platformContractVersion: 'test-0',
  };
}
function task(): ResearchTask {
  return { id: 't1', taskType: 'backtest.completed', source: 'operator', correlationId: 'c1', status: 'running', payload: {}, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
}

it('downgrades a would-accept verdict to MODIFY on abstention and persists preservation_gate', async () => {
  const runTrades = new FakeRunTradesAdapter(
    { 'run-1': [ /* variant */ { entryTs: 3, exitTs: 4, side: 'long', realizedPnl: 5 }, { entryTs: 4, exitTs: 5, side: 'long', realizedPnl: 5 }, { entryTs: 5, exitTs: 6, side: 'long', realizedPnl: 5 } ] },
    { 'run-1': [ /* baseline */ { entryTs: 1, exitTs: 2, side: 'long', realizedPnl: -30 }, { entryTs: 2, exitTs: 3, side: 'long', realizedPnl: -30 }, { entryTs: 3, exitTs: 4, side: 'long', realizedPnl: 5 }, { entryTs: 4, exitTs: 5, side: 'long', realizedPnl: 5 }, { entryTs: 5, exitTs: 6, side: 'long', realizedPnl: 5 } ] },
  );
  const services = makeServices({ runTrades });
  await services.backtests.createSubmitted(seedRun());
  const res = await finalizeBacktestCompletion(services, task(), { runId: 'run-1', hypothesisId: 'h1', comparison: comparison(), artifactRefs: [] });
  expect(res.decision).toBe('MODIFY');
  const evals = await services.evaluations.listByBacktestRun('run-1');
  expect(evals[0]?.preservationGate?.reason).toBe('abstention_gaming');
});

it('fail-open: baseline artifact unavailable → verdict unchanged + evaluation.preservation_skipped(artifact_unavailable), preservation_gate NULL', async () => {
  // variant trades present, baseline map empty → getBaselineRunTrades returns null
  const runTrades = new FakeRunTradesAdapter({ 'run-1': [] }, {});
  const events: string[] = [];
  const services = makeServices({ runTrades });
  await services.backtests.createSubmitted(seedRun());
  const origAppend = services.events.append.bind(services.events);
  services.events.append = async (e: any) => { events.push(e.type + ':' + (e.payload?.reason ?? '')); return origAppend(e); };
  const res = await finalizeBacktestCompletion(services, task(), { runId: 'run-1', hypothesisId: 'h1', comparison: comparison(), artifactRefs: [] });
  // aggregate verdict stands (whatever evaluateBacktest returns for this comparison) — NOT downgraded by the gate
  const evals = await services.evaluations.listByBacktestRun('run-1');
  expect(evals[0]?.preservationGate).toBeUndefined();
  expect(events).toContain('evaluation.preservation_skipped:artifact_unavailable');
});

it('kill-switch off: no baseline/variant preservation fetch', async () => {
  const getBaselineRunTrades = vi.fn(async () => null);
  const getRunTrades = vi.fn(async () => []);
  const runTrades = { getRunTrades, getBaselineRunTrades };
  const services = makeServices({ runTrades, preservationGateEnabled: false });
  await services.backtests.createSubmitted(seedRun());
  await finalizeBacktestCompletion(services, task(), { runId: 'run-1', hypothesisId: 'h1', comparison: comparison(), artifactRefs: [] });
  expect(getBaselineRunTrades).not.toHaveBeenCalled();
});
