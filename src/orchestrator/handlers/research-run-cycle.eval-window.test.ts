import { describe, it, expect } from 'vitest';
import { researchRunCycleHandler } from './research-run-cycle.handler.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import { MockResearchPlatformAdapter } from '../../adapters/platform/mock-research-platform.adapter.ts';
import { stubResearcher, draft } from './research-run-cycle.test-fixtures.ts';
import type { ResearchTask } from '../../domain/types.ts';
import type { DatasetDescriptor } from '../../ports/research-run-lifecycle.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';

/** researchPlatform stub whose listDatasets is controllable; everything else delegates to the mock. */
function platformWith(listDatasets: () => Promise<{ datasets: readonly DatasetDescriptor[] }>) {
  const base = new MockResearchPlatformAdapter();
  return Object.assign(base, { listDatasets });
}

const boundDataset: DatasetDescriptor = {
  datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h',
  dateRange: { from: '2026-01-01', to: '2026-03-01' }, coveredKinds: [],
};

function task(over: Partial<ResearchTask> = {}): ResearchTask {
  return {
    id: 't1', taskType: 'research.run_cycle', source: 'operator', correlationId: 'c1',
    status: 'queued',
    payload: { strategyProfileId: 'p1', cycleDepth: 0 },
    createdAt: '2026-07-12T00:00:00Z', updatedAt: '2026-07-12T00:00:00Z', ...over,
  };
}

function profile(): StrategyProfile {
  const now = '2026-07-12T00:00:00Z';
  return {
    id: 'p1', version: 1, sourceKind: 'manual_description', sourceFingerprint: 'sha256:p',
    direction: 'long', coreIdea: 'idea', requiredMarketFeatures: ['oi'],
    confidence: 0.5, unknowns: [], profile: {} as never, sourceArtifactRef: {} as never,
    contractVersion: 'strategy-profile-v1', createdAt: now, updatedAt: now,
  };
}

async function seedProfile(services: ReturnType<typeof makeServices>) {
  await services.strategyProfiles.create(profile());
}

describe('research-run-cycle eval-window binding', () => {
  it('binds the window to the dataset dateRange and stamps every hypothesis.build', async () => {
    const services = makeServices({
      researcher: stubResearcher({ hypotheses: [draft('thesis A')], researchSummary: 's' }),
      researchPlatform: platformWith(async () => ({ datasets: [boundDataset] })),
    });
    await seedProfile(services);
    await researchRunCycleHandler(task(), services);

    const events = (await services.events.listByTask('t1')).map((e) => e.type);
    expect(events).toContain('eval_window.resolved');

    const builds = (await services.researchTasks.listByCorrelationAndTypes('c1', ['hypothesis.build']));
    expect(builds.length).toBeGreaterThan(0);
    for (const b of builds) {
      expect(b.payload.platformRun).toMatchObject({ period: { from: '2026-01-01', to: '2026-03-01' } });
    }
  });

  it('falls back to defaultPlatformRun + eval_window.fallback when listDatasets throws', async () => {
    const services = makeServices({
      researcher: stubResearcher({ hypotheses: [draft('thesis A')], researchSummary: 's' }),
      researchPlatform: platformWith(async () => { throw new Error('transport down'); }),
    });
    await seedProfile(services);
    await researchRunCycleHandler(task(), services);

    const fallbackEvent = (await services.events.listByTask('t1')).find((e) => e.type === 'eval_window.fallback');
    expect(fallbackEvent?.payload).toMatchObject({ reason: 'dataset_discovery_failed' });

    const builds = await services.researchTasks.listByCorrelationAndTypes('c1', ['hypothesis.build']);
    for (const b of builds) {
      expect(b.payload.platformRun).toEqual(services.defaultPlatformRun);
    }
  });

  it('reuses payload.evalPlatformRun WITHOUT calling listDatasets again', async () => {
    let calls = 0;
    const inherited = { datasetId: 'ds', symbols: ['ETHUSDT'], timeframe: '4h', period: { from: '2025-01-01', to: '2025-06-01' }, seed: 3 };
    const services = makeServices({
      researcher: stubResearcher({ hypotheses: [draft('thesis A')], researchSummary: 's' }),
      researchPlatform: platformWith(async () => { calls += 1; return { datasets: [boundDataset] }; }),
    });
    await seedProfile(services);
    await researchRunCycleHandler(task({ payload: { strategyProfileId: 'p1', cycleDepth: 1, evalPlatformRun: inherited } }), services);

    expect(calls).toBe(0);
    const builds = await services.researchTasks.listByCorrelationAndTypes('c1', ['hypothesis.build']);
    for (const b of builds) expect(b.payload.platformRun).toEqual(inherited);
  });
});
