import { describe, it, expect } from 'vitest';
import { InMemoryBacktestReadAdapter } from './in-memory-backtest-read.adapter.ts';
import type { BacktestRun } from '../../domain/backtest-run.ts';

function run(id: string, over: Partial<BacktestRun> = {}): BacktestRun {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    admission: null,
    id, hypothesisBuildId: 'b1', hypothesisId: 'h1', strategyProfileId: 'p1',
    platformRunId: 'mock-run', correlationId: 'c1', params: {}, paramsHash: 'sha:p', bundleHash: 'sha:b',
    status: 'completed', baselineModuleId: 'm0', variantModuleId: 'm1',
    backend: 'sp4_mock', resumeToken: null, platformRun: null,
    metrics: null, baselineMetrics: null, deltaNetPnlUsd: null, deltaMaxDrawdownPct: null, isFragile: null,
    artifactRefs: [], platformContractVersion: 'mock-0', sdkContractVersion: 'sdk-0',
    submittedAt: now, finishedAt: null, createdAt: now, updatedAt: now, ...over,
  };
}

describe('InMemoryBacktestReadAdapter', () => {
  const seed = [
    run('r1', { createdAt: '2026-01-01T00:00:01.000Z', hypothesisId: 'h1', status: 'completed' }),
    run('r2', { createdAt: '2026-01-01T00:00:02.000Z', hypothesisId: 'h1', status: 'evaluated' }),
    run('r3', { createdAt: '2026-01-01T00:00:03.000Z', hypothesisId: 'h2', status: 'completed' }),
  ];

  it('lists newest-first', async () => {
    const a = new InMemoryBacktestReadAdapter(seed);
    const rows = await a.list({ limit: 10 });
    expect(rows.map((r) => r.id)).toEqual(['r3', 'r2', 'r1']);
  });

  it('filters by hypothesisId and status', async () => {
    const a = new InMemoryBacktestReadAdapter(seed);
    expect((await a.list({ hypothesisId: 'h1', limit: 10 })).map((r) => r.id)).toEqual(['r2', 'r1']);
    expect((await a.list({ status: 'completed', limit: 10 })).map((r) => r.id)).toEqual(['r3', 'r1']);
  });

  it('paginates by keyset (after)', async () => {
    const a = new InMemoryBacktestReadAdapter(seed);
    const first = await a.list({ limit: 2 });
    expect(first.map((r) => r.id)).toEqual(['r3', 'r2']);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const last = first[first.length - 1]!;
    const next = await a.list({ limit: 2, after: { t: last.createdAt, id: last.id } });
    expect(next.map((r) => r.id)).toEqual(['r1']);
  });

  it('getById returns the row or null', async () => {
    const a = new InMemoryBacktestReadAdapter(seed);
    expect((await a.getById('r2'))?.id).toBe('r2');
    expect(await a.getById('nope')).toBeNull();
  });
});
