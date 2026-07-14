// src/orchestrator/finalize-cycle.test.ts
//
// R5b Task 4: finalizeCycle is the single terminal-close hook revision-build calls at every
// domain-terminal outcome. Unit-level coverage here pins its own contract (dedupeKey shape,
// payload shape, fully fail-soft error handling); per-terminal wiring coverage lives in
// revision-flow.integration.test.ts (revisionBuildHandler actually calling it at all 11
// terminals + never on the deferred self-requeue).
import { describe, it, expect } from 'vitest';
import { finalizeCycle, type FinalizeCycleOutcome } from './finalize-cycle.ts';
import { CYCLE_SCORECARD_SCHEMA_VERSION } from '../domain/cycle-scorecard.ts';
import { CYCLE_CHAIN_TYPES } from './cycle-close.ts';
import { InMemoryQueueAdapter } from '../adapters/queue/in-memory-queue.adapter.ts';
import { InMemoryResearchTaskRepository } from '../adapters/repository/in-memory-research-task.repository.ts';
import { InMemoryAgentEventRepository } from '../adapters/repository/in-memory-agent-event.repository.ts';
import type { TaskQueuePort } from '../ports/task-queue.port.ts';
import type { AgentEventRepository } from '../ports/agent-event.repository.ts';

function outcome(over: Partial<FinalizeCycleOutcome> = {}): FinalizeCycleOutcome {
  return {
    correlationId: 'c1',
    strategyProfileId: 'p1',
    sourceTaskId: 'task-1',
    terminalOutcome: { kind: 'accepted', reason: 'no_improvement... n/a' },
    ...over,
  };
}

describe('finalizeCycle', () => {
  it('(a) enqueues a cycle.scorecard task with the schema-versioned per-correlation dedupeKey and the outcome as payload', async () => {
    const researchTasks = new InMemoryResearchTaskRepository();
    const taskQueue = new InMemoryQueueAdapter();
    const events = new InMemoryAgentEventRepository();
    const out = outcome();

    await finalizeCycle({ outcome: out, deps: { researchTasks, taskQueue, events } });

    const rows = await researchTasks.listByCorrelationAndTypes('c1', ['cycle.scorecard']);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dedupeKey).toBe(`cycle.scorecard:${CYCLE_SCORECARD_SCHEMA_VERSION}:c1`);
    expect(rows[0]!.taskType).toBe('cycle.scorecard');
    expect(rows[0]!.payload).toEqual(out);

    const queued = taskQueue.queued.filter((e) => e.taskType === 'cycle.scorecard');
    expect(queued).toHaveLength(1);
    expect(queued[0]!.dedupeKey).toBe(`cycle.scorecard:${CYCLE_SCORECARD_SCHEMA_VERSION}:c1`);
  });

  it('(b) enqueue THROWS -> emits cycle.scorecard_enqueue_failed and resolves (does not throw)', async () => {
    const researchTasks = new InMemoryResearchTaskRepository();
    const taskQueue: TaskQueuePort = {
      enqueue: async () => { throw new Error('queue down'); },
      process: () => {},
      close: async () => {},
    };
    const events = new InMemoryAgentEventRepository();
    const out = outcome({ sourceTaskId: 'task-b' });

    await expect(
      finalizeCycle({ outcome: out, deps: { researchTasks, taskQueue, events } }),
    ).resolves.toBeUndefined();

    const appended = await events.listByTask('task-b');
    expect(appended.map((e) => e.type)).toContain('cycle.scorecard_enqueue_failed');
    expect(appended.find((e) => e.type === 'cycle.scorecard_enqueue_failed')?.payload).toMatchObject({
      correlationId: 'c1', error: 'queue down',
    });
  });

  it('(c) enqueue THROWS *and* events.append THROWS -> finalizeCycle still RESOLVES (fully fail-soft)', async () => {
    const researchTasks = new InMemoryResearchTaskRepository();
    const taskQueue: TaskQueuePort = {
      enqueue: async () => { throw new Error('queue down'); },
      process: () => {},
      close: async () => {},
    };
    const events: AgentEventRepository = {
      append: async () => { throw new Error('events store down too'); },
      listByTask: async () => [],
    };
    const out = outcome({ sourceTaskId: 'task-c' });

    await expect(
      finalizeCycle({ outcome: out, deps: { researchTasks, taskQueue, events } }),
    ).resolves.toBeUndefined();
  });

  it('cycle.scorecard is NOT a chain type (not swept by isCycleChainTerminal)', () => {
    expect(CYCLE_CHAIN_TYPES).not.toContain('cycle.scorecard');
  });
});
