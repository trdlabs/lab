import { describe, it, expect } from 'vitest';
import {
  enqueueCycleClose,
  isCycleChainTerminal,
  CYCLE_CHAIN_TYPES,
  CYCLE_CLOSE_MAX_WAIT_ATTEMPTS,
  CYCLE_CLOSE_WAIT_DELAY_MS,
} from './cycle-close.ts';
import { makeServices } from '../../test/support/make-services.ts';
import { InMemoryQueueAdapter } from '../adapters/queue/in-memory-queue.adapter.ts';
import type { AppServices } from './app-services.ts';
import type { AgentTaskType, ResearchTask, TaskStatus } from '../domain/types.ts';

function chainTask(
  services: AppServices,
  id: string,
  taskType: AgentTaskType,
  status: TaskStatus,
  correlationId = 'corr-1',
): Promise<void> {
  const t: ResearchTask = {
    id, taskType, source: 'operator', correlationId, status, payload: {},
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
  return services.researchTasks.create(t);
}

/** Minimal ResearchTask for enqueueCycleClose call sites — only id/source/correlationId matter. */
function triggerTask(overrides: Partial<ResearchTask> = {}): ResearchTask {
  return {
    id: 'trigger-task', taskType: 'backtest.completed', source: 'operator', correlationId: 'corr-1',
    status: 'running', payload: {},
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('cycle-close: constants', () => {
  it('pins the ratified poll budget + chain types', () => {
    expect(CYCLE_CLOSE_MAX_WAIT_ATTEMPTS).toBe(40);
    expect(CYCLE_CLOSE_WAIT_DELAY_MS).toBe(15_000);
    expect([...CYCLE_CHAIN_TYPES]).toEqual(['hypothesis.build', 'backtest.completed', 'research.run_cycle']);
  });
});

describe('isCycleChainTerminal', () => {
  it('returns true for an empty chain (no chain-type rows -> [].every is true -> builds)', async () => {
    const services = makeServices();
    expect(await isCycleChainTerminal('corr-1', services)).toBe(true);
  });

  it('returns true when every chain-type row is settled (completed/failed/rejected)', async () => {
    const services = makeServices();
    await chainTask(services, 'a', 'hypothesis.build', 'completed');
    await chainTask(services, 'b', 'backtest.completed', 'failed');
    await chainTask(services, 'c', 'research.run_cycle', 'rejected');
    expect(await isCycleChainTerminal('corr-1', services)).toBe(true);
  });

  it('returns false when any chain-type row is still running', async () => {
    const services = makeServices();
    await chainTask(services, 'a', 'hypothesis.build', 'completed');
    await chainTask(services, 'b', 'hypothesis.build', 'running');
    expect(await isCycleChainTerminal('corr-1', services)).toBe(false);
  });

  it("treats 'queued' as non-terminal (TODO(P1-2): no stale-queued tolerance)", async () => {
    const services = makeServices();
    await chainTask(services, 'a', 'hypothesis.build', 'queued');
    expect(await isCycleChainTerminal('corr-1', services)).toBe(false);
  });

  it('ignores rows in other correlations and non-chain task types', async () => {
    const services = makeServices();
    // running, but a different correlation -> ignored
    await chainTask(services, 'other-corr', 'hypothesis.build', 'running', 'corr-2');
    // running, but revision.build is NOT a chain type -> ignored (no exclude-self needed)
    await chainTask(services, 'self', 'revision.build', 'running');
    expect(await isCycleChainTerminal('corr-1', services)).toBe(true);
  });
});

describe('enqueueCycleClose', () => {
  it('enqueues a revision.build with the BASE dedupeKey (unconditional, no terminality gate)', async () => {
    const services = makeServices();
    await enqueueCycleClose({ task: triggerTask(), strategyProfileId: 'p1', services });

    const rows = await services.researchTasks.listByCorrelationAndTypes('corr-1', ['revision.build']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      taskType: 'revision.build',
      dedupeKey: 'revision.build:corr-1',
      payload: { strategyProfileId: 'p1', correlationId: 'corr-1' },
    });
    const enqueued = (services.taskQueue as InMemoryQueueAdapter).queued.filter((e) => e.taskType === 'revision.build');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.dedupeKey).toBe('revision.build:corr-1');
  });

  it('absorbs repeated triggers into ONE row via the base dedupeKey (idempotent)', async () => {
    const services = makeServices();
    // Sequential re-triggers (the common P0-2 case: several chain members terminalize one after
    // another) collapse onto the single base dedupeKey. (True concurrent absorption relies on the
    // production DB unique constraint — the in-memory repo's read-then-write dedupe is not atomic.)
    await enqueueCycleClose({ task: triggerTask(), strategyProfileId: 'p1', services });
    await enqueueCycleClose({ task: triggerTask(), strategyProfileId: 'p1', services });
    await enqueueCycleClose({ task: triggerTask(), strategyProfileId: 'p1', services });
    const rows = await services.researchTasks.listByCorrelationAndTypes('corr-1', ['revision.build']);
    expect(rows).toHaveLength(1);
  });

  it('is fail-soft: an enqueue-time infra failure does NOT throw and appends revision.build_trigger_failed (Task-5 Medium fix — the primitive itself is fail-soft, so every call site is uniformly safe)', async () => {
    const services = makeServices();
    services.researchTasks.findByDedupeKey = async () => {
      throw new Error('db down');
    };
    const task = triggerTask({ id: 'trigger-task-1' });

    await expect(
      enqueueCycleClose({ task, strategyProfileId: 'p1', services }),
    ).resolves.toBeUndefined();

    const events = await services.events.listByTask('trigger-task-1');
    expect(events.map((e) => e.type)).toContain('revision.build_trigger_failed');
    expect(events.find((e) => e.type === 'revision.build_trigger_failed')?.payload).toMatchObject({
      error: 'db down',
    });

    // And no revision.build row/enqueue leaked through despite the throw.
    const rows = await services.researchTasks.listByCorrelationAndTypes('corr-1', ['revision.build']);
    expect(rows).toHaveLength(0);
  });
});
