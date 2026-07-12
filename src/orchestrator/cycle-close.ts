import { createAndEnqueueTask } from './task-intake.ts';
import { event, errMsg } from './handlers/backtest-support.ts';
import type { AppServices } from './app-services.ts';
import type { ResearchTask } from '../domain/types.ts';

export const CYCLE_CHAIN_TYPES = ['hypothesis.build', 'backtest.completed', 'research.run_cycle'] as const;
/** Generous poll budget: 40 x 15s = 10min, well over ~23s/backtest. On exhaustion -> revision.build.abandoned. */
export const CYCLE_CLOSE_MAX_WAIT_ATTEMPTS = 40;
export const CYCLE_CLOSE_WAIT_DELAY_MS = 15_000;

type CycleServices = Pick<AppServices, 'researchTasks' | 'taskQueue' | 'events'>;

/**
 * Cycle-close trigger (P0-1/P0-2). Enqueues a single revision.build for the correlation with the
 * BASE dedupeKey — no terminality gate here: the enqueue is unconditional (which is what removes the
 * P0-1 zero-fire race), and revisionBuildHandler decides terminality later over settled statuses.
 * Called from every chain-member terminal exit (backtest.completed + hypothesis.build domain-terminal
 * returns).
 *
 * SCOPE of the terminality guarantee: it is authoritative only over settled CHAIN-TYPE rows
 * (isCycleChainTerminal, see below). It does NOT see an async backtest that is in-flight but has no
 * `backtest.completed` row yet (the resume/callback path routes through `backtest.resume`, which is
 * not a CYCLE_CHAIN_TYPE). On the async backtester path at concurrency >= 2 an early sibling trigger
 * can therefore observe an all-terminal chain prematurely and burn the base key — a pre-existing gap
 * (the old inline allTerminal check had it too), fine on the synchronous demo/mock path. Closing it
 * (submitted-BacktestRun awareness / backtest.resume in the chain) is a follow-up gating any raise of
 * LAB_QUEUE_CONCURRENCY on the async path. See TODO(P1-2) / spec §8.2.
 *
 * Fail-soft by construction: a trigger-enqueue failure must never fail the caller's handler (which
 * is terminating anyway). Both call sites (backtest.completed + hypothesis.build's 5 domain-terminal
 * exits) rely on this — an unwrapped throw here would fail the handler, retry it, and (as the last
 * chain member under persistent infra failure) silently orphan the cycle with no breadcrumb.
 */
export async function enqueueCycleClose(args: {
  task: ResearchTask; strategyProfileId: string; services: CycleServices;
}): Promise<void> {
  try {
    await createAndEnqueueTask(
      {
        taskType: 'revision.build', source: args.task.source,
        payload: { strategyProfileId: args.strategyProfileId, correlationId: args.task.correlationId },
        correlationId: args.task.correlationId,
        dedupeKey: `revision.build:${args.task.correlationId}`,
      },
      { repo: args.services.researchTasks, queue: args.services.taskQueue },
    );
  } catch (err) {
    await args.services.events.append(event(args.task.id, 'revision.build_trigger_failed', { error: errMsg(err) }));
  }
}

/**
 * Authoritative chain-terminality check. revision.build is NOT a chain type, so no exclude-self.
 * TODO(P1-2): 'queued' is treated as non-terminal (blocking) — an orphaned queued row will defer
 * the cycle until the abandon cap. Tolerating stale 'queued' older than a horizon is deferred to P1-2.
 */
export async function isCycleChainTerminal(correlationId: string, services: CycleServices): Promise<boolean> {
  const chain = await services.researchTasks.listByCorrelationAndTypes(correlationId, [...CYCLE_CHAIN_TYPES]);
  return chain.every((t) => t.status === 'completed' || t.status === 'failed' || t.status === 'rejected');
}
