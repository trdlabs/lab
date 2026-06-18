import { describe, it, expect } from 'vitest';
import { hypothesisBuildHandler } from './hypothesis-build.handler.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import { MockResearchPlatformAdapter } from '../../adapters/platform/mock-research-platform.adapter.ts';
import type { AppServices } from '../app-services.ts';
import type { ResearchTask } from '../../domain/types.ts';
import type { HypothesisProposal } from '../../domain/hypothesis.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { ResearchPlatformPort } from '../../ports/research-platform.port.ts';

const PLATFORM_RUN = { datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h', period: { from: '2023-01-01', to: '2023-06-30' }, seed: 7 };

function profile(): StrategyProfile {
  const now = '2026-01-01T00:00:00Z';
  return { id: 'p1', version: 1, sourceKind: 'manual_description', sourceFingerprint: 'sha256:s', direction: 'long',
    coreIdea: 'oi filter', requiredMarketFeatures: ['oi', 'funding'], confidence: 0.6, unknowns: [], profile: {} as never,
    sourceArtifactRef: {} as never, contractVersion: 'strategy-profile-v1', createdAt: now, updatedAt: now };
}
function hypothesis(): HypothesisProposal {
  const now = '2026-01-01T00:00:00Z';
  return { id: 'h1', strategyProfileId: 'p1', thesis: 't', targetBehavior: 'filter',
    ruleAction: { appliesTo: 'long', rules: [{ when: 'x', action: 'skip_entry', params: { bars: 2 } }] },
    requiredFeatures: ['oi', 'funding'], validationPlan: 'bt', expectedEffect: { metric: 'win_rate', direction: 'increase' },
    invalidationCriteria: ['none'], confidence: 0.5, status: 'validated', fingerprint: 'sha256:abc', proposal: {} as never,
    issues: [], contractVersion: 'hypothesis-proposal-v1', createdAt: now, updatedAt: now };
}
function task(payload: Record<string, unknown>): ResearchTask {
  const now = '2026-01-01T00:00:00Z';
  return { id: 't1', taskType: 'hypothesis.build', source: 'operator', correlationId: 'c1', status: 'running', payload, createdAt: now, updatedAt: now };
}
async function seeded(over: Partial<AppServices> = {}): Promise<AppServices> {
  const s = makeServices(over);
  await s.strategyProfiles.create(profile());
  await s.hypotheses.create(hypothesis());
  return s;
}

describe('hypothesisBuildHandler — research_platform backend', () => {
  it('KEY CHECK: payload override research_platform completes → backtest_run evaluated + evaluation', async () => {
    const s = await seeded({ researchPlatform: new MockResearchPlatformAdapter() });
    await hypothesisBuildHandler(task({ hypothesisId: 'h1', backtestBackend: 'research_platform', platformRun: PLATFORM_RUN }), s);

    const runs = await s.backtests.listByHypothesis('h1');
    expect(runs[0]?.status).toBe('evaluated');
    expect(runs[0]?.backend).toBe('research_platform');
    expect(runs[0]?.metrics?.netPnlUsd).toBe(1500);
    expect((await s.evaluations.listByBacktestRun(runs[0]!.id))).toHaveLength(1);
    expect((await s.builds.listByHypothesis('h1'))[0]?.status).toBe('submitted');
  });

  it('env-default research_platform also takes the platform path', async () => {
    const s = await seeded({ researchPlatform: new MockResearchPlatformAdapter(), backtestBackend: 'research_platform' });
    await hypothesisBuildHandler(task({ hypothesisId: 'h1', platformRun: PLATFORM_RUN }), s);
    expect((await s.backtests.listByHypothesis('h1'))[0]?.backend).toBe('research_platform');
  });

  it('research_platform without platformRun → build_failed (missing_platform_run_config), no submit, no builder side-effects after', async () => {
    let submitted = false;
    const stub = { ...new MockResearchPlatformAdapter(), submitOverlayRun: async () => { submitted = true; throw new Error('no'); } } as unknown as ResearchPlatformPort;
    const s = await seeded({ researchPlatform: stub, backtestBackend: 'research_platform' });
    await hypothesisBuildHandler(task({ hypothesisId: 'h1' }), s); // no platformRun

    expect(submitted).toBe(false);
    expect(await s.backtests.listByHypothesis('h1')).toHaveLength(0);
    const builds = await s.builds.listByHypothesis('h1');
    expect(builds[0]?.status).toBe('build_failed');
    expect(builds[0]?.issues.map((i) => i.code)).toContain('missing_platform_run_config');
  });

  it('existing submitted research_platform run is reused (no second submit, no evaluation)', async () => {
    let submitCount = 0;
    const base = new MockResearchPlatformAdapter();
    const stub = {
      discover: base.discover.bind(base),
      listDatasets: base.listDatasets.bind(base),
      validateModule: base.validateModule.bind(base),
      submitOverlayRun: async (b: unknown, o: { run: { seed: number } }) => { submitCount += 1; return { jobId: 'j', runId: 'r-pending', status: 'accepted', effectiveSeed: o.run.seed, requestFingerprint: 'f', idempotentReplay: false }; },
      getRunStatus: async () => ({ jobId: 'j', runId: 'r-pending', status: 'running', timeline: { acceptedAtMs: 0 } }),
      getRunResult: async () => { throw new Error('should not be called'); },
    } as unknown as ResearchPlatformPort;
    const s = await seeded({ researchPlatform: stub, backtestBackend: 'research_platform', platformPoll: { maxPolls: 2, pollDelayMs: 0 } });
    const t = task({ hypothesisId: 'h1', platformRun: PLATFORM_RUN });
    await hypothesisBuildHandler(t, s); // run 1: pending, persisted submitted
    await hypothesisBuildHandler(t, s); // run 2: identity hit → reused

    expect(submitCount).toBe(1);
    const runs = await s.backtests.listByHypothesis('h1');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('submitted');
    const evTypes = (await s.events.listByTask('t1')).map((e) => e.type);
    expect(evTypes).toContain('backtest.reused');
    expect(evTypes).not.toContain('evaluation.completed');
  });

  it('research_platform: listDatasets returns [] → datasets_unavailable event + build_failed, no submit', async () => {
    let submitted = false;
    const stub = {
      ...new MockResearchPlatformAdapter(),
      listDatasets: async () => ({ datasets: [] }),
      submitOverlayRun: async () => { submitted = true; throw new Error('should not be called'); },
    } as unknown as ResearchPlatformPort;
    const s = await seeded({ researchPlatform: stub, backtestBackend: 'research_platform' });
    await hypothesisBuildHandler(task({ hypothesisId: 'h1', platformRun: PLATFORM_RUN }), s);

    expect(submitted).toBe(false);
    expect(await s.backtests.listByHypothesis('h1')).toHaveLength(0);

    const builds = await s.builds.listByHypothesis('h1');
    expect(builds[0]?.status).toBe('build_failed');
    expect(builds[0]?.issues.map((i) => i.code)).toContain('datasets_unavailable');

    const evTypes = (await s.events.listByTask('t1')).map((e) => e.type);
    expect(evTypes).toContain('research_platform.datasets_unavailable');
    expect(evTypes).toContain('build_failed');
  });
});
