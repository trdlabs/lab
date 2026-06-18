import type { AppServices } from '../app-services.ts';
import type { BacktestRun } from '../../domain/backtest-run.ts';
import { pollOverlayRun } from '../../research/run-backtest.ts';
import { event, errMsg, applyPlatformTerminalOutcome, enqueueBacktestCompleted } from './backtest-support.ts';

export type ResumeOutcome =
  | { kind: 'completed'; runId: string }
  | { kind: 'pending'; runId: string }
  | { kind: 'failed'; runId: string; reason: 'platform_rejected' | 'result_invalid' }
  | { kind: 'skipped'; runId: string; reason: 'not_resumable' | 'already_evaluated' | 'missing_task_id' | 'task_not_found' };

export interface ResumeProbeResult {
  total: number;
  outcomes: ResumeOutcome[];
  errors: { runId: string; error: string }[];
  counts: Record<string, number>;
}

/**
 * Continue ONE pending platform-backed run to terminal WITHOUT re-submitting.
 * Double idempotency guard (entry + pre-finalize): re-read run, Evaluation-exists check FIRST
 * (-> already_evaluated), then require status==='submitted' (-> not_resumable). The guards live
 * here so a future callback handed a stale run is safe. Reuses pollOverlayRun (no submit) and the
 * shared applyPlatformTerminalOutcome. Transport/Gateway errors throw (the caller isolates them).
 */
export async function resumePlatformRun(services: AppServices, run: BacktestRun): Promise<ResumeOutcome> {
  const runId = run.id;

  // Guard #1 (entry).
  const fresh = await services.backtests.findById(runId);
  if (!fresh) return { kind: 'skipped', runId, reason: 'not_resumable' };
  if ((await services.evaluations.listByBacktestRun(runId)).length > 0) return { kind: 'skipped', runId, reason: 'already_evaluated' };
  if (fresh.status !== 'submitted') return { kind: 'skipped', runId, reason: 'not_resumable' };

  // Recover the originating task for event continuity.
  if (fresh.taskId === undefined) return { kind: 'skipped', runId, reason: 'missing_task_id' };
  const task = await services.researchTasks.findById(fresh.taskId);
  if (!task) return { kind: 'skipped', runId, reason: 'task_not_found' };

  await services.events.append(event(task.id, 'backtest.resume.started', { runId, platformRunId: fresh.platformRunId }));

  // Bounded re-poll — NO submit.
  const outcome = await pollOverlayRun(services.researchPlatform, fresh.platformRunId, services.platformPoll);
  if (outcome.status === 'pending') {
    await services.events.append(event(task.id, 'backtest.resume.pending', { runId, platformRunId: fresh.platformRunId }));
    return { kind: 'pending', runId };
  }

  // Guard #2 (immediately before the terminal transition).
  const again = await services.backtests.findById(runId);
  if (!again) return { kind: 'skipped', runId, reason: 'not_resumable' };
  if ((await services.evaluations.listByBacktestRun(runId)).length > 0) return { kind: 'skipped', runId, reason: 'already_evaluated' };
  if (again.status !== 'submitted') return { kind: 'skipped', runId, reason: 'not_resumable' };

  const result = await applyPlatformTerminalOutcome(services, task, { runId, hypothesisId: fresh.hypothesisId }, outcome);
  if (result.kind === 'completed') {
    await enqueueBacktestCompleted(services, task, {
      backtestRunId: runId,
      hypothesisId: fresh.hypothesisId,
      strategyProfileId: fresh.strategyProfileId,
      decision: result.decision,
      reasons: result.reasons,
      cycleDepth: typeof task.payload.cycleDepth === 'number' ? task.payload.cycleDepth : 0,
    });
    await services.events.append(event(task.id, 'backtest.resume.completed', { runId }));
    return { kind: 'completed', runId };
  }
  return { kind: 'failed', runId, reason: result.reason };
}

/**
 * Batch driver: enumerate resumable runs and resume each, isolating per-run errors so one
 * transport failure does not abort the sweep. Reused by the CLI now and a scheduler later.
 */
export async function resumePendingPlatformRuns(services: AppServices): Promise<ResumeProbeResult> {
  const runs = await services.backtests.listResumablePlatformRuns();
  const outcomes: ResumeOutcome[] = [];
  const errors: { runId: string; error: string }[] = [];
  for (const run of runs) {
    try {
      outcomes.push(await resumePlatformRun(services, run));
    } catch (err) {
      errors.push({ runId: run.id, error: errMsg(err) });
    }
  }
  const counts: Record<string, number> = {};
  for (const o of outcomes) counts[o.kind] = (counts[o.kind] ?? 0) + 1;
  if (errors.length > 0) counts.error = errors.length;
  return { total: runs.length, outcomes, errors, counts };
}
