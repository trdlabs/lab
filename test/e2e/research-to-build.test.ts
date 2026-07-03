// test/e2e/research-to-build.test.ts
import { describe, it, expect } from 'vitest';
import { researchRunCycleHandler } from '../../src/orchestrator/handlers/research-run-cycle.handler.ts';
import { hypothesisBuildHandler } from '../../src/orchestrator/handlers/hypothesis-build.handler.ts';
import { backtestCompletedHandler } from '../../src/orchestrator/handlers/backtest-completed.handler.ts';
import { revisionBuildHandler } from '../../src/orchestrator/handlers/revision-build.handler.ts';
import { WorkflowRouter } from '../../src/orchestrator/workflow-router.ts';
import { startWorker } from '../../src/worker/worker.ts';
import { InMemoryQueueAdapter } from '../../src/adapters/queue/in-memory-queue.adapter.ts';
import { makeServices } from '../support/make-services.ts';
import type { ResearchTask } from '../../src/domain/types.ts';
import type { StrategyProfile } from '../../src/domain/strategy-profile.ts';
import type { HypothesisProposalDraft, ResearcherOutput } from '../../src/domain/hypothesis.ts';
import type { ResearcherInput, ResearcherPort } from '../../src/ports/researcher.port.ts';

function profile(): StrategyProfile {
  const now = '2026-01-01T00:00:00Z';
  return {
    id: 'p1', version: 1, sourceKind: 'manual_description', sourceFingerprint: 'sha256:p',
    direction: 'long', coreIdea: 'oi-based entry filter', requiredMarketFeatures: ['oi', 'funding'],
    confidence: 0.6, unknowns: [], profile: {} as never, sourceArtifactRef: {} as never,
    contractVersion: 'strategy-profile-v1', createdAt: now, updatedAt: now,
  };
}

function cycleTask(overrides: Partial<ResearchTask> = {}): ResearchTask {
  return {
    id: 'cycle-1', taskType: 'research.run_cycle', source: 'operator',
    correlationId: 'c1', status: 'running',
    payload: { strategyProfileId: 'p1', cycleDepth: 1 },
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function draft(thesis: string, feature: 'oi' | 'funding' = 'oi', n = 1): HypothesisProposalDraft {
  return {
    thesis, targetBehavior: 'filter entries',
    ruleAction: { appliesTo: 'long', rules: [{ when: `${feature} condition ${n}`, action: 'skip_entry', params: { bars: n } }] },
    requiredFeatures: [feature], validationPlan: 'backtest 90d',
    expectedEffect: { metric: 'win_rate', direction: 'increase' },
    invalidationCriteria: ['no improvement'], confidence: 0.5,
  };
}

function stubResearcher(drafts: HypothesisProposalDraft[]): ResearcherPort {
  return { adapter: 'fake', model: 'stub',
    async propose(_: ResearcherInput): Promise<ResearcherOutput> {
      return { hypotheses: drafts, researchSummary: 'test summary' };
    },
  };
}

describe('research → build pipeline (e2e)', () => {
  it('researcher returns 2 hypotheses → 2 hypothesis.build tasks enqueued and each is built with valid code', async () => {
    const queue = new InMemoryQueueAdapter();
    const services = makeServices({
      taskQueue: queue,
      researcher: stubResearcher([
        draft('Skip entry when OI surges', 'oi', 1),
        draft('Skip entry when funding is negative', 'funding', 2),
      ]),
    });
    await services.strategyProfiles.create(profile());

    const router = new WorkflowRouter();
    router.register('hypothesis.build', hypothesisBuildHandler);
    router.register('backtest.completed', backtestCompletedHandler);
    router.register('revision.build', revisionBuildHandler);
    startWorker({ queue, router, services });

    await researchRunCycleHandler(cycleTask(), services);

    const buildEnvelopes = queue.queued.filter((e) => e.taskType === 'hypothesis.build');
    expect(buildEnvelopes).toHaveLength(2);

    await queue.drain();

    // The full pipeline runs backtest.completed too, which flips status away from 'validated'
    // to a proxy_* status (Task 2 slice) — so identify the 2 built hypotheses by profile
    // membership, not by a status value the pipeline is expected to mutate.
    const hypotheses = await services.hypotheses.listByStrategyProfile('p1');
    expect(hypotheses).toHaveLength(2);

    for (const h of hypotheses) {
      const builds = await services.builds.listByHypothesis(h.id);
      expect(builds).toHaveLength(1);
      expect(builds[0]!.status).toBe('submitted');
      expect(builds[0]!.bundleArtifactRef).not.toBeNull();

      const bundleRaw = await services.artifacts.get(builds[0]!.bundleArtifactRef!);
      const bundle = JSON.parse(bundleRaw.toString('utf8')) as { files: Record<string, string> };
      const entrySource = Object.values(bundle.files)[0] ?? '';
      expect(entrySource).not.toContain('process.env');
      expect(entrySource).not.toContain('eval');
      expect(entrySource).toContain('overlay');
    }
  });

  it('sdkDoc is passed to builder for each hypothesis (not empty)', async () => {
    const queue = new InMemoryQueueAdapter();
    const capturedDocs: string[] = [];

    const services = makeServices({
      taskQueue: queue,
      researcher: stubResearcher([
        draft('Hypothesis A', 'oi', 1),
        draft('Hypothesis B', 'funding', 2),
      ]),
    });
    await services.strategyProfiles.create(profile());

    const { FakeBuilder } = await import('../../src/adapters/builder/fake-builder.ts');
    const fakeBase = new FakeBuilder();
    services.builder = {
      adapter: 'fake', model: 'spy',
      build: async (input) => {
        capturedDocs.push(input.sdkDoc);
        return fakeBase.build(input);
      },
    };

    const router = new WorkflowRouter();
    router.register('hypothesis.build', hypothesisBuildHandler);
    router.register('backtest.completed', backtestCompletedHandler);
    router.register('revision.build', revisionBuildHandler);
    startWorker({ queue, router, services });

    await researchRunCycleHandler(cycleTask(), services);
    await queue.drain();

    expect(capturedDocs).toHaveLength(2);
    for (const doc of capturedDocs) {
      expect(doc.length).toBeGreaterThan(100);
    }
  });

  it('hypothesis.build tasks are processed in order (sequential, not parallel)', async () => {
    const queue = new InMemoryQueueAdapter();
    const order: string[] = [];

    const services = makeServices({
      taskQueue: queue,
      researcher: stubResearcher([
        draft('First hypothesis', 'oi', 1),
        draft('Second hypothesis', 'oi', 2),
        draft('Third hypothesis', 'funding', 3),
      ]),
    });
    await services.strategyProfiles.create(profile());

    const { FakeBuilder } = await import('../../src/adapters/builder/fake-builder.ts');
    const fakeBase = new FakeBuilder();
    services.builder = {
      adapter: 'fake', model: 'order-spy',
      build: async (input) => {
        order.push(input.hypothesis.thesis);
        return fakeBase.build(input);
      },
    };

    const router = new WorkflowRouter();
    router.register('hypothesis.build', hypothesisBuildHandler);
    router.register('backtest.completed', backtestCompletedHandler);
    router.register('revision.build', revisionBuildHandler);
    startWorker({ queue, router, services });

    await researchRunCycleHandler(cycleTask(), services);
    await queue.drain();

    expect(order).toHaveLength(3);
    expect(order[0]).toContain('First');
    expect(order[1]).toContain('Second');
    expect(order[2]).toContain('Third');
  });
});
