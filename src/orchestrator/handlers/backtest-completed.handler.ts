// src/orchestrator/handlers/backtest-completed.handler.ts
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { WorkflowHandler } from '../workflow-router.ts';
import { validateWithSchema } from '../../validation/validator.ts';
import { event, errMsg } from './backtest-support.ts';
import { enqueueCycleClose } from '../cycle-close.ts';
import type { ResearchTask } from '../../domain/types.ts';
import { withinTokenBudget } from '../token-budget.ts';
import type { HypothesisStatus, HypothesisProxyMetrics } from '../../domain/hypothesis.ts';
import { PlatformRunConfigSchema } from './platform-run-config.schema.ts';
import type { PlatformRunConfig } from '../../ports/research-platform.port.ts';
import { sanitizeRetryFeedback } from '../../research/outcome-embargo.ts';

export const BacktestCompletedPayloadSchema = z.object({
  backtestRunId: z.string().min(1),
  hypothesisId: z.string().min(1),
  strategyProfileId: z.string().min(1),
  decision: z.enum(['PASS', 'FAIL', 'MODIFY', 'INCONCLUSIVE', 'PAPER_CANDIDATE']),
  reasons: z.array(z.string()),
  /** Depth of the research→build→backtest cycle chain. Used to cap retries. */
  cycleDepth: z.number().int().min(0).default(0),
  /** Absent on older in-flight tasks enqueued before this field existed — fail-soft to 0s. */
  deltaNetPnlUsd: z.number().optional(),
  deltaMaxDrawdownPct: z.number().optional(),
  /** Originating symbol for this backtest run. Absent on older in-flight tasks enqueued before
   *  this field existed, or on non-symbol-scoped runs — retry falls back to the default symbol. */
  symbol: z.string().optional(),
  /** The eval window this run executed on; threaded into the retry cycle (R3b-1 §3.3). */
  evalPlatformRun: PlatformRunConfigSchema.optional(),
});

export type BacktestCompletedPayload = z.infer<typeof BacktestCompletedPayloadSchema>;

/**
 * Maps a backtest.completed evaluation decision to a PROXY status — a fast, cheap, single-fold
 * signal, NOT a validated/confirmed outcome. That stronger claim is earned only by a later
 * paper/live promotion, outside this slice.
 */
export function mapDecisionToProxyStatus(decision: BacktestCompletedPayload['decision']): HypothesisStatus {
  switch (decision) {
    case 'PASS': return 'proxy_passed';
    case 'PAPER_CANDIDATE': return 'proxy_paper_candidate';
    case 'FAIL':
    case 'MODIFY':
    case 'INCONCLUSIVE':
      return 'proxy_failed';
  }
}

/** Max number of automatic retry cycles (FAIL/MODIFY → new research.run_cycle). */
export const MAX_CYCLE_DEPTH = 2;

async function enqueueResearchRetry(
  task: ResearchTask,
  services: Parameters<WorkflowHandler>[1],
  strategyProfileId: string,
  feedback: { hypothesisId: string; decision: string; reasons: string[] },
  nextCycleDepth: number,
  symbol?: string,
  evalPlatformRun?: PlatformRunConfig,
): Promise<void> {
  // Outcome Embargo (S2, I-E5): fail-closed reason allowlist BEFORE the payload is written —
  // embargoed content must never persist into research_task.payload.feedback (it would be
  // replayed verbatim on every retry/requeue). Touches ONLY feedback; evalPlatformRun and
  // other control-plane fields are exempt by design (I-E2).
  const sanitized = sanitizeRetryFeedback(feedback);
  if (sanitized.removedKeys.length > 0) {
    await services.events.append(event(task.id, 'outcome_embargo.scrubbed', {
      site: 'enqueueResearchRetry.feedback', removedKeys: sanitized.removedKeys,
    }));
  }
  const retryTaskId = randomUUID();
  const retryTask: ResearchTask = {
    id: retryTaskId,
    taskType: 'research.run_cycle',
    source: task.source,
    correlationId: task.correlationId,
    status: 'queued',
    payload: {
      strategyProfileId, cycleDepth: nextCycleDepth, feedback: sanitized.feedback,
      ...(symbol ? { symbol } : {}),
      ...(evalPlatformRun ? { evalPlatformRun } : {}),
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await services.researchTasks.create(retryTask);
  await services.taskQueue.enqueue({
    taskId: retryTaskId,
    taskType: 'research.run_cycle',
    correlationId: task.correlationId,
    source: task.source,
    attempt: 1,
    dedupeKey: `research.run_cycle:retry:${feedback.hypothesisId}:depth${nextCycleDepth}`,
  });
}

/**
 * R12a: enqueue the log-only `hypothesis.holdout` confirmation task. Fail-soft — a throwing
 * researchTasks/taskQueue must NEVER fail the enclosing backtest.completed task (log-only, item 5a);
 * on failure it appends `hypothesis.holdout.enqueue_failed` and returns. dedupeKey collapses repeats
 * of the same (hypothesis, backtestRun) into exactly one holdout run.
 */
async function enqueueHypothesisHoldout(
  task: ResearchTask,
  services: Parameters<WorkflowHandler>[1],
  args: { hypothesisId: string; strategyProfileId: string; backtestRunId: string; evalPlatformRun?: PlatformRunConfig },
): Promise<void> {
  try {
    const holdoutTaskId = randomUUID();
    const holdoutTask: ResearchTask = {
      id: holdoutTaskId,
      taskType: 'hypothesis.holdout',
      source: task.source,
      correlationId: task.correlationId,
      status: 'queued',
      payload: {
        hypothesisId: args.hypothesisId,
        strategyProfileId: args.strategyProfileId,
        backtestRunId: args.backtestRunId,
        ...(args.evalPlatformRun ? { evalPlatformRun: args.evalPlatformRun } : {}),
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await services.researchTasks.create(holdoutTask);
    await services.taskQueue.enqueue({
      taskId: holdoutTaskId,
      taskType: 'hypothesis.holdout',
      correlationId: task.correlationId,
      source: task.source,
      attempt: 1,
      dedupeKey: `hypothesis.holdout:${args.hypothesisId}:${args.backtestRunId}`,
    });
  } catch (err) {
    await services.events.append(event(task.id, 'hypothesis.holdout.enqueue_failed', {
      hypothesisId: args.hypothesisId, backtestRunId: args.backtestRunId, error: errMsg(err),
    }));
  }
}

export const backtestCompletedHandler: WorkflowHandler = async (task, services) => {
  const parsed = validateWithSchema(BacktestCompletedPayloadSchema, task.payload);
  if (parsed.status === 'invalid') {
    throw new Error(`invalid backtest.completed payload: ${JSON.stringify(parsed.issues)}`);
  }
  const {
    backtestRunId, hypothesisId, strategyProfileId, decision, reasons, cycleDepth,
    deltaNetPnlUsd, deltaMaxDrawdownPct, symbol, evalPlatformRun,
  } = parsed.data;

  const cumulativeTokens = await services.tokenUsage.get(task.correlationId);
  const withinBudget = withinTokenBudget(cumulativeTokens, services.researchTaskTokenBudget);

  switch (decision) {
    case 'PAPER_CANDIDATE': {
      await services.events.append(event(task.id, 'hypothesis.paper_candidate', {
        backtestRunId, hypothesisId, reasons,
      }));
      // R12a (research-validation-hardening item 5a): behind LAB_HYPOTHESIS_HOLDOUT=log, enqueue a
      // lightweight, LOG-ONLY holdout confirmation of this proxy PAPER_CANDIDATE. Mode 'off'
      // (default) enqueues nothing — the branch stays byte-identical to today. Never gates status.
      if (services.hypothesisHoldoutMode === 'log') {
        await enqueueHypothesisHoldout(task, services, {
          hypothesisId, strategyProfileId, backtestRunId, evalPlatformRun,
        });
      }
      break;
    }

    case 'PASS': {
      await services.events.append(event(task.id, 'hypothesis.passed', {
        backtestRunId, hypothesisId, reasons,
      }));
      break;
    }

    case 'FAIL': {
      await services.events.append(event(task.id, 'hypothesis.failed', {
        backtestRunId, hypothesisId, reasons, cycleDepth,
        willRetry: cycleDepth < MAX_CYCLE_DEPTH && withinBudget,
      }));
      if (cycleDepth < MAX_CYCLE_DEPTH && withinBudget) {
        await enqueueResearchRetry(task, services, strategyProfileId,
          { hypothesisId, decision, reasons }, cycleDepth + 1, symbol, evalPlatformRun);
        await services.events.append(event(task.id, 'research.retry_enqueued', {
          strategyProfileId, cycleDepth: cycleDepth + 1, trigger: decision,
        }));
      } else if (!withinBudget) {
        await services.events.append(event(task.id, 'research.token_budget_exhausted', {
          strategyProfileId, cumulativeTokens, budgetTokens: services.researchTaskTokenBudget,
        }));
      } else {
        await services.events.append(event(task.id, 'research.retry_budget_exhausted', {
          strategyProfileId, cycleDepth, maxCycleDepth: MAX_CYCLE_DEPTH,
        }));
      }
      break;
    }

    case 'MODIFY': {
      await services.events.append(event(task.id, 'hypothesis.modify_required', {
        backtestRunId, hypothesisId, reasons, cycleDepth,
        willRetry: cycleDepth < MAX_CYCLE_DEPTH && withinBudget,
      }));
      if (cycleDepth < MAX_CYCLE_DEPTH && withinBudget) {
        await enqueueResearchRetry(task, services, strategyProfileId,
          { hypothesisId, decision, reasons }, cycleDepth + 1, symbol, evalPlatformRun);
        await services.events.append(event(task.id, 'research.retry_enqueued', {
          strategyProfileId, cycleDepth: cycleDepth + 1, trigger: decision,
        }));
      } else if (!withinBudget) {
        await services.events.append(event(task.id, 'research.token_budget_exhausted', {
          strategyProfileId, cumulativeTokens, budgetTokens: services.researchTaskTokenBudget,
        }));
      } else {
        await services.events.append(event(task.id, 'research.retry_budget_exhausted', {
          strategyProfileId, cycleDepth, maxCycleDepth: MAX_CYCLE_DEPTH,
        }));
      }
      break;
    }

    case 'INCONCLUSIVE': {
      // Insufficient data — don't auto-retry (would likely produce the same result).
      await services.events.append(event(task.id, 'hypothesis.inconclusive', {
        backtestRunId, hypothesisId, reasons, cycleDepth,
      }));
      break;
    }
  }

  // PROXY status bookkeeping: a fast, cheap, single-fold signal, NOT a validated/confirmed
  // outcome. Fail-soft — a bookkeeping problem here must not fail the task.
  const deltasMissing = deltaNetPnlUsd === undefined || deltaMaxDrawdownPct === undefined;
  if (deltasMissing) {
    await services.events.append(event(task.id, 'proxy_deltas_missing', { backtestRunId, hypothesisId }));
  }
  const proxyMetrics: HypothesisProxyMetrics = {
    decision, backtestRunId,
    deltaNetPnlUsd: deltaNetPnlUsd ?? 0,
    deltaMaxDrawdownPct: deltaMaxDrawdownPct ?? 0,
  };
  try {
    await services.hypotheses.updateStatus(hypothesisId, mapDecisionToProxyStatus(decision), proxyMetrics);
  } catch (err) {
    await services.events.append(event(task.id, 'hypothesis.status_update_failed', {
      hypothesisId, error: errMsg(err),
    }));
  }

  await services.events.append(event(task.id, 'research.run_cost', {
    correlationId: task.correlationId,
    costUsd: await services.tokenUsage.getCost(task.correlationId),
    totalTokens: await services.tokenUsage.get(task.correlationId),
  }));

  await services.events.append(event(task.id, 'backtest.result_ready', {
    decision,
    profileId: strategyProfileId,
    hypothesisId,
    backtestRunId,
  }));

  // Cycle-completion trigger (fail-soft, P0-1/P0-2): enqueue the cycle-close unconditionally.
  // revisionBuildHandler re-checks chain terminality over settled statuses and self-requeues if not
  // yet done — this is race-free where the old inline allTerminal check (excluding only self, before
  // the worker writes 'completed') zero-fired at concurrency >= 2. enqueueCycleClose is fail-soft
  // internally (P0-1/P0-2 fix-wave) — no outer try/catch needed here.
  await enqueueCycleClose({ task, strategyProfileId, services });
};
