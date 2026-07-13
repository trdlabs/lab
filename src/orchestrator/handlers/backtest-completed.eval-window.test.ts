import { describe, it, expect } from 'vitest';
import { backtestCompletedHandler } from './backtest-completed.handler.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import type { ResearchTask } from '../../domain/types.ts';

const evalWindow = { datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h', period: { from: '2026-01-01', to: '2026-03-01' }, seed: 7 };

function completedTask(payload: Record<string, unknown>): ResearchTask {
  return {
    id: 'bt1', taskType: 'backtest.completed', source: 'operator', correlationId: 'c1', status: 'queued',
    payload, createdAt: '2026-07-12T00:00:00Z', updatedAt: '2026-07-12T00:00:00Z',
  };
}

const failPayload = (over: Record<string, unknown> = {}) => ({
  backtestRunId: 'r1', hypothesisId: 'h1', strategyProfileId: 'p1',
  decision: 'FAIL', reasons: ['loss'], cycleDepth: 0, ...over,
});

describe('backtest-completed retry inherits evalPlatformRun', () => {
  it('threads evalPlatformRun into the retry research.run_cycle payload', async () => {
    const services = makeServices();
    await backtestCompletedHandler(completedTask(failPayload({ evalPlatformRun: evalWindow, symbol: 'BTCUSDT' })), services);
    const retry = (await services.researchTasks.listByCorrelationAndTypes('c1', ['research.run_cycle']))[0];
    expect(retry?.payload.evalPlatformRun).toEqual(evalWindow);
    expect(retry?.payload.symbol).toBe('BTCUSDT');
  });

  it('omits evalPlatformRun on an old payload without the field (back-compat)', async () => {
    const services = makeServices();
    await backtestCompletedHandler(completedTask(failPayload()), services);
    const retry = (await services.researchTasks.listByCorrelationAndTypes('c1', ['research.run_cycle']))[0];
    expect(retry).toBeDefined();
    expect(retry?.payload.evalPlatformRun).toBeUndefined();
  });
});
