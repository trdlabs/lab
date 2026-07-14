import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { WorkflowHandler } from '../workflow-router.ts';
import type { AppServices } from '../app-services.ts';
import type { ResearchTask } from '../../domain/types.ts';
import { validateWithSchema } from '../../validation/validator.ts';
import { event, errMsg } from './backtest-support.ts';
import { createAndEnqueueTask } from '../task-intake.ts';
import { makeOnUsage } from '../make-on-usage.ts';
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
 * The single idempotent baseline-enqueue path for this handler. Enqueues a ready-bundle
 * strategy.baseline for `revision` under `dedupeKey`, unless a task already exists for that key
 * (then it neither re-enqueues nor touches revision status — never rolls a completed baseline back
 * to 'pending'). Returns whether it deduped.
 */
async function ensureBaselineForRevision(
  task: ResearchTask,
  services: AppServices,
  revision: StrategyRevision,
  dedupeKey: string,
): Promise<boolean> {
  if (!revision.bundleArtifactRef) {
    throw new Error(`ensureBaselineForRevision: revision ${revision.id} has no bundleArtifactRef`);
  }
  const existing = await services.researchTasks.findByDedupeKey(dedupeKey);
  if (existing) return true;
  await services.revisions.updateStatus(revision.id, { baselineValidationStatus: 'pending', updatedAt: now() });
  await createAndEnqueueTask(
    {
      taskType: 'strategy.baseline', source: task.source,
      payload: { strategyProfileId: revision.strategyProfileId, bundleArtifactRef: revision.bundleArtifactRef, revisionId: revision.id },
      correlationId: task.correlationId, dedupeKey,
    },
    { repo: services.researchTasks, queue: services.taskQueue },
  );
  return false;
}

/**
 * ACCEPT path (slice G3b Task 9) — strict-parity success: materialize an equivalent,
 * depth-reset `kind:'consolidated'` revision from R and enqueue a ready-bundle
 * `strategy.baseline` re-baseline. hypothesisIds/mergedRuleSet are inherited VERBATIM from R
 * (no recompute) — R.dropped hypotheses are never rescued into the consolidated revision.
 */
async function acceptConsolidation(
  task: ResearchTask,
  services: AppServices,
  { R, assembled, cleanRun }: { R: StrategyRevision; assembled: AssembledStrategyBundle; cleanRun: RevisionRunResult },
): Promise<void> {
  const cleanRef = await services.artifacts.put(
    JSON.stringify({ source: assembled.source, manifest: assembled.manifest, bundleHash: assembled.bundleHash }),
    { kind: 'strategy_bundle', mime_type: 'application/json', producer: 'revision-consolidate-handler' },
  );
  const newId = randomUUID();
  const consolidated: StrategyRevision = {
    id: newId, strategyProfileId: R.strategyProfileId, version: R.version + 1,
    baseRevisionId: R.id, kind: 'consolidated', consolidatedFromRevisionId: R.id, semanticParentRevisionId: R.id,
    hypothesisIds: [...R.hypothesisIds], mergedRuleSet: R.mergedRuleSet,
    bundleArtifactRef: cleanRef, bundleHash: assembled.bundleHash,
    comboBacktestRunId: cleanRun.runId, metrics: cleanRun.metrics as unknown as Record<string, unknown>,
    compositionDepth: 1, status: 'accepted', baselineValidationStatus: 'pending',
    verdictReason: 'consolidated_parity_ok', createdAt: now(), updatedAt: now(),
  };

  // UNIQUE(profileId, version) race guard: another concurrent consolidation already claimed
  // this version — fail-safe skip rather than overwrite/duplicate. R stays the source of truth.
  try {
    await services.revisions.create(consolidated);
  } catch (err) {
    await services.events.append(event(task.id, 'revision.consolidation_skipped', { revisionId: R.id, reason: 'concurrent_revision', detail: errMsg(err) }));
    return;
  }

  await services.events.append(event(task.id, 'revision.consolidated', {
    fromRevisionId: R.id, newRevisionId: newId, version: consolidated.version, bundleHash: assembled.bundleHash,
  }));

  await createAndEnqueueTask(
    {
      taskType: 'strategy.baseline', source: task.source,
      payload: { strategyProfileId: R.strategyProfileId, bundleArtifactRef: cleanRef, revisionId: newId },
      correlationId: task.correlationId, dedupeKey: `strategy.baseline:consolidated:${newId}`,
    },
    { repo: services.researchTasks, queue: services.taskQueue },
  );
}

/**
 * slice G3b Task 8 — `revision.consolidate` handler: guards, run-context source-of-truth,
 * parity (equivalence) gate, and fail-safe reject paths. FAIL-SAFE: every failure leaves the
 * stacked revision R accepted/source-of-truth, emits an event, and (R1 #1) re-baselines R
 * directly via `ensureBaselineForRevision` so R is never stranded out of the paper loop.
 */
export const revisionConsolidateHandler: WorkflowHandler = async (task, services) => {
  const parsed = validateWithSchema(RevisionConsolidatePayloadSchema, task.payload);
  if (parsed.status === 'invalid') throw new Error(`invalid revision.consolidate payload: ${JSON.stringify(parsed.issues)}`);
  const { revisionId, strategyProfileId } = parsed.data;

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
  // Defined after the not_consolidatable guard so it closes over the validated, non-null R.
  const reject = async (reason: string, extra: Record<string, unknown> = {}): Promise<void> => {
    await services.events.append(event(task.id, 'revision.consolidation_rejected', { fromRevisionId: R.id, reason, ...extra }));
    // R1 #1: a terminal consolidation failure must still return R to paper. Re-baseline R directly
    // (ready-bundle), identical to revision-build's non-consolidation branch. Reusing the
    // accepted:${R.id} dedupeKey is a safety-net against ever double-baselining R.
    const deduped = await ensureBaselineForRevision(task, services, R, `strategy.baseline:accepted:${R.id}`);
    await services.events.append(event(task.id, 'revision.reject_rebaselined', { revisionId: R.id, reason, deduped }));
  };
  // Run-context = the ACTUAL combo run's platformRun (source of truth; no default fallback).
  if (!R.comboBacktestRunId || !R.metrics) { await reject('missing_run_context'); return; }
  const comboRun = await services.strategyBacktests.findById(R.comboBacktestRunId);
  const ctx = comboRun?.platformRun ?? null;
  if (!comboRun || !ctx) { await reject('missing_run_context'); return; }

  let stacked;
  try {
    stacked = await reconstructStrategyBundle(services.artifacts, R.bundleArtifactRef);
  } catch (err) { await reject('reconstruct_failed', { detail: errMsg(err) }); return; }
  if (!services.consolidator) { await reject('consolidator_disabled'); return; }
  let out;
  try {
    out = await services.consolidator.consolidate({
      stackedSource: stacked.source, manifestMeta: stacked.manifest as StrategyManifestMeta,
      mergedRuleSet: R.mergedRuleSet, theses: (R.mergedRuleSet as { theses?: Record<string, string> }).theses,
    }, makeOnUsage(task, services));
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

  // ACCEPT path (Task 9): materialize the consolidated revision + re-baseline.
  await acceptConsolidation(task, services, { R, assembled, cleanRun });
};
