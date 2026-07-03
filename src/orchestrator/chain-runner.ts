import { randomUUID } from 'node:crypto';
import type { ResearchTask } from '../domain/types.ts';
import type { ResearchTaskRepository } from '../ports/research-task.repository.ts';
import type { StrategyProfileRepository } from '../ports/strategy-profile.repository.ts';
import type { AgentEventRepository } from '../ports/agent-event.repository.ts';
import type { ChatSessionRepository } from '../ports/chat-session.repository.ts';
import type { ChatPlanRepository } from '../ports/chat-plan.repository.ts';
import type { TaskQueuePort } from '../ports/task-queue.port.ts';
import { createAndEnqueueTask } from './task-intake.ts';

export interface ChainRunnerDeps {
  researchTasks: ResearchTaskRepository;
  strategyProfiles: Pick<StrategyProfileRepository, 'findByFingerprint'>;
  events: AgentEventRepository;
  sessions: ChatSessionRepository;
  plans: ChatPlanRepository;
  queue: TaskQueuePort;
}

/**
 * Worker completion hook. Called ONLY after a task transitions to `completed`.
 * Advances a chat-plan continuation off strategy.onboard: ordinary onboarding chains
 * strategy.onboard -> strategy.baseline, an explicit research goal chains
 * strategy.onboard -> research.run_cycle. plan.nextTaskType picks the branch.
 *
 * Best-effort: this function NEVER throws. The worker calls it AFTER the task is
 * already marked `completed`, so any propagated error would make the worker's catch
 * flip a finished task to `failed` and re-enqueue completed work. Every await —
 * including the initial pending-plan lookup — is therefore inside a guard.
 */
export async function advanceChatPlan(completedTask: ResearchTask, deps: ChainRunnerDeps): Promise<void> {
  const now = (): string => new Date().toISOString();

  try {
    const plan = await deps.plans.findPendingByAfterTaskId(completedTask.id);
    if (!plan) return;

    const ev = (type: string, payload: Record<string, unknown>): Promise<void> =>
      deps.events.append({ id: randomUUID(), taskId: plan.afterTaskId, type, payload, createdAt: now() });

    try {
      const profile = await deps.strategyProfiles.findByFingerprint(plan.resolveProfileByFingerprint);
      if (!profile) {
        await deps.plans.markFailed(plan.id);
        await ev('chat.plan.advance_failed', { planId: plan.id, afterTaskId: plan.afterTaskId, reason: 'profile_not_found' });
        return;
      }

      // Deterministic dedupeKey: a worker retry returns the existing task instead of re-enqueuing.
      // Type-scoped so the two possible chain continuations (strategy.baseline, research.run_cycle)
      // never collide on the same key.
      const dedupeKey = `chat_plan:${plan.id}:${plan.nextTaskType}`;
      const intake = await createAndEnqueueTask(
        {
          taskType: plan.nextTaskType,
          source: completedTask.source,
          payload: { strategyProfileId: profile.id },
          correlationId: plan.correlationId,
          dedupeKey,
        },
        { repo: deps.researchTasks, queue: deps.queue },
      );

      await deps.plans.markAdvanced(plan.id);

      const session = await deps.sessions.get(plan.sessionId);
      if (session) {
        await deps.sessions.upsert({
          ...session,
          lastStrategyProfileId: profile.id,
          lastResearchTaskId: intake.taskId,
          pendingPlanId: undefined,
          updatedAt: now(),
        });
      }

      await ev('chat.plan.advanced', { planId: plan.id, afterTaskId: plan.afterTaskId, nextTaskId: intake.taskId, deduped: intake.deduped });
    } catch (err) {
      await deps.plans.markFailed(plan.id).catch(() => { /* swallow */ });
      await ev('chat.plan.advance_failed', { planId: plan.id, afterTaskId: plan.afterTaskId, reason: err instanceof Error ? err.message : String(err) }).catch(() => { /* swallow */ });
    }
  } catch {
    // Outermost guard: even the initial pending-plan lookup (or an events failure inside
    // the inner catch) must never propagate. advanceChatPlan is strictly best-effort, and
    // nothing was created on this path, so there is nothing to roll back.
  }
}
