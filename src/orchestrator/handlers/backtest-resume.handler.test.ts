import { describe, it, expect } from 'vitest';
import { backtestResumeHandler } from './backtest-resume.handler.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import type { BacktestRun } from '../../domain/backtest-run.ts';
import type { ResearchTask } from '../../domain/types.ts';

const NOW = '2026-01-01T00:00:00Z';
const PLATFORM_RUN = { datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h', period: { from: '2023-01-01', to: '2023-06-30' }, seed: 7 };

function run(id: string, over: Partial<BacktestRun> = {}): BacktestRun {
  return {
    admission: null,
    id, hypothesisBuildId: 'b1', hypothesisId: 'h1', strategyProfileId: 'p1',
    platformRunId: 'platform-run-1', correlationId: 'c1', params: {}, paramsHash: 'sha256:p', bundleHash: 'sha256:bh',
    status: 'submitted', baselineModuleId: 'strategy:p1', variantModuleId: 'overlay-h1',
    backend: 'research_platform', resumeToken: 'tok', taskId: 't1', platformRun: PLATFORM_RUN,
    metrics: null, baselineMetrics: null, deltaNetPnlUsd: null, deltaMaxDrawdownPct: null, isFragile: null,
    artifactRefs: [], platformContractVersion: 'pending', sdkContractVersion: 'builder-sdk-v0',
    submittedAt: NOW, finishedAt: null, createdAt: NOW, updatedAt: NOW, ...over,
  };
}

function task(): ResearchTask {
  return { id: 't1', taskType: 'hypothesis.build', source: 'operator', correlationId: 'c1', status: 'running', payload: {}, createdAt: NOW, updatedAt: NOW };
}

describe('backtestResumeHandler', () => {
  it('skips when run is not found', async () => {
    const s = makeServices();
    const handler = backtestResumeHandler();
    await handler(
      { id: 'task-1', taskType: 'backtest.resume', source: 'platform', correlationId: 'c1', status: 'running', payload: { platformRunId: 'missing' }, createdAt: NOW, updatedAt: NOW },
      s,
    );
    expect((await s.events.listByTask('task-1')).map((e) => e.type)).toContain('backtest.resume.skipped');
  });

  it('completes a submitted platform run via resumePlatformRun', async () => {
    const s = makeServices();
    await s.researchTasks.create(task());
    await s.backtests.createSubmitted(run('br1'));
    const handler = backtestResumeHandler();
    await handler(
      { id: 'task-2', taskType: 'backtest.resume', source: 'platform', correlationId: 'c1', status: 'running', payload: { platformRunId: 'platform-run-1', backtestRunId: 'br1' }, createdAt: NOW, updatedAt: NOW },
      s,
    );
    expect((await s.backtests.findById('br1'))?.status).toBe('evaluated');
    expect((await s.events.listByTask('t1')).map((e) => e.type)).toContain('backtest.resume.completed');
  });
});
