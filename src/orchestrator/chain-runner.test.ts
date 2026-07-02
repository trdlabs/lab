import { describe, it, expect } from 'vitest';
import { advanceChatPlan, type ChainRunnerDeps } from './chain-runner.ts';
import { InMemoryResearchTaskRepository } from '../adapters/repository/in-memory-research-task.repository.ts';
import { InMemoryStrategyProfileRepository } from '../adapters/repository/in-memory-strategy-profile.repository.ts';
import { InMemoryAgentEventRepository } from '../adapters/repository/in-memory-agent-event.repository.ts';
import { InMemoryChatSessionRepository } from '../adapters/repository/in-memory-chat-session.repository.ts';
import { InMemoryChatPlanRepository } from '../adapters/repository/in-memory-chat-plan.repository.ts';
import { InMemoryQueueAdapter } from '../adapters/queue/in-memory-queue.adapter.ts';
import { sourceFingerprint } from '../domain/fingerprint.ts';
import type { ResearchTask } from '../domain/types.ts';
import type { StrategyProfile } from '../domain/strategy-profile.ts';
import type { ChatPlan } from '../ports/chat-plan.repository.ts';

const FP = sourceFingerprint('manual_description', 'long oi strat');

const onboardTask = (id = 't-onb'): ResearchTask => ({
  id, taskType: 'strategy.onboard', source: 'web', correlationId: 'corr1', status: 'completed',
  payload: {}, createdAt: '2026-06-13T00:00:00Z', updatedAt: '2026-06-13T00:00:00Z',
});
const profile = (id = 'p1'): StrategyProfile => ({
  id, version: 1, sourceKind: 'manual_description', sourceFingerprint: FP,
  direction: 'long', coreIdea: 'idea', requiredMarketFeatures: [], confidence: 0.5, unknowns: [],
  profile: {} as never, sourceArtifactRef: {} as never, contractVersion: 'strategy-profile-v1',
  createdAt: '2026-06-13T00:00:00Z', updatedAt: '2026-06-13T00:00:00Z',
});
const plan = (over: Partial<ChatPlan> = {}): ChatPlan => ({
  id: 'plan1', sessionId: 's1', afterTaskId: 't-onb', nextTaskType: 'research.run_cycle',
  resolveProfileByFingerprint: FP, correlationId: 'corr1', status: 'pending',
  createdAt: '2026-06-13T00:00:00Z', updatedAt: '2026-06-13T00:00:00Z', ...over,
});

function deps(over: Partial<ChainRunnerDeps> = {}) {
  const researchTasks = new InMemoryResearchTaskRepository();
  const strategyProfiles = new InMemoryStrategyProfileRepository();
  const events = new InMemoryAgentEventRepository();
  const sessions = new InMemoryChatSessionRepository();
  const plans = new InMemoryChatPlanRepository();
  const queue = new InMemoryQueueAdapter();
  const base: ChainRunnerDeps = { researchTasks, strategyProfiles, events, sessions, plans, queue, ...over };
  return { base, researchTasks, strategyProfiles, events, sessions, plans, queue };
}

function researchEnvelopes(queue: InMemoryQueueAdapter) {
  return queue.queued.filter((e) => e.taskType === 'research.run_cycle');
}

describe('advanceChatPlan', () => {
  it('advances onboard -> research.run_cycle with the resolved profile and a deterministic dedupeKey', async () => {
    const { base, strategyProfiles, plans, sessions, queue, researchTasks } = deps();
    await strategyProfiles.create(profile());
    await sessions.upsert({ sessionId: 's1', pendingPlanId: 'plan1', updatedAt: '2026-06-13T00:00:00Z' });
    await plans.create(plan());

    await advanceChatPlan(onboardTask(), base);

    expect(researchEnvelopes(queue)).toHaveLength(1);
    const created = await researchTasks.findByDedupeKey('chat_plan:plan1:research.run_cycle');
    expect(created?.taskType).toBe('research.run_cycle');
    expect((created?.payload as { strategyProfileId: string }).strategyProfileId).toBe('p1');
    expect((await plans.findById('plan1'))?.status).toBe('advanced');
    const s = await sessions.get('s1');
    expect(s?.lastStrategyProfileId).toBe('p1');
    expect(s?.lastResearchTaskId).toBe(created?.id);
    expect(s?.pendingPlanId).toBeUndefined();
  });

  it('is idempotent across a worker retry: double advance enqueues exactly one research task', async () => {
    const { base, strategyProfiles, plans, queue } = deps();
    await strategyProfiles.create(profile());
    await plans.create(plan());

    await advanceChatPlan(onboardTask(), base);
    await advanceChatPlan(onboardTask(), base); // retry — plan already advanced

    expect(researchEnvelopes(queue)).toHaveLength(1);
  });

  it('dedupeKey backstops the crash window where markAdvanced never committed', async () => {
    const { base, strategyProfiles, plans, queue } = deps();
    await strategyProfiles.create(profile());
    await plans.create(plan());
    const stubbedPlans = Object.assign(Object.create(Object.getPrototypeOf(plans)), plans, {
      markAdvanced: async () => { /* simulate lost write */ },
    });
    const d = { ...base, plans: stubbedPlans } as ChainRunnerDeps;

    await advanceChatPlan(onboardTask(), d);
    await advanceChatPlan(onboardTask(), d); // plan still pending -> resolves again, dedupeKey saves us

    expect(researchEnvelopes(queue)).toHaveLength(1);
  });

  it('marks the plan failed and creates no research task when the profile is not resolvable', async () => {
    const { base, plans, queue } = deps();
    await plans.create(plan()); // no profile created -> findByFingerprint returns null

    await advanceChatPlan(onboardTask(), base);

    expect(researchEnvelopes(queue)).toHaveLength(0);
    expect((await plans.findById('plan1'))?.status).toBe('failed');
  });

  it('advances a strategy.baseline plan with a type-scoped dedupeKey and {strategyProfileId} payload', async () => {
    const { base, strategyProfiles, plans, queue, researchTasks } = deps();
    await strategyProfiles.create(profile());
    await plans.create(plan({ nextTaskType: 'strategy.baseline' }));

    await advanceChatPlan(onboardTask(), base);

    const baselineEnvelopes = queue.queued.filter((e) => e.taskType === 'strategy.baseline');
    expect(baselineEnvelopes).toHaveLength(1);
    const created = await researchTasks.findByDedupeKey('chat_plan:plan1:strategy.baseline');
    expect(created).toMatchObject({
      taskType: 'strategy.baseline',
      payload: { strategyProfileId: 'p1' },
      dedupeKey: 'chat_plan:plan1:strategy.baseline',
    });
    expect((await plans.findById('plan1'))?.status).toBe('advanced');
  });

  it('is a no-op for a completed task that has no pending plan', async () => {
    const { base, queue } = deps();
    await advanceChatPlan(onboardTask('unrelated'), base);
    expect(queue.queued).toHaveLength(0);
  });

  it('never throws when the pending-plan lookup itself rejects (worker stays safe)', async () => {
    // Simulate a real DB error on the very first await. advanceChatPlan must swallow it
    // so the worker never flips the already-completed task to failed. (InMemory never
    // rejects, so this is the only path that exercises the outermost guard.)
    const { base, queue } = deps();
    const throwingPlans = Object.assign(Object.create(Object.getPrototypeOf(base.plans)), base.plans, {
      findPendingByAfterTaskId: async () => { throw new Error('db down'); },
    });
    const d = { ...base, plans: throwingPlans } as ChainRunnerDeps;

    await expect(advanceChatPlan(onboardTask(), d)).resolves.toBeUndefined();
    expect(queue.queued).toHaveLength(0);
  });
});
