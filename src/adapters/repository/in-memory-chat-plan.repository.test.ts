import { describe, it, expect } from 'vitest';
import { InMemoryChatPlanRepository } from './in-memory-chat-plan.repository.ts';
import type { ChatPlan } from '../../ports/chat-plan.repository.ts';

const plan = (over: Partial<ChatPlan> = {}): ChatPlan => ({
  id: 'plan1', sessionId: 's1', afterTaskId: 'task-onboard', nextTaskType: 'research.run_cycle',
  resolveProfileByFingerprint: 'sha256:fp', correlationId: 'corr1', status: 'pending',
  createdAt: '2026-06-13T00:00:00Z', updatedAt: '2026-06-13T00:00:00Z', ...over,
});

describe('InMemoryChatPlanRepository', () => {
  it('creates and finds by id', async () => {
    const repo = new InMemoryChatPlanRepository();
    await repo.create(plan());
    expect((await repo.findById('plan1'))?.afterTaskId).toBe('task-onboard');
  });

  it('finds a pending plan by afterTaskId', async () => {
    const repo = new InMemoryChatPlanRepository();
    await repo.create(plan());
    expect((await repo.findPendingByAfterTaskId('task-onboard'))?.id).toBe('plan1');
    expect(await repo.findPendingByAfterTaskId('other')).toBeNull();
  });

  it('markAdvanced flips status so the plan is no longer pending', async () => {
    const repo = new InMemoryChatPlanRepository();
    await repo.create(plan());
    await repo.markAdvanced('plan1');
    expect((await repo.findById('plan1'))?.status).toBe('advanced');
    expect(await repo.findPendingByAfterTaskId('task-onboard')).toBeNull();
  });

  it('markFailed flips status to failed', async () => {
    const repo = new InMemoryChatPlanRepository();
    await repo.create(plan());
    await repo.markFailed('plan1');
    expect((await repo.findById('plan1'))?.status).toBe('failed');
    expect(await repo.findPendingByAfterTaskId('task-onboard')).toBeNull();
  });
});
