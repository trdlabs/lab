import { z } from 'zod';
import type { WorkflowHandler } from '../workflow-router.ts';
import type { AppServices } from '../app-services.ts';
import type { ResearchTask } from '../../domain/types.ts';
import { validateWithSchema } from '../../validation/validator.ts';
import { event, errMsg } from './backtest-support.ts';
import type { StrategyRevision } from '../../domain/strategy-revision.ts';
import { reconstructStrategyBundle } from '../../research/reconstruct-strategy-bundle.ts';
import { assembleStrategyBundle, type AssembledStrategyBundle } from '../../domain/strategy-bundle.ts';
import { validateStrategyBundle } from '../../validation/strategy-bundle-validator.ts';
import { evaluateConsolidation } from '../../validation/consolidation-evaluator.ts';
import { RESEARCH_RUN_METRICS } from '../../domain/platform-comparison.ts';
import type { StrategyManifestMeta } from '../../ports/strategy-builder.port.ts';
import type { BacktestMetricBlock } from '../../ports/platform-gateway.port.ts';
import type { RevisionRunResult } from '../../ports/strategy-revision-run-executor.ts';

export const RevisionConsolidatePayloadSchema = z.object({
  revisionId: z.string().min(1),
  strategyProfileId: z.string().min(1),
});

const now = (): string => new Date().toISOString();

/**
 * ACCEPT path stub — replaced by Task 9. Task 8's guard/reject tests never reach here (every
 * fixture either short-circuits earlier or is engineered to diverge at the parity gate); the
 * `retryable` test asserts it got PAST the parity gate precisely by observing this throw.
 */
async function acceptConsolidation(
  _task: ResearchTask,
  _services: AppServices,
  _ctx: { R: StrategyRevision; assembled: AssembledStrategyBundle; cleanRun: RevisionRunResult },
): Promise<void> {
  throw new Error('acceptConsolidation not implemented until Task 9');
}

/**
 * slice G3b Task 8 — `revision.consolidate` handler: guards, run-context source-of-truth,
 * parity (equivalence) gate, and fail-safe reject paths. FAIL-SAFE: every failure leaves the
 * stacked revision R accepted/source-of-truth, emits an event, and does NOT re-baseline.
 */
export const revisionConsolidateHandler: WorkflowHandler = async (task, services) => {
  const parsed = validateWithSchema(RevisionConsolidatePayloadSchema, task.payload);
  if (parsed.status === 'invalid') throw new Error(`invalid revision.consolidate payload: ${JSON.stringify(parsed.issues)}`);
  const { revisionId, strategyProfileId } = parsed.data;
  const reject = async (reason: string, extra: Record<string, unknown> = {}) => {
    await services.events.append(event(task.id, 'revision.consolidation_rejected', { fromRevisionId: revisionId, reason, ...extra }));
  };

  // Idempotency (retryable fail-safe): no-op only if R is already consolidated.
  if (await services.revisions.findConsolidatedOf(revisionId)) {
    await services.events.append(event(task.id, 'revision.consolidation_skipped', { revisionId, reason: 'already_consolidated' }));
    return;
  }
  const R = await services.revisions.findById(revisionId);
  if (!R || R.status !== 'accepted' || (R.kind ?? 'composed') !== 'composed' || !R.bundleArtifactRef) {
    await services.events.append(event(task.id, 'revision.consolidation_skipped', { revisionId, reason: 'not_consolidatable' }));
    return;
  }
  // Run-context = the ACTUAL combo run's platformRun (source of truth; no default fallback).
  if (!R.comboBacktestRunId || !R.metrics) { await reject('missing_run_context'); return; }
  const comboRun = await services.strategyBacktests.findById(R.comboBacktestRunId);
  const ctx = comboRun?.platformRun ?? null;
  if (!comboRun || !ctx) { await reject('missing_run_context'); return; }

  const stacked = await reconstructStrategyBundle(services.artifacts, R.bundleArtifactRef);
  if (!services.consolidator) { await reject('consolidator_disabled'); return; }
  let out;
  try {
    out = await services.consolidator.consolidate({
      stackedSource: stacked.source, manifestMeta: stacked.manifest as StrategyManifestMeta,
      mergedRuleSet: R.mergedRuleSet, theses: (R.mergedRuleSet as { theses?: Record<string, string> }).theses,
    });
  } catch (err) { await reject('consolidator_error', { detail: errMsg(err) }); return; }

  const assembled = await assembleStrategyBundle(out);
  if (validateStrategyBundle(assembled).status === 'rejected') { await reject('bundle_invalid'); return; }

  const cleanRun = await services.revisionRunExecutor.execute({
    revisionId: R.id, label: 'consolidation', strategyBundle: assembled, strategyProfileId,
    run: ctx, metrics: [...RESEARCH_RUN_METRICS], correlationId: task.correlationId,
  });
  if (cleanRun.status !== 'completed' || !cleanRun.metrics) { await reject('consolidation_run_unavailable'); return; }

  const verdict = evaluateConsolidation(R.metrics as unknown as BacktestMetricBlock, cleanRun.metrics, services.consolidationTolerances);
  if (verdict.decision === 'REJECT') { await reject(verdict.reasons.join(','), { reasons: verdict.reasons, deltas: verdict.deltas }); return; }

  // ACCEPT path → Task 9 fills this in.
  await acceptConsolidation(task, services, { R, assembled, cleanRun });
};
