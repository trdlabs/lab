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
      expect(queue.queued).toHaveLength(0);
    });
  });

  describe('PASS', () => {
    it('emits hypothesis.passed event and does NOT enqueue new task', async () => {
      const queue = new InMemoryQueueAdapter();
      const s = makeServices({ taskQueue: queue });
      await backtestCompletedHandler(task({ ...BASE_PAYLOAD, decision: 'PASS' }), s);

      const events = await s.events.listByTask('task-bt-completed');
      expect(events.map((e) => e.type)).toContain('hypothesis.passed');
      expect(queue.queued).toHaveLength(0);
    });
  });

  describe('INCONCLUSIVE', () => {
    it('emits hypothesis.inconclusive and does NOT retry (insufficient data)', async () => {
      const queue = new InMemoryQueueAdapter();
      const s = makeServices({ taskQueue: queue });
      await backtestCompletedHandler(task({ ...BASE_PAYLOAD, decision: 'INCONCLUSIVE', reasons: ['insufficient_sample'] }), s);

      const events = await s.events.listByTask('task-bt-completed');
      expect(events.map((e) => e.type)).toContain('hypothesis.inconclusive');
      expect(queue.queued).toHaveLength(0);
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

      const enqueued = queue.queued;
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
      expect(queue.queued).toHaveLength(0);
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

      const enqueued = queue.queued;
      expect(enqueued).toHaveLength(1);
      const retryTask = await s.researchTasks.findById(enqueued[0]!.taskId);
      expect(retryTask!.payload).toMatchObject({
        cycleDepth: 2,
        feedback: { decision: 'MODIFY', reasons: ['drawdown_regression'] },
      });
    });

    it('stops retrying when cycleDepth >= MAX_CYCLE_DEPTH', async () => {
      const queue = new InMemoryQueueAdapter();
      const s = makeServices({ taskQueue: queue });
      await backtestCompletedHandler(
        task({ ...BASE_PAYLOAD, decision: 'MODIFY', cycleDepth: MAX_CYCLE_DEPTH }),
        s,
      );
      expect(queue.queued).toHaveLength(0);
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
});
