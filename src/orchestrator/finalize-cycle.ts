// src/orchestrator/finalize-cycle.ts
import type { ResearchTaskRepository } from '../ports/research-task.repository.ts';
import type { TaskQueuePort } from '../ports/task-queue.port.ts';
import type { AgentEventRepository } from '../ports/agent-event.repository.ts';
import { createAndEnqueueTask } from './task-intake.ts';
import { event, errMsg } from './handlers/backtest-support.ts';
import { CYCLE_SCORECARD_SCHEMA_VERSION, type TerminalKind } from '../domain/cycle-scorecard.ts';

export interface FinalizeCycleOutcome {
  correlationId: string;
  strategyProfileId: string;
  sourceTaskId: string;
  terminalOutcome: { kind: TerminalKind; reason: string };
  revisionId?: string;
  eligibleHypIds?: string[];
  consideredHypIds?: string[];
}

export interface FinalizeCycleDeps {
  researchTasks: ResearchTaskRepository;
  taskQueue: TaskQueuePort;
  events: AgentEventRepository;
  now?: () => number;
}

/** Single terminal-close hook (mirrors enqueueCycleClose): enqueues one cycle.scorecard task per
 *  domain-terminal outcome. FAIL-SOFT — any failure is observable but never thrown, so the revision's
 *  domain decision is never re-played. Recovery caveat: createAndEnqueueTask does repo.create THEN
 *  queue.enqueue — the P1-1 boot sweeper reconciles an orphaned row ONLY IF repo.create already
 *  persisted the `queued` row (i.e. enqueue failed after create). A repo.create failure leaves no row,
 *  so the scorecard is simply absent (acceptable: the cycle stays terminal, no domain impact). Do NOT
 *  call on the deferred/self-requeue path. */
export async function finalizeCycle(args: { outcome: FinalizeCycleOutcome; deps: FinalizeCycleDeps }): Promise<void> {
  const { outcome, deps } = args;
  // Internal, system-triggered enqueue: unlike enqueueCycleClose (which propagates the triggering
  // task's own `source`), FinalizeCycleOutcome deliberately carries no task-source field — the
  // scorecard's dedupeKey/payload identity is keyed on correlationId alone. 'cron' is the
  // established TASK_SOURCES value used for internal/system-origin tasks.
  const source = 'cron';
  try {
    await createAndEnqueueTask(
      {
        taskType: 'cycle.scorecard',
        source,
        correlationId: outcome.correlationId,
        dedupeKey: `cycle.scorecard:${CYCLE_SCORECARD_SCHEMA_VERSION}:${outcome.correlationId}`,
        payload: outcome as unknown as Record<string, unknown>,
      },
      { repo: deps.researchTasks, queue: deps.taskQueue, now: deps.now },
    );
  } catch (err) {
    // FULLY fail-soft: the observability event is ALSO best-effort. If both enqueue AND event-append
    // throw, finalizeCycle must still resolve — otherwise the worker re-runs revision-build and
    // re-plays the already-committed domain decision.
    try {
      await deps.events.append(event(outcome.sourceTaskId, 'cycle.scorecard_enqueue_failed', {
        correlationId: outcome.correlationId, error: errMsg(err),
      }));
    } catch {
      // swallow — nothing left to do; the cycle stays terminal, scorecard simply absent until reconciled
    }
  }
}
