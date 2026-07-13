import { createHash, randomUUID } from 'node:crypto';
import type { AppServices } from '../app-services.ts';
import type { ResearchTask, QueueEnvelope } from '../../domain/types.ts';
import type { PlatformRunOutcome } from '../../research/run-backtest.ts';
import { mapPlatformComparison, MetricMappingError } from '../../domain/platform-comparison.ts';
import type { AgentEvent } from '../../ports/agent-event.repository.ts';
import type { ComparisonSummary } from '../../ports/platform-gateway.port.ts';
import type { BacktestCompletion } from '../../domain/backtest-run.ts';
import type { Evaluation } from '../../domain/evaluation.ts';
import type { PlatformRunConfig, Ref } from '../../ports/research-platform.port.ts';
import { evaluateBacktest } from '../../validation/evaluator.ts';
import type { EvaluationDecision } from '../../validation/evaluator.ts';
import { applyBacktestPreservationGate } from '../../validation/apply-preservation-gate.ts';
import type { PreservationMetadata } from '../../validation/trade-preservation.ts';

export function event(taskId: string, type: string, payload: Record<string, unknown>): AgentEvent {
  return { id: randomUUID(), taskId, type, payload, createdAt: new Date().toISOString() };
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function sha256(input: string): string {
  // Byte-identical to the legacy SP-4 handler hash: `sha256:` prefix + utf8 input.
  return `sha256:${createHash('sha256').update(input, 'utf8').digest('hex')}`;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** Identity hash for research_platform runs. */
export function computeParamsHash(
  params: Record<string, unknown>,
  ctx: { platformRun: PlatformRunConfig; baselineRef: Ref },
): string {
  const { platformRun, baselineRef } = ctx;
  return sha256(stableStringify({
    backend: 'research_platform',
    params,
    baseline: { id: baselineRef.id, version: baselineRef.version },
    platformRun: {
      datasetId: platformRun.datasetId,
      symbols: [...platformRun.symbols].sort(),
      timeframe: platformRun.timeframe,
      period: { from: platformRun.period.from, to: platformRun.period.to },
      seed: platformRun.seed,
    },
  }));
}

export interface BacktestCompletionResult {
  decision: EvaluationDecision;
  reasons: string[];
  deltaNetPnlUsd: number;
  deltaMaxDrawdownPct: number;
}

/** Shared completion + evaluation tail (extracted verbatim from the SP-4 path). */
export async function finalizeBacktestCompletion(
  services: AppServices,
  task: ResearchTask,
  args: { runId: string; hypothesisId: string; platformRunId: string; comparison: ComparisonSummary; artifactRefs: string[] },
): Promise<BacktestCompletionResult> {
  const now = () => new Date().toISOString();
  const c = args.comparison;
  const completion: BacktestCompletion = {
    metrics: c.variant, baselineMetrics: c.baseline,
    deltaNetPnlUsd: c.variant.netPnlUsd - c.baseline.netPnlUsd,
    deltaMaxDrawdownPct: c.variant.maxDrawdownPct - c.baseline.maxDrawdownPct,
    isFragile: c.variant.topTradeContributionPct >= services.evaluatorThresholds.fragilityTopTradePct,
    artifactRefs: args.artifactRefs, platformContractVersion: c.platformContractVersion, finishedAt: now(),
  };
  await services.backtests.markCompleted(args.runId, completion);
  await services.events.append(event(task.id, 'backtest.completed', { runId: args.runId, deltaNetPnlUsd: completion.deltaNetPnlUsd }));

  const outcome = evaluateBacktest(c, services.evaluatorThresholds);

  let finalDecision = outcome.decision;
  let finalReasons = outcome.reasons;
  let preservationGate: PreservationMetadata | undefined;
  if (services.preservationGateEnabled && (outcome.decision === 'PASS' || outcome.decision === 'PAPER_CANDIDATE')) {
    try {
      const baselineTrades = await services.runTrades.getBaselineRunTrades(args.platformRunId);
      if (baselineTrades === null) {
        await services.events.append(event(task.id, 'evaluation.preservation_skipped', { runId: args.runId, reason: 'artifact_unavailable' }));
      } else {
        const variantTrades = await services.runTrades.getRunTrades(args.platformRunId);
        const gated = applyBacktestPreservationGate(
          outcome, baselineTrades, variantTrades,
          { baseline: { netPnlUsd: c.baseline.netPnlUsd, totalTrades: c.baseline.totalTrades },
            variant: { netPnlUsd: c.variant.netPnlUsd, totalTrades: c.variant.totalTrades } },
          services.preservationThresholds,
        );
        finalDecision = gated.outcome.decision;
        finalReasons = gated.outcome.reasons;
        if (gated.preservation) preservationGate = gated.preservation;
      }
    } catch (err) {
      await services.events.append(event(task.id, 'evaluation.preservation_skipped', { runId: args.runId, reason: 'fetch_failed', detail: errMsg(err) }));
    }
  }

  const evaluation: Evaluation = {
    id: randomUUID(), backtestRunId: args.runId, hypothesisId: args.hypothesisId,
    decision: finalDecision, reasons: finalReasons, metricsSnapshot: c,
    thresholds: services.evaluatorThresholds, createdAt: now(),
    ...(preservationGate !== undefined ? { preservationGate } : {}),
  };
  await services.evaluations.create(evaluation);
  await services.backtests.markEvaluated(args.runId);
  await services.events.append(event(task.id, 'evaluation.completed', { runId: args.runId, decision: finalDecision, reasons: finalReasons }));
  return {
    decision: finalDecision, reasons: finalReasons,
    deltaNetPnlUsd: completion.deltaNetPnlUsd, deltaMaxDrawdownPct: completion.deltaMaxDrawdownPct,
  };
}

/** Enqueue a backtest.completed task so the router can act on the evaluation outcome. */
export async function enqueueBacktestCompleted(
  services: AppServices,
  task: ResearchTask,
  args: {
    backtestRunId: string;
    hypothesisId: string;
    strategyProfileId: string;
    decision: EvaluationDecision;
    reasons: string[];
    cycleDepth: number;
    deltaNetPnlUsd?: number;
    deltaMaxDrawdownPct?: number;
    /** Originating symbol for this run — threaded through so a retry `research.run_cycle`
     *  researches the same instrument instead of falling back to the default. */
    symbol?: string;
    /** The Cycle-2 eval window this run executed on (BacktestRun.platformRun), threaded so a
     *  retry researches the SAME window (R3b-1 §3.3). Absent on runs before this field existed. */
    evalPlatformRun?: PlatformRunConfig;
  },
): Promise<void> {
  const completedTaskId = randomUUID();
  const completedTask: ResearchTask = {
    id: completedTaskId,
    taskType: 'backtest.completed',
    source: task.source,
    correlationId: task.correlationId,
    status: 'queued',
    payload: args,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await services.researchTasks.create(completedTask);
  const envelope: QueueEnvelope = {
    taskId: completedTaskId,
    taskType: 'backtest.completed',
    correlationId: task.correlationId,
    source: task.source,
    attempt: 1,
    dedupeKey: `backtest.completed:${args.backtestRunId}`,
  };
  await services.taskQueue.enqueue(envelope);
}

export type PlatformTerminalResult =
  | { kind: 'completed'; decision: EvaluationDecision; reasons: string[]; deltaNetPnlUsd: number; deltaMaxDrawdownPct: number }
  | { kind: 'failed'; reason: 'platform_rejected' | 'result_invalid' };

/**
 * Maps a TERMINAL platform outcome (rejected | completed) to persistence + canonical events,
 * delegating the completion tail to finalizeBacktestCompletion. Pending is handled by the caller
 * (each path emits its own pending event). Shared by the submit path (runPlatformBacktest) and the
 * resume path (resumePlatformRun) so outcome->Evaluation lives in exactly one place.
 */
export async function applyPlatformTerminalOutcome(
  services: AppServices,
  task: ResearchTask,
  args: { runId: string; hypothesisId: string; platformRunId: string },
  outcome: Exclude<PlatformRunOutcome, { status: 'pending' }>,
): Promise<PlatformTerminalResult> {
  const { runId, hypothesisId, platformRunId } = args;
  if (outcome.status === 'rejected') {
    await services.backtests.markRejected(runId);
    await services.events.append(event(task.id, 'backtest.failed', {
      runId, reason: 'platform_rejected', ...(outcome.terminalCode !== undefined ? { terminalCode: outcome.terminalCode } : {}),
    }));
    return { kind: 'failed', reason: 'platform_rejected' };
  }
  // completed
  let comparison: ComparisonSummary;
  try {
    comparison = mapPlatformComparison(outcome.summary);
  } catch (err) {
    if (err instanceof MetricMappingError) {
      await services.backtests.markFailed(runId);
      await services.events.append(event(task.id, 'backtest.failed', { runId, reason: 'result_invalid', detail: 'metric_mapping_error', code: err.code }));
      return { kind: 'failed', reason: 'result_invalid' };
    }
    throw err;
  }
  const completion = await finalizeBacktestCompletion(services, task, { runId, hypothesisId, platformRunId, comparison, artifactRefs: [...outcome.artifactIds] });
  return {
    kind: 'completed', decision: completion.decision, reasons: completion.reasons,
    deltaNetPnlUsd: completion.deltaNetPnlUsd, deltaMaxDrawdownPct: completion.deltaMaxDrawdownPct,
  };
}
