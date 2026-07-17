// src/orchestrator/handlers/backtest-completed.handler.test.ts
import { describe, it, expect } from 'vitest';
import { backtestCompletedHandler, MAX_CYCLE_DEPTH } from './backtest-completed.handler.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import { InMemoryQueueAdapter } from '../../adapters/queue/in-memory-queue.adapter.ts';
import { InMemoryTokenUsageRepository } from '../../adapters/repository/in-memory-token-usage.repository.ts';
import type { ResearchTask } from '../../domain/types.ts';
import type { HypothesisProposal } from '../../domain/hypothesis.ts';

function task(payload: Record<string, unknown>): ResearchTask {
  const now = '2026-01-01T00:00:00Z';
  return {
    id: 'task-bt-completed',
    taskType: 'backtest.completed',
    source: 'operator',
    correlationId: 'corr-1',
    status: 'running',
    payload,
    createdAt: now,
    updatedAt: now,
  };
}

function makeBacktestCompletedTask(opts: { decision: string; cycleDepth: number }): ResearchTask {
  return task({ ...BASE_PAYLOAD, decision: opts.decision, cycleDepth: opts.cycleDepth });
}

const BASE_PAYLOAD = {
  backtestRunId: 'bt-run-1',
  hypothesisId: 'hyp-1',
  strategyProfileId: 'profile-1',
  reasons: ['strong_robust_edge'],
  cycleDepth: 0,
};

function hyp(id: string, status: 'validated' | 'rejected' = 'validated'): HypothesisProposal {
  return {
    id, strategyProfileId: 'profile-1', thesis: 't', targetBehavior: 'b',
    ruleAction: { appliesTo: 'long', rules: [{ when: 'w', action: 'no_op', params: {} }] },
    requiredFeatures: ['oi'], validationPlan: 'p', expectedEffect: { metric: 'win_rate', direction: 'increase' },
    invalidationCriteria: ['x'], confidence: 0.5, status, fingerprint: 'sha256:' + id,
    proposal: {} as never, issues: [], contractVersion: 'hypothesis-proposal-v1',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('backtestCompletedHandler', () => {
  describe('PAPER_CANDIDATE', () => {
    it('emits hypothesis.paper_candidate event and does NOT enqueue new task', async () => {
      const queue = new InMemoryQueueAdapter();
      const s = makeServices({ taskQueue: queue });
      await backtestCompletedHandler(task({ ...BASE_PAYLOAD, decision: 'PAPER_CANDIDATE' }), s);

      const events = await s.events.listByTask('task-bt-completed');
      expect(events.map((e) => e.type)).toContain('hypothesis.paper_candidate');
      // No research.run_cycle retry — the cycle-completion trigger (this being the sole
      // correlated task) legitimately enqueues a revision.build; see the dedicated
      // 'cycle-completion trigger' describe block below.
      expect(queue.queued.filter((q) => q.taskType === 'research.run_cycle')).toHaveLength(0);
    });
  });

  describe('PASS', () => {
    it('emits hypothesis.passed event and does NOT enqueue new task', async () => {
      const queue = new InMemoryQueueAdapter();
      const s = makeServices({ taskQueue: queue });
      await backtestCompletedHandler(task({ ...BASE_PAYLOAD, decision: 'PASS' }), s);

      const events = await s.events.listByTask('task-bt-completed');
      expect(events.map((e) => e.type)).toContain('hypothesis.passed');
      expect(queue.queued.filter((q) => q.taskType === 'research.run_cycle')).toHaveLength(0);
    });
  });

  describe('INCONCLUSIVE', () => {
    it('emits hypothesis.inconclusive and does NOT retry (insufficient data)', async () => {
      const queue = new InMemoryQueueAdapter();
      const s = makeServices({ taskQueue: queue });
      await backtestCompletedHandler(task({ ...BASE_PAYLOAD, decision: 'INCONCLUSIVE', reasons: ['insufficient_sample'] }), s);

      const events = await s.events.listByTask('task-bt-completed');
      expect(events.map((e) => e.type)).toContain('hypothesis.inconclusive');
      expect(queue.queued.filter((q) => q.taskType === 'research.run_cycle')).toHaveLength(0);
    });
  });

  describe('FAIL', () => {
    it('emits hypothesis.failed + enqueues research.run_cycle retry when cycleDepth < MAX_CYCLE_DEPTH', async () => {
      const queue = new InMemoryQueueAdapter();
      const s = makeServices({ taskQueue: queue });
      await backtestCompletedHandler(
        task({ ...BASE_PAYLOAD, decision: 'FAIL', reasons: ['no_improvement_over_baseline'], cycleDepth: 0 }),
        s,
      );

      const events = await s.events.listByTask('task-bt-completed');
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain('hypothesis.failed');
      expect(eventTypes).toContain('research.retry_enqueued');

      const enqueued = queue.queued.filter((q) => q.taskType === 'research.run_cycle');
      expect(enqueued).toHaveLength(1);
      const first = enqueued[0]!;
      expect(first.taskType).toBe('research.run_cycle');

      const retryTask = await s.researchTasks.findById(first.taskId);
      expect(retryTask).not.toBeNull();
      expect(retryTask!.payload).toMatchObject({
        strategyProfileId: 'profile-1',
        cycleDepth: 1,
        feedback: { hypothesisId: 'hyp-1', decision: 'FAIL' },
      });
      // Back-compat: BASE_PAYLOAD carries no `symbol` (older in-flight task shape) — retry
      // payload must omit it too, not crash and not synthesize a value.
      expect(retryTask!.payload).not.toHaveProperty('symbol');
    });

    it('threads the originating symbol into the retry payload when present on backtest.completed', async () => {
      const queue = new InMemoryQueueAdapter();
      const s = makeServices({ taskQueue: queue });
      await backtestCompletedHandler(
        task({ ...BASE_PAYLOAD, decision: 'FAIL', reasons: ['no_improvement_over_baseline'], cycleDepth: 0, symbol: 'ETHUSDT' }),
        s,
      );

      const enqueued = queue.queued.filter((q) => q.taskType === 'research.run_cycle');
      expect(enqueued).toHaveLength(1);
      const retryTask = await s.researchTasks.findById(enqueued[0]!.taskId);
      expect(retryTask!.payload).toMatchObject({ symbol: 'ETHUSDT' });
    });

    it('does NOT retry when cycleDepth >= MAX_CYCLE_DEPTH and emits budget_exhausted event', async () => {
      const queue = new InMemoryQueueAdapter();
      const s = makeServices({ taskQueue: queue });
      await backtestCompletedHandler(
        task({ ...BASE_PAYLOAD, decision: 'FAIL', cycleDepth: MAX_CYCLE_DEPTH }),
        s,
      );

      const events = await s.events.listByTask('task-bt-completed');
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain('hypothesis.failed');
      expect(eventTypes).toContain('research.retry_budget_exhausted');
      expect(queue.queued.filter((q) => q.taskType === 'research.run_cycle')).toHaveLength(0);
    });
  });

  describe('MODIFY', () => {
    it('emits hypothesis.modify_required + enqueues research.run_cycle with feedback', async () => {
      const queue = new InMemoryQueueAdapter();
      const s = makeServices({ taskQueue: queue });
      await backtestCompletedHandler(
        task({ ...BASE_PAYLOAD, decision: 'MODIFY', reasons: ['drawdown_regression'], cycleDepth: 1 }),
        s,
      );

      const events = await s.events.listByTask('task-bt-completed');
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain('hypothesis.modify_required');
      expect(eventTypes).toContain('research.retry_enqueued');

      const enqueued = queue.queued.filter((q) => q.taskType === 'research.run_cycle');
      expect(enqueued).toHaveLength(1);
      const retryTask = await s.researchTasks.findById(enqueued[0]!.taskId);
      expect(retryTask!.payload).toMatchObject({
        cycleDepth: 2,
        feedback: { decision: 'MODIFY', reasons: ['drawdown_regression'] },
      });
    });

    it('threads the originating symbol into the MODIFY retry payload when present', async () => {
      const queue = new InMemoryQueueAdapter();
      const s = makeServices({ taskQueue: queue });
      await backtestCompletedHandler(
        task({ ...BASE_PAYLOAD, decision: 'MODIFY', reasons: ['drawdown_regression'], cycleDepth: 1, symbol: 'ETHUSDT' }),
        s,
      );
      const enqueued = queue.queued.filter((q) => q.taskType === 'research.run_cycle');
      const retryTask = await s.researchTasks.findById(enqueued[0]!.taskId);
      expect(retryTask!.payload).toMatchObject({ symbol: 'ETHUSDT' });
    });

    it('stops retrying when cycleDepth >= MAX_CYCLE_DEPTH', async () => {
      const queue = new InMemoryQueueAdapter();
      const s = makeServices({ taskQueue: queue });
      await backtestCompletedHandler(
        task({ ...BASE_PAYLOAD, decision: 'MODIFY', cycleDepth: MAX_CYCLE_DEPTH }),
        s,
      );
      expect(queue.queued.filter((q) => q.taskType === 'research.run_cycle')).toHaveLength(0);
    });
  });

  it('throws on invalid payload', async () => {
    const s = makeServices();
    await expect(
      backtestCompletedHandler(task({ decision: 'UNKNOWN_DECISION' }), s),
    ).rejects.toThrow('invalid backtest.completed payload');
  });

  describe('token budget gate', () => {
    it('FAIL over the token budget does NOT retry and emits research.token_budget_exhausted', async () => {
      const tokenUsage = new InMemoryTokenUsageRepository();
      const t = makeBacktestCompletedTask({ decision: 'FAIL', cycleDepth: 0 });
      await tokenUsage.add(t.correlationId, 5000);
      const s = makeServices({ tokenUsage, researchTaskTokenBudget: 1000 });
      await backtestCompletedHandler(t, s);
      const types = (await s.events.listByTask(t.id)).map((e) => e.type);
      expect(types).toContain('research.token_budget_exhausted');
      expect(types).not.toContain('research.retry_enqueued');
    });

    it('FAIL under the token budget retries as before', async () => {
      const tokenUsage = new InMemoryTokenUsageRepository();
      const t = makeBacktestCompletedTask({ decision: 'FAIL', cycleDepth: 0 });
      await tokenUsage.add(t.correlationId, 100);
      const s = makeServices({ tokenUsage, researchTaskTokenBudget: 1000 });
      await backtestCompletedHandler(t, s);
      const types = (await s.events.listByTask(t.id)).map((e) => e.type);
      expect(types).toContain('research.retry_enqueued');
      expect(types).not.toContain('research.token_budget_exhausted');
    });

    it('budget 0 (unlimited) never token-gates', async () => {
      const tokenUsage = new InMemoryTokenUsageRepository();
      const t = makeBacktestCompletedTask({ decision: 'MODIFY', cycleDepth: 0 });
      await tokenUsage.add(t.correlationId, 9_999_999);
      const s = makeServices({ tokenUsage, researchTaskTokenBudget: 0 });
      await backtestCompletedHandler(t, s);
      const types = (await s.events.listByTask(t.id)).map((e) => e.type);
      expect(types).toContain('research.retry_enqueued');
      expect(types).not.toContain('research.token_budget_exhausted');
    });
  });

  describe('research.run_cost event', () => {
    it('emits research.run_cost with the chain cost at completion', async () => {
      const tokenUsage = new InMemoryTokenUsageRepository();
      const task = makeBacktestCompletedTask({ decision: 'PASS', cycleDepth: 0 });
      await tokenUsage.add(task.correlationId, 1500);
      await tokenUsage.addCost(task.correlationId, 0.025);
      const services = makeServices({ tokenUsage });
      await backtestCompletedHandler(task, services);
      const ev = (await services.events.listByTask(task.id)).find((e) => e.type === 'research.run_cost');
      expect(ev?.payload).toMatchObject({ correlationId: task.correlationId, costUsd: 0.025, totalTokens: 1500 });
    });
  });

  describe('backtest.result_ready terminal event', () => {
    it('emits backtest.result_ready as the final event for a PASS decision', async () => {
      const queue = new InMemoryQueueAdapter();
      const s = makeServices({ taskQueue: queue });
      await backtestCompletedHandler(task({ ...BASE_PAYLOAD, decision: 'PASS' }), s);

      const recordedEvents = await s.events.listByTask('task-bt-completed');

      // Additive guarantee: hypothesis.passed still emitted
      const types = recordedEvents.map((e) => e.type);
      expect(types).toContain('hypothesis.passed');

      // backtest.result_ready is the LAST event, with the remapped payload
      const last = recordedEvents[recordedEvents.length - 1]!;
      expect(last.type).toBe('backtest.result_ready');
      expect(last.payload).toEqual({
        decision: 'PASS',
        profileId: 'profile-1',
        hypothesisId: 'hyp-1',
        backtestRunId: 'bt-run-1',
      });
    });

    it('emits backtest.result_ready for a FAIL decision too', async () => {
      const queue = new InMemoryQueueAdapter();
      const s = makeServices({ taskQueue: queue });
      await backtestCompletedHandler(
        task({ ...BASE_PAYLOAD, decision: 'FAIL', reasons: ['no_improvement_over_baseline'], cycleDepth: 0 }),
        s,
      );

      const recordedEvents = await s.events.listByTask('task-bt-completed');
      const last = recordedEvents[recordedEvents.length - 1]!;
      expect(last.type).toBe('backtest.result_ready');
      expect(last.payload).toMatchObject({ decision: 'FAIL', profileId: 'profile-1' });
    });
  });

  describe('hypothesis proxy status update', () => {
    const DELTAS = { deltaNetPnlUsd: 111.5, deltaMaxDrawdownPct: -4.25 };

    it.each([
      ['PASS', 'proxy_passed'],
      ['PAPER_CANDIDATE', 'proxy_paper_candidate'],
      ['FAIL', 'proxy_failed'],
      ['MODIFY', 'proxy_failed'],
      ['INCONCLUSIVE', 'proxy_failed'],
    ] as const)('%s decision -> %s status + proxyMetrics on the proposal', async (decision, expectedStatus) => {
      const s = makeServices();
      await s.hypotheses.create(hyp('hyp-1'));
      await backtestCompletedHandler(task({ ...BASE_PAYLOAD, decision, ...DELTAS }), s);

      const updated = await s.hypotheses.findById('hyp-1');
      expect(updated?.status).toBe(expectedStatus);
      expect(updated?.proxyMetrics).toEqual({
        decision, backtestRunId: 'bt-run-1',
        deltaNetPnlUsd: DELTAS.deltaNetPnlUsd, deltaMaxDrawdownPct: DELTAS.deltaMaxDrawdownPct,
      });

      const types = (await s.events.listByTask('task-bt-completed')).map((e) => e.type);
      expect(types).not.toContain('hypothesis.status_update_failed');
      expect(types).not.toContain('proxy_deltas_missing');
    });

    it('missing hypothesis row: fails soft with hypothesis.status_update_failed, does NOT throw', async () => {
      const s = makeServices(); // no hypothesis row created for 'hyp-1'
      await expect(
        backtestCompletedHandler(task({ ...BASE_PAYLOAD, decision: 'PASS', ...DELTAS }), s),
      ).resolves.toBeUndefined();

      const types = (await s.events.listByTask('task-bt-completed')).map((e) => e.type);
      expect(types).toContain('hypothesis.status_update_failed');
      // still terminates normally
      expect(types).toContain('backtest.result_ready');
    });

    it('missing deltas: writes proxyMetrics with 0s and emits proxy_deltas_missing (fail-soft, older in-flight tasks)', async () => {
      const s = makeServices();
      await s.hypotheses.create(hyp('hyp-1'));
      await backtestCompletedHandler(task({ ...BASE_PAYLOAD, decision: 'PASS' }), s); // no deltas in payload

      const updated = await s.hypotheses.findById('hyp-1');
      expect(updated?.proxyMetrics).toEqual({
        decision: 'PASS', backtestRunId: 'bt-run-1', deltaNetPnlUsd: 0, deltaMaxDrawdownPct: 0,
      });

      const types = (await s.events.listByTask('task-bt-completed')).map((e) => e.type);
      expect(types).toContain('proxy_deltas_missing');
    });
  });

  describe('cycle-completion trigger', () => {
    it('enqueues revision.build once this is the sole (vacuously all-terminal) correlated task', async () => {
      const queue = new InMemoryQueueAdapter();
      const s = makeServices({ taskQueue: queue });
      await backtestCompletedHandler(task({ ...BASE_PAYLOAD, decision: 'PASS' }), s);

      const revisionTasks = queue.queued.filter((q) => q.taskType === 'revision.build');
      expect(revisionTasks).toHaveLength(1);
      expect(revisionTasks[0]!.dedupeKey).toBe('revision.build:corr-1');

      const created = await s.researchTasks.findById(revisionTasks[0]!.taskId);
      expect(created?.payload).toEqual({ strategyProfileId: 'profile-1', correlationId: 'corr-1' });
    });

    it('enqueues revision.build unconditionally even while a sibling hypothesis.build/backtest.completed task is still non-terminal (P0-1 fix: terminality is now revisionBuildHandler\'s self-gate, not this trigger)', async () => {
      const queue = new InMemoryQueueAdapter();
      const s = makeServices({ taskQueue: queue });
      const sibling: ResearchTask = {
        id: 'task-sibling', taskType: 'hypothesis.build', source: 'operator', correlationId: 'corr-1',
        status: 'running', payload: {}, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      };
      await s.researchTasks.create(sibling);
      await backtestCompletedHandler(task({ ...BASE_PAYLOAD, decision: 'PASS' }), s);

      expect(queue.queued.filter((q) => q.taskType === 'revision.build')).toHaveLength(1);
    });

    it('enqueues revision.build once the last sibling task turns terminal', async () => {
      const queue = new InMemoryQueueAdapter();
      const s = makeServices({ taskQueue: queue });
      const sibling: ResearchTask = {
        id: 'task-sibling', taskType: 'hypothesis.build', source: 'operator', correlationId: 'corr-1',
        status: 'completed', payload: {}, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      };
      await s.researchTasks.create(sibling);
      await backtestCompletedHandler(task({ ...BASE_PAYLOAD, decision: 'PASS' }), s);

      expect(queue.queued.filter((q) => q.taskType === 'revision.build')).toHaveLength(1);
    });

    it('P0-1: two concurrent last-finishers race with a still-non-terminal chain member — exactly one revision.build enqueued (base dedupeKey); zero-fire is impossible', async () => {
      const queue = new InMemoryQueueAdapter();
      const s = makeServices({ taskQueue: queue });
      // A chain member that never settles for the duration of this test. Under the OLD
      // allTerminal-gated trigger this would have permanently blocked the enqueue (zero-fire) —
      // the whole point of P0-1 is that the trigger no longer looks at this at all.
      const stillRunning: ResearchTask = {
        id: 'task-still-running', taskType: 'hypothesis.build', source: 'operator', correlationId: 'corr-1',
        status: 'running', payload: {}, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      };
      await s.researchTasks.create(stillRunning);

      const taskA = task({ ...BASE_PAYLOAD, hypothesisId: 'hyp-a', backtestRunId: 'bt-a', decision: 'PASS' });
      taskA.id = 'task-a';
      const taskB = task({ ...BASE_PAYLOAD, hypothesisId: 'hyp-b', backtestRunId: 'bt-b', decision: 'PASS' });
      taskB.id = 'task-b';

      // Simulate two concurrent last-finishers running their handlers (sequential here — the
      // in-memory repo's base-dedupeKey read-then-write is deterministic under sequential
      // invocation, which is the correct shape for proving the dedupe absorbs the second fire).
      await backtestCompletedHandler(taskA, s);
      await backtestCompletedHandler(taskB, s);

      const revisionTasks = queue.queued.filter((q) => q.taskType === 'revision.build');
      expect(revisionTasks).toHaveLength(1);
      expect(revisionTasks[0]!.dedupeKey).toBe('revision.build:corr-1');
    });

    it('two concurrent last-finishing backtest.completed tasks both trigger — dedupeKey absorbs into exactly one revision.build task', async () => {
      const queue = new InMemoryQueueAdapter();
      const s = makeServices({ taskQueue: queue });
      const taskA: ResearchTask = task({ ...BASE_PAYLOAD, hypothesisId: 'hyp-a', backtestRunId: 'bt-a', decision: 'PASS' });
      taskA.id = 'task-a';
      const taskB: ResearchTask = task({ ...BASE_PAYLOAD, hypothesisId: 'hyp-b', backtestRunId: 'bt-b', decision: 'PASS' });
      taskB.id = 'task-b';
      // Both are already-completed siblings of each other from the trigger's point of view —
      // register them up front so each invocation's listByCorrelationAndTypes sees the other as terminal.
      const registerAsCompleted = async (t: ResearchTask) => {
        await s.researchTasks.create({ ...t, status: 'completed' });
      };
      await registerAsCompleted(taskA);
      await registerAsCompleted(taskB);

      await backtestCompletedHandler(taskA, s);
      await backtestCompletedHandler(taskB, s);

      const revisionTasks = queue.queued.filter((q) => q.taskType === 'revision.build');
      expect(revisionTasks).toHaveLength(1);
    });

    it('trigger failure is fail-soft: emits revision.build_trigger_failed, does not throw', async () => {
      const s = makeServices();
      // enqueueCycleClose's first repo call is findByDedupeKey (inside createAndEnqueueTask) — this
      // handler no longer calls listByCorrelationAndTypes at all (that query moved to
      // revisionBuildHandler's self-gate), so the failure must be injected on the call this
      // trigger actually makes.
      s.researchTasks.findByDedupeKey = async () => {
        throw new Error('db down');
      };
      await expect(
        backtestCompletedHandler(task({ ...BASE_PAYLOAD, decision: 'PASS' }), s),
      ).resolves.toBeUndefined();

      const types = (await s.events.listByTask('task-bt-completed')).map((e) => e.type);
      expect(types).toContain('revision.build_trigger_failed');
      expect(types).toContain('backtest.result_ready'); // the task's own outcome is unaffected
    });

    // Regression (Finding 1), updated for P0-1: a FAIL/MODIFY decision enqueues a same-correlationId
    // retry (research.run_cycle). The OLD allTerminal-gated trigger had to see that retry as
    // non-terminal and suppress its own fire, or the retried cycle's hypotheses would never get a
    // revision pass. Under the new unconditional trigger, BOTH fire from this same invocation —
    // revision.build is no longer gated here at all; revisionBuildHandler's own self-gate
    // (isCycleChainTerminal) is what defers the build until the retry settles.
    it('last finisher decides FAIL within retry budget: retry AND revision.build are BOTH enqueued (revisionBuildHandler defers itself until the retry settles)', async () => {
      const queue = new InMemoryQueueAdapter();
      const s = makeServices({ taskQueue: queue });
      const sibling: ResearchTask = {
        id: 'task-sibling', taskType: 'hypothesis.build', source: 'operator', correlationId: 'corr-1',
        status: 'completed', payload: {}, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      };
      await s.researchTasks.create(sibling);

      await backtestCompletedHandler(
        task({ ...BASE_PAYLOAD, decision: 'FAIL', reasons: ['no_improvement_over_baseline'], cycleDepth: 0 }),
        s,
      );

      expect(queue.queued.filter((q) => q.taskType === 'research.run_cycle')).toHaveLength(1);
      expect(queue.queued.filter((q) => q.taskType === 'revision.build')).toHaveLength(1);
    });

    it('repeated invocations across the same correlationId (e.g. the retried cycle\'s own later backtest.completed) collapse to exactly one revision.build via the base dedupeKey', async () => {
      const queue = new InMemoryQueueAdapter();
      const s = makeServices({ taskQueue: queue });

      const firstTask = task({ ...BASE_PAYLOAD, decision: 'FAIL', reasons: ['no_improvement_over_baseline'], cycleDepth: 0 });
      // Register the finisher itself as completed up front (mirrors the 'two concurrent
      // last-finishing' test above) — irrelevant to the trigger now, kept for parity with the
      // repo state a real worker would have written by this point.
      await s.researchTasks.create({ ...firstTask, status: 'completed' });

      await backtestCompletedHandler(firstTask, s);

      const retryEnqueued = queue.queued.filter((q) => q.taskType === 'research.run_cycle');
      expect(retryEnqueued).toHaveLength(1);
      // The trigger already fired unconditionally on this first invocation.
      expect(queue.queued.filter((q) => q.taskType === 'revision.build')).toHaveLength(1);

      // Simulate the retried research.run_cycle running to completion.
      await s.researchTasks.updateStatus(retryEnqueued[0]!.taskId, 'completed');

      // The retried cycle's own backtest.completed fires next and decides PASS — same
      // correlationId, so its enqueueCycleClose call hits the same base dedupeKey and is absorbed.
      const secondTask = task({ ...BASE_PAYLOAD, decision: 'PASS', cycleDepth: 1 });
      secondTask.id = 'task-bt-completed-2';
      await backtestCompletedHandler(secondTask, s);

      const revisionTasks = queue.queued.filter((q) => q.taskType === 'revision.build');
      expect(revisionTasks).toHaveLength(1);
    });
  });

  describe('outcome embargo (S2)', () => {
    it('drops non-allowlisted reasons from the persisted retry feedback, fail-closed', async () => {
      const queue = new InMemoryQueueAdapter();
      const s = makeServices({ taskQueue: queue });
      await backtestCompletedHandler(
        task({
          ...BASE_PAYLOAD, decision: 'FAIL', cycleDepth: 0,
          reasons: ['no_improvement_over_baseline', 'holdout_failed: sharpe=1.23', 'heldout window 2031-12-31'],
        }),
        s,
      );
      const enqueued = queue.queued.filter((q) => q.taskType === 'research.run_cycle');
      expect(enqueued).toHaveLength(1);
      const retryTask = await s.researchTasks.findById(enqueued[0]!.taskId);
      const feedback = (retryTask!.payload as { feedback: { reasons: string[] } }).feedback;
      expect(feedback.reasons).toEqual(['no_improvement_over_baseline']);
      // durable: the embargoed strings must not exist ANYWHERE in the persisted payload
      expect(JSON.stringify(retryTask!.payload)).not.toContain('sharpe=1.23');
      expect(JSON.stringify(retryTask!.payload)).not.toContain('2031-12-31');
      // scrub evidence event, paths only
      const events = await s.events.listByTask('task-bt-completed');
      const scrub = events.filter((e) => e.type === 'outcome_embargo.scrubbed');
      expect(scrub).toHaveLength(1);
      expect(scrub[0]!.payload).toEqual({
        site: 'enqueueResearchRetry.feedback',
        removedKeys: ['reasons[1]', 'reasons[2]'],
      });
    });

    it('keeps evalPlatformRun (orchestration window) verbatim in the retry payload (I-E2)', async () => {
      const queue = new InMemoryQueueAdapter();
      const s = makeServices({ taskQueue: queue });
      const evalPlatformRun = {
        datasetId: 'ds-1', symbols: ['BTCUSDT'], timeframe: '1m', seed: 42,
        period: { from: '2026-06-22T00:00:00.000Z', to: '2026-06-28T00:00:00.000Z' },
      };
      await backtestCompletedHandler(
        task({ ...BASE_PAYLOAD, decision: 'MODIFY', cycleDepth: 0, reasons: ['drawdown_regression'], evalPlatformRun }),
        s,
      );
      const enqueued = queue.queued.filter((q) => q.taskType === 'research.run_cycle');
      const retryTask = await s.researchTasks.findById(enqueued[0]!.taskId);
      expect((retryTask!.payload as { evalPlatformRun: unknown }).evalPlatformRun).toEqual(evalPlatformRun);
      // no scrub event when nothing was dropped
      const events = await s.events.listByTask('task-bt-completed');
      expect(events.filter((e) => e.type === 'outcome_embargo.scrubbed')).toHaveLength(0);
    });
  });
});
